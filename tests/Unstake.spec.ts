/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests read state they just made */
// The Float criterion's unstake paths against Hipo's real contracts: a deferred burn through a real bill
// (the notification arrives rounds later under another query_id), a real rollback, and a bounce produced by
// the real wallet. The treasury is driven into the needed state through its data, as the contract repo's own
// tests do (tests/Wallet.spec.ts there); its code then runs unchanged. The unstake happens at a boundary.
import '@ton/test-utils'
import { Dictionary, toNano } from '@ton/core'
import { BlockchainTransaction, createShardAccount } from '@ton/sandbox'
import { JackpotOp, newBounce } from '../wrappers/Jackpot'
import { ParticipationState, treasuryConfigToCell } from './hipo/Treasury'
import { walletConfigToCell } from './hipo/Wallet'
import { Env, balanceOf, expectChainSucceeded, expectSolvent, hgramOf, jackpotState, reward } from './jackpot/setup'
import { A0, fresh, put, setNow, toBoundary } from './jackpot/scenario'

const G = (n: string | number) => toNano(String(n))
const opOf = (tx: BlockchainTransaction) => {
    const s = tx.inMessage?.body.beginParse()
    return s != null && s.remainingBits >= 32 ? s.loadUint(32) : 0
}
const qidOf = (tx: BlockchainTransaction) => {
    const s = tx.inMessage!.body.beginParse()
    s.skip(32)
    return s.loadUintBig(64)
}

async function setTreasury(env: Env, opts: { balance?: bigint; participation?: ParticipationState }) {
    const c = await env.blockchain.getContract(env.hipo.treasury.address)
    if (c.accountState?.type !== 'active') throw new Error('no treasury')
    const state = await env.hipo.treasury.getTreasuryState()
    if (opts.participation != null) state.participations.set(1n, { state: opts.participation })
    await env.blockchain.setShardAccount(
        env.hipo.treasury.address,
        createShardAccount({
            workchain: 0,
            address: env.hipo.treasury.address,
            code: c.accountState.state.code!,
            data: treasuryConfigToCell(state),
            balance: opts.balance ?? c.balance,
        }),
    )
}

// A Jackpot with a low float and a pot at the stored rate; the boundary is the next poke, and it unstakes.
async function ready() {
    const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000'), float: G('7.5') })
    const { env, players } = sc
    await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
    await put(env, players[0], G('300'))
    await reward(env, G('400'))
    return sc
}

// The boundary: min_gap after the last one, the poke whose reply is the boundary.
const boundary = (env: Env) => toBoundary(env, 0n)

describe('Float: the unstake paths against Hipo’s real contracts', () => {
    it('a real rollback: Hipo refuses an unstake it cannot pay, the tokens return to the wallet but not to held_tokens', async () => {
        const { env } = await ready()
        await setTreasury(env, { balance: G('1') }) // no cash to burn at once, and no round to hold a bill
        const r = await boundary(env)
        expectChainSucceeded(r)
        const unstakeTx = r.transactions.find((t) => opOf(t) === JackpotOp.unstakeTokens)!
        const rollbackTx = r.transactions.find(
            (t) =>
                t.inMessage?.info.src?.toString() === env.hipo.parent.address.toString() &&
                t.inMessage.info.dest?.toString() === unstakeTx.inMessage!.info.dest?.toString(),
        )
        expect(rollbackTx).toBeDefined() // Hipo's rollback_unstake reached the wallet
        const s = await jackpotState(env)
        expect(s.unstakingTokens).toBeGreaterThan(0n)
        const u = s.unstakingTokens
        // the wallet got the tokens back, but held_tokens does not count them
        const walletAfter = await hgramOf(env, env.jackpot.address)
        expect(walletAfter - s.heldTokens).toBeGreaterThanOrEqual(u)
        await expectSolvent(env)
        // its only signal, a gas_excess, did not move the counter or held_tokens: it is ignored
        expect(
            r.transactions.some(
                (t) =>
                    opOf(t) === JackpotOp.gasExcess &&
                    t.inMessage?.info.dest?.toString() === env.jackpot.address.toString(),
            ),
        ).toBe(true)
        // the governor checks the wallet and settles: a stranger and an amount above the counter are refused
        const stranger = await env.blockchain.treasury('stranger')
        const denied = await env.jackpot.sendSettleUnstake(stranger.getSender(), { value: G('0.05'), amount: u })
        expect(denied.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: 103 })
        const over = await env.jackpot.sendSettleUnstake(env.governor.getSender(), { value: G('0.05'), amount: u + 1n })
        expect(over.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: 109 })
        expectChainSucceeded(await env.jackpot.sendSettleUnstake(env.governor.getSender(), { value: G('0.05'), amount: u }))
        const s1 = await jackpotState(env)
        expect(s1.unstakingTokens).toBe(0n)
        expect(s1.heldTokens).toBe(s.heldTokens + u)
        await expectSolvent(env)
    }, 300000)

    it('a real bill: the burn is deferred, the counter stays up, and rounds later the notification arrives under a foreign query_id and brings it to 0', async () => {
        const { env } = await ready()
        const cash = (await env.blockchain.getContract(env.hipo.treasury.address)).balance
        await setTreasury(env, { balance: G('1'), participation: ParticipationState.Staked })
        const r = await boundary(env)
        expectChainSucceeded(r)
        const unstakeTx = r.transactions.find((t) => opOf(t) === JackpotOp.unstakeTokens)!
        const unstakeQid = qidOf(unstakeTx)
        const s = await jackpotState(env)
        const u = s.unstakingTokens
        expect(u).toBeGreaterThan(0n)
        // a bill was minted: the treasury owes the tokens' value to a coming round
        expect((await env.hipo.treasury.getTreasuryState()).totalUnstaking).toBeGreaterThanOrEqual(u)
        expect(r.transactions.some((t) => opOf(t) === JackpotOp.withdrawalNotification)).toBe(false)
        // the round settles: the cash is back and the halter burns the round's bills, under its own query_id
        await setTreasury(env, { balance: cash, participation: ParticipationState.Burning })
        setNow(env, (env.blockchain.now ?? A0) + 2 * 65536)
        const floatBefore = await balanceOf(env, env.jackpot.address)
        const burn = await env.hipo.treasury.sendRetryBurnAll(env.hipo.halter.getSender(), {
            value: G('0.5'),
            roundSince: 1n,
            queryId: 987654321n,
        })
        const note = burn.transactions.find(
            (t) =>
                opOf(t) === JackpotOp.withdrawalNotification &&
                t.inMessage?.info.dest?.toString() === env.jackpot.address.toString(),
        )
        expect(note).toBeDefined()
        expect(qidOf(note!)).toBe(987654321n)
        expect(qidOf(note!)).not.toBe(unstakeQid)
        expect((await jackpotState(env)).unstakingTokens).toBe(0n)
        expect(await balanceOf(env, env.jackpot.address)).toBeGreaterThan(floatBefore)
        await expectSolvent(env)
    }, 300000)

    it('a bounce of unstake_tokens produced by the real wallet (it holds fewer tokens than held_tokens counts): held_tokens and the counter come back', async () => {
        const { env } = await ready()
        const wallet = (await env.jackpot.getAddresses()).wallet
        const w = await env.blockchain.getContract(wallet)
        if (w.accountState?.type !== 'active') throw new Error('no wallet')
        const heldBefore = (await jackpotState(env)).heldTokens
        // the wallet's data with its tokens taken away: its own check amount <= tokens then refuses the unstake
        await env.blockchain.setShardAccount(
            wallet,
            createShardAccount({
                workchain: 0,
                address: wallet,
                code: w.accountState.state.code!,
                data: walletConfigToCell({
                    owner: env.jackpot.address,
                    parent: env.hipo.parent.address,
                    tokens: 0n,
                    staking: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.BigVarUint(4)),
                    unstaking: 0n,
                }),
                balance: w.balance,
            }),
        )
        const r = await boundary(env)
        const unstake = r.transactions.find((t) => opOf(t) === JackpotOp.unstakeTokens)!
        expect(
            unstake.description.type === 'generic' &&
                unstake.description.computePhase.type === 'vm' &&
                unstake.description.computePhase.success,
        ).toBe(false)
        // the network's full-body bounce, because the Jackpot asked for it
        const bounce = r.transactions.find(
            (t) =>
                t.inMessage?.info.dest?.toString() === env.jackpot.address.toString() &&
                t.inMessage.info.src?.toString() === wallet.toString() &&
                opOf(t) === newBounce,
        )
        expect(bounce).toBeDefined()
        expect(r.externals.length).toBeGreaterThan(0)
        const s = await jackpotState(env)
        expect(s.unstakingTokens).toBe(0n) // the counter came back, and held_tokens with it
        expect(s.heldTokens).toBe(heldBefore)
    }, 300000)
})
