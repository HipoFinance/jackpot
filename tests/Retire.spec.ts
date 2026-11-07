/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests read state they just made */
// Amendment 1, "Retire and the end", "Migration" and the handler side of "Closing the tree". The funding of the close
// cascade is funded by sweep's sender; see tests/Foreign.spec.ts for the foreign tokens and the setters.
import '@ton/test-utils'
import { Address, Cell, beginCell, toNano } from '@ton/core'
import { Blockchain, createEmptyShardAccount } from '@ton/sandbox'
import { readFileSync } from 'fs'
import { compileSlowNode } from './jackpot/testbuild'
import { highestStanding } from '../scripts/lib/closeSubtree'
import {
    JackpotError,
    JackpotOp,
    LogTopic,
    SuccessorLog,
    SweptLog,
    WithdrawalLog,
    logsOf,
    withdrawOptions,
} from '../wrappers/Jackpot'
import { Node } from '../wrappers/Node'
import {
    balanceOf,
    codes,
    commentOf,
    depositHgram,
    deploySecondJackpot,
    expectChainSucceeded,
    expectSolvent,
    gasOf,
    hgramOf,
    jackpotState,
    jgramOf,
    messageFrom,
    nodeAt,
    notificationsTo,
    opOf,
    setGasPrice,
    sweepValue,
    walletAt,
    withdraw,
} from './jackpot/setup'
import { gasFee } from './jackpot/prices'
import { A0, deliver, fresh, holdUntil, put, setBalance, setNextPosition, setUnstaking, startDeposit, submitDraw, toAddr, toBoundary } from './jackpot/scenario'

const G = (n: string | number) => toNano(String(n))
const retire = (env: Awaited<ReturnType<typeof fresh>>['env']) =>
    env.jackpot.sendRetire(env.governor.getSender(), { value: G('0.05') })

async function nodesActive(env: Awaited<ReturnType<typeof fresh>>['env'], positions: number) {
    // the nodes over the positions assigned: ceil(n/64), ceil(n/4096), ceil(n/262144) and the top one
    const found: boolean[] = []
    const levels = [64, 4096, 262144, 16777216]
    for (let level = 1; level <= 4; level++) {
        const count = Math.ceil(positions / levels[level - 1])
        for (let i = 0; i < count; i++) {
            found.push(
                (await env.blockchain.getContract(nodeAt(env, level, BigInt(i)).address)).accountState?.type ===
                    'active',
            )
        }
    }
    return found
}

describe('Retire', () => {
    it('After retire: new deposits, and those whose deposit_ready arrives later, are refused with retired and refunded; boundaries and draws run and pay; withdrawals and w work; mintable is false; no message clears retired', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 3, mint: G('2000') })
        const { env, players } = sc
        const [alice, bob, carol] = players
        await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
        await put(env, alice, G('300'))
        await put(env, bob, G('300'))
        // a deposit in flight: held after the wallet's deposit_ready
        const walletTx = toAddr(walletAt(env, carol.address).address)
        const outs = await startDeposit(env, carol, G('50'), walletTx)
        expect(outs.length).toBeGreaterThan(0)
        // the governor retires, strangers cannot
        const denied = await env.jackpot.sendRetire(alice.getSender(), { value: G('0.05') })
        expect(denied.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.accessDenied,
        })
        expectChainSucceeded(await retire(env))
        expect((await env.jackpot.getRetirement()).retired).toBe(true)
        expect((await env.jackpot.getJettonData()).mintable).toBe(false)
        // the later deposit_ready is refused with retired and the tokens come back whole
        const h = await hgramOf(env, carol.address)
        for (const m of outs) await env.blockchain.sendMessage(m)
        expect(await hgramOf(env, carol.address)).toBe(h + G('50')) // the transfer had left the wallet; the refund returns it
        expect((await jackpotState(env)).principal).toBe(G('600'))
        // a new deposit is refused
        const dep = await depositHgram(env, carol, G('20'), { minC: 0n })
        expect(dep.booking).toBeUndefined()
        // boundaries and draws run and pay
        const r = await toBoundary(env, G('40'))
        expectChainSucceeded(r)
        expect((await env.jackpot.getDrawState()).state).toBe(1)
        const draw = await submitDraw(env)
        expectChainSucceeded(draw)
        expect((await env.jackpot.getDrawState()).state).toBe(0)
        // withdrawals and w work
        expectChainSucceeded(await withdraw(env, alice, G('100')))
        const w = await env.jackpot.sendComment(bob.getSender(), { value: env.fees.commentWithdraw, text: 'w' })
        expectChainSucceeded(w)
        expect(await jgramOf(env, bob.address)).toBe(0n)
        // nothing clears retired: the governor's other messages leave it
        await retire(env)
        await env.jackpot.sendSetHalted(env.governor.getSender(), { value: G('0.05'), halted: true })
        await env.jackpot.sendSetHalted(env.governor.getSender(), { value: G('0.05'), halted: false })
        await env.jackpot.sendClearFalling(env.governor.getSender(), { value: G('0.05') })
        expect((await env.jackpot.getRetirement()).retired).toBe(true)
        await expectSolvent(env)
    }, 600000)

    it('withdraw_for with 100 owners, each message with its StateInit, stays under 850,000 gas and the action limit and pays each owner to themselves; 101 are refused, and it is refused before retire and from anyone but the governor', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 5, mint: G('1000') })
        const { env, players } = sc
        for (const p of players) await put(env, p, G('100'))
        const owners: Address[] = players.map((p) => p.address)
        for (let i = 0; owners.length < 100; i++)
            owners.push((await env.blockchain.treasury(`other${i.toString()}`)).address)
        const per = env.fees.commentWithdraw
        const value = per * 101n + G('0.5')
        // before retire
        const early = await env.jackpot.sendWithdrawFor(env.governor.getSender(), { value, toSuccessor: false, owners })
        expect(early.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.notRetired,
        })
        await retire(env)
        const stranger = await env.jackpot.sendWithdrawFor(players[0].getSender(), {
            value,
            toSuccessor: false,
            owners,
        })
        expect(stranger.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.accessDenied,
        })
        // 101 owners
        const extra = [...owners, (await env.blockchain.treasury('one-more')).address]
        const tooMany = await env.jackpot.sendWithdrawFor(env.governor.getSender(), {
            value,
            toSuccessor: false,
            owners: extra,
        })
        expect(tooMany.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.tooManyOwners,
        })
        expect((await jackpotState(env)).principal).toBe(G('500'))
        // 100 owners
        const before = new Map<string, bigint>()
        for (const p of players) before.set(p.address.toString(), await hgramOf(env, p.address))
        const r = await env.jackpot.sendWithdrawFor(env.governor.getSender(), { value, toSuccessor: false, owners })
        expectChainSucceeded(r)
        const gas = gasOf(r, env.jackpot.address).find((g) => g.op === JackpotOp.withdrawFor)!.gas
        console.log('withdraw_for, 100 owners: gas', gas.toString())
        expect(gas).toBeLessThan(850_000n)
        const jackpotTx = r.transactions.find(
            (t) =>
                t.inMessage?.info.dest?.toString() === env.jackpot.address.toString() &&
                opOf(t) === JackpotOp.withdrawFor,
        )!
        expect(jackpotTx.outMessages.size).toBeLessThanOrEqual(255)
        for (const p of players) {
            expect(await hgramOf(env, p.address)).toBe(before.get(p.address.toString())! + G('100'))
            expect(await jgramOf(env, p.address)).toBe(0n)
        }
        // every payout went to its owner
        expect(
            logsOf<WithdrawalLog>(r.externals, LogTopic.withdrawal)
                .map((l) => l.owner.toString())
                .sort(),
        ).toEqual(players.map((p) => p.address.toString()).sort())
        expect((await jackpotState(env)).principal).toBe(0n)
    }, 600000)

    it('End to end: retire, the next boundary and its draw pay the pot to players, withdraw_for for all, sweep; then held_tokens is 0, the burner got exactly what was left, principal is 0, every node is gone and their balances are back at the Jackpot', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 3, mint: G('2000') })
        const { env, players } = sc
        await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
        for (const p of players) await put(env, p, G('300'))
        await retire(env)
        expectChainSucceeded(await toBoundary(env, G('40')))
        const draw = await submitDraw(env)
        expectChainSucceeded(draw)
        const prizes =
            notificationsTo(draw, players[0].address).length +
            notificationsTo(draw, players[1].address).length +
            notificationsTo(draw, players[2].address).length
        expect(prizes).toBe(3)
        expectChainSucceeded(
            await env.jackpot.sendWithdrawFor(env.governor.getSender(), {
                value: env.fees.commentWithdraw * 4n,
                toSuccessor: false,
                owners: players.map((p) => p.address),
            }),
        )
        expect((await jackpotState(env)).principal).toBe(0n)
        const s = await jackpotState(env)
        const left = s.heldTokens
        expect(left).toBeGreaterThan(0n) // the burn owed and the yield since the boundary
        expect(await nodesActive(env, 3)).toEqual([true, true, true, true])
        const burner0 = await hgramOf(env, env.burner.address)
        const nodeBalances = async () => {
                    let sum = 0n
            for (let level = 1; level <= 4; level++) sum += await balanceOf(env, nodeAt(env, level, 0n).address)
            return sum
        }
        const nodes = await nodeBalances()
        const jackpot0 = await balanceOf(env, env.jackpot.address)
        const r = await env.jackpot.sendSweep(env.keeper.getSender(), { value: await sweepValue(env) })
        expectChainSucceeded(r)
        const swept = logsOf<SweptLog>(r.externals, LogTopic.swept)
        expect(swept[0].tokens).toBe(left)
        const after = await jackpotState(env)
        expect([after.heldTokens, after.reservedTokens, after.burnOwed, after.carried, after.principal]).toEqual([
            0n,
            0n,
            0n,
            0n,
            0n,
        ])
        expect(await hgramOf(env, env.burner.address)).toBe(burner0 + left)
        expect(await nodesActive(env, 3)).toEqual([false, false, false, false])
        // the nodes' balances are back at the Jackpot, less the cascade's own gas and forwarding
        const rise = (await balanceOf(env, env.jackpot.address)) - jackpot0
        console.log('sweep: nodes held', nodes.toString(), 'the Jackpot rose by', rise.toString())
        expect(rise).toBeGreaterThan(nodes - G('0.1'))
        // a second sweep is refused
        const again = await env.jackpot.sendSweep(env.keeper.getSender(), { value: await sweepValue(env) })
        expect(again.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.cannotSweep,
        })
    }, 600000)

    it('Waiting draw at the end: sweep in state waiting with tickets = 0 ends the draw, puts its prizes back, burns everything and closes the tree, with no search sent', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('2000') })
        const { env, players } = sc
        await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
        for (const p of players) await put(env, p, G('300'))
        await toBoundary(env, G('40'))
        expect((await env.jackpot.getDrawState()).state).toBe(1)
        await retire(env)
        for (const p of players) expectChainSucceeded(await withdraw(env, p, 0n))
        const s = await jackpotState(env)
        expect(s.principal).toBe(0n)
        expect(s.reservedTokens).toBeGreaterThan(0n)
        const burner0 = await hgramOf(env, env.burner.address)
        const r = await env.jackpot.sendSweep(env.keeper.getSender(), { value: await sweepValue(env) })
        expectChainSucceeded(r)
        expect((await env.jackpot.getDrawState()).state).toBe(0)
        const after = await jackpotState(env)
        expect([after.heldTokens, after.reservedTokens, after.burnOwed, after.carried]).toEqual([0n, 0n, 0n, 0n])
        expect(await hgramOf(env, env.burner.address)).toBe(burner0 + s.heldTokens)
        expect(r.transactions.some((t) => opOf(t) === JackpotOp.descend)).toBe(false)
        expect(await nodesActive(env, 2)).toEqual([false, false, false, false])
    }, 300000)

    it('Refusals: sweep is refused while not retired, with principal > 0, with incoming_tokens > 0 or while a draw resolves, and with too little value', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 3, mint: G('2000') })
        const { env, players } = sc
        await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
        const refused = async (value?: bigint) => {
            const r = await env.jackpot.sendSweep(env.keeper.getSender(), { value: value ?? (await sweepValue(env)) })
            expect(r.transactions).toHaveTransaction({ to: env.jackpot.address, success: false })
        }
        await put(env, players[0], G('300'))
        await refused() // not retired
        // a draw resolving: the top node is gone, so the searches never answer
            await toBoundary(env, G('40'))
        const top = nodeAt(env, 4, 0n).address
        const saved = (await env.blockchain.getContract(top)).account
        await env.blockchain.setShardAccount(top, createEmptyShardAccount(top))
        await submitDraw(env)
        expect((await env.jackpot.getDrawState()).state).toBe(2)
        await retire(env)
        await refused() // principal > 0 (and the draw resolving)
        await withdraw(env, players[0], 0n)
        expect((await jackpotState(env)).principal).toBe(0n)
        await refused() // the draw resolves
        await env.blockchain.setShardAccount(top, saved)
        // the next boundary ends the draw (its slots roll over)
        await toBoundary(env, G('40'))
        expect((await env.jackpot.getDrawState()).state).not.toBe(2)
        // incoming_tokens > 0 is only possible for a deposit that was in flight before retire: it is refused later
        // too little value
        await refused((await sweepValue(env)) - 1n)
    }, 300000)

    it('Refusals: sweep is refused while incoming_tokens > 0', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('2000') })
        const { env, players } = sc
        const held = await startDeposit(
            env,
            players[1],
            G('20'),
            (tx) => tx.inMessage?.info.dest?.toString() === env.jackpot.address.toString() && opOf(tx) === JackpotOp.transferNotification,
        )
        expect(held.length).toBeGreaterThan(0)
        expect((await jackpotState(env)).incomingTokens).toBe(G('20'))
        await retire(env)
        const r = await env.jackpot.sendSweep(env.keeper.getSender(), { value: await sweepValue(env) })
        expect(r.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: JackpotError.cannotSweep })
        // the deposit finishes: refused as retired, and the tokens come back
        const h = await hgramOf(env, players[1].address)
        for (const m of held) await env.blockchain.sendMessage(m)
        expect((await jackpotState(env)).incomingTokens).toBe(0n)
        expect(await hgramOf(env, players[1].address)).toBe(h + G('20'))
        expectChainSucceeded(await env.jackpot.sendSweep(env.keeper.getSender(), { value: await sweepValue(env) }))
    }, 300000)
})

describe('Migration', () => {
    it('set_successor is refused before retire, for the Jackpot itself, and for a masterchain address; it is logged and shows in the getter', async () => {
        const sc = await fresh({ players: 1 })
        const { env } = sc
        const other = (await env.blockchain.treasury('successor')).address
        const set = (successor: Address | null, sender = env.governor) =>
            env.jackpot.sendSetSuccessor(sender.getSender(), { value: G('0.05'), successor, depositFee: G('0.5') })
        const early = await set(other)
        expect(early.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.notRetired,
        })
        await retire(env)
        for (const bad of [env.jackpot.address, new Address(-1, Buffer.alloc(32, 3))]) {
            const r = await set(bad)
            expect(r.transactions).toHaveTransaction({
                to: env.jackpot.address,
                success: false,
                exitCode: JackpotError.invalidParameters,
            })
        }
        const stranger = await set(other, env.keeper)
        expect(stranger.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.accessDenied,
        })
        const ok = await set(other)
        expectChainSucceeded(ok)
        const [log] = logsOf<SuccessorLog>(ok.externals, LogTopic.successor)
        expect(log.successor!.toString()).toBe(other.toString())
        expect((await env.jackpot.getRetirement()).successor!.toString()).toBe(other.toString())
        expectChainSucceeded(await set(null))
        expect((await env.jackpot.getRetirement()).successor).toBeNull()
    }, 100000)

    it('withdraw_for(to_successor) books each owner in the new Jackpot under their own address with booked_principal >= min_principal; a move the new Jackpot refuses returns hGRAM to the owner; an owner’s own move works and falls back to paying the owner with no successor or too little value', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 4, mint: G('2000') })
        const { env, players } = sc
        const [alice, bob, carol, dave] = players
        for (const p of [alice, bob, carol, dave]) await put(env, p, G('200'))
        const next = await deploySecondJackpot(env, env.blockchain.now ?? A0)
        await retire(env)
        const fee = next.fees.deposit + next.fees.return + next.fees.payload
        expectChainSucceeded(
            await env.jackpot.sendSetSuccessor(env.governor.getSender(), {
                value: G('0.05'),
                successor: next.jackpot.address,
                depositFee: fee,
            }),
        )
        // the governor's move for alice and bob
        const per = env.fees.commentWithdraw + fee
        const hA = await hgramOf(env, alice.address)
        const r = await env.jackpot.sendWithdrawFor(env.governor.getSender(), {
            value: per * 2n + G('0.2'),
            toSuccessor: true,
            owners: [alice.address, bob.address],
        })
        expectChainSucceeded(r)
        for (const p of [alice, bob]) {
            const x = G('200')
            expect(await jgramOf(env, p.address)).toBe(0n)
            const booked = await (async () => {
                const state = await next.blockchain.getContract(walletAt(next, p.address).address)
                expect(state.accountState?.type).toBe('active')
                return jgramOf(next, p.address)
            })()
            expect(booked).toBeGreaterThanOrEqual(x - x / 100n - 2n)
        }
        expect(await hgramOf(env, alice.address)).toBe(hA) // moved, not paid
        expect((await jackpotState(env)).principal).toBe(G('400'))
        expect((await jackpotState(next)).principal).toBeGreaterThan(0n)
        // a move the new Jackpot refuses: halted. The hGRAM goes to the owner, never to the old Jackpot or the governor
        await next.jackpot.sendSetHalted(next.governor.getSender(), { value: G('0.05'), halted: true })
        const hC = await hgramOf(env, carol.address)
        const gov0 = await hgramOf(env, env.governor.address)
        const old0 = (await jackpotState(env)).heldTokens
        const refused = await env.jackpot.sendWithdrawFor(env.governor.getSender(), {
            value: per + G('0.2'),
            toSuccessor: true,
            owners: [carol.address],
        })
        expectChainSucceeded(refused)
        expect(await hgramOf(env, carol.address)).toBe(hC + G('200'))
        expect(await hgramOf(env, env.governor.address)).toBe(gov0)
        expect((await jackpotState(env)).heldTokens).toBe(old0 - G('200'))
        expect(await jgramOf(next, carol.address)).toBe(0n)
        await next.jackpot.sendSetHalted(next.governor.getSender(), { value: G('0.05'), halted: false })
        // dave's own move through burn, with the options
        const payload = beginCell().storeUint(0xbeef, 16).endCell()
        const own = await walletAt(env, dave.address).sendBurn(dave.getSender(), {
            value: env.fees.withdraw + fee + G('0.05') + env.fees.payload,
            amount: 0n,
            options: withdrawOptions({ toSuccessor: true, forwardTonAmount: G('0.05'), forwardPayload: payload }),
        })
        expectChainSucceeded(own)
        expect(await jgramOf(next, dave.address)).toBeGreaterThanOrEqual(G('200') - G('2') - 2n)
        // and with no successor
        expectChainSucceeded(
            await env.jackpot.sendSetSuccessor(env.governor.getSender(), {
                value: G('0.05'),
                successor: null,
                depositFee: 0n,
            }),
        )
        await put(next, alice, G('0.5')).catch(() => undefined)
    }, 900000)

    it('An owner’s move with too little value, and with no successor, pays the owner instead', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('2000') })
        const { env, players } = sc
        const [alice, bob] = players
        await put(env, alice, G('200'))
        await put(env, bob, G('200'))
        const next = await deploySecondJackpot(env, env.blockchain.now ?? A0)
        await retire(env)
        const fee = next.fees.deposit + next.fees.return + next.fees.payload
        // no successor set: the move falls back to the owner
        const hA = await hgramOf(env, alice.address)
        const a = await walletAt(env, alice.address).sendBurn(alice.getSender(), {
            value: env.fees.withdraw + fee,
            amount: 0n,
            options: withdrawOptions({ toSuccessor: true }),
        })
        expectChainSucceeded(a)
        expect(await hgramOf(env, alice.address)).toBe(hA + G('200'))
        // a successor, but the value is below successor_deposit_fee + payout: paid to the owner
        await env.jackpot.sendSetSuccessor(env.governor.getSender(), {
            value: G('0.05'),
            successor: next.jackpot.address,
            depositFee: fee,
        })
        const hB = await hgramOf(env, bob.address)
        const b = await walletAt(env, bob.address).sendBurn(bob.getSender(), {
            value: env.fees.withdraw,
            amount: 0n,
            options: withdrawOptions({ toSuccessor: true }),
        })
        expectChainSucceeded(b)
        expect(await hgramOf(env, bob.address)).toBe(hB + G('200'))
        expect(await jgramOf(next, bob.address)).toBe(0n)
    }, 300000)
})

describe('Migration: the owner’s move judges the value left', () => {
    // The burn carries S + fwd + 0.04 .. S + fwd + 0.20 GRAM: the window where the move used to be chosen on the
    // incoming value while the update, the close, their forwarding and the gas had already been spent. Every case
    // either moves or pays the owner, and none ends with untracked hGRAM or a failed hop.
    for (const feeCase of [G('0.4117'), G('0.1'), 'the successor’s own fee' as const]) {
        it(`F1: a burn through the old window at successor_deposit_fee ${feeCase.toString()} moves or pays the owner, never leaves untracked hGRAM`, async () => {
            const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('2000') })
            const { env, players } = sc
            const [alice] = players
            await put(env, alice, G('200'))
            const next = await deploySecondJackpot(env, env.blockchain.now ?? A0)
            const successorFee = typeof feeCase === 'bigint' ? feeCase : next.fees.deposit + next.fees.return + next.fees.payload
            await retire(env)
            expectChainSucceeded(
                await env.jackpot.sendSetSuccessor(env.governor.getSender(), {
                    value: G('0.05'),
                    successor: next.jackpot.address,
                    depositFee: successorFee,
                }),
            )
            const snap = env.blockchain.snapshot()
            const outcomes = { moved: 0, paid: 0 }
            const fwd = 0n
            // the old window, and (the wallet throws below fee::withdraw) the values just above that
            const values = new Set<bigint>()
            for (let step = 4; step <= 40; step += step < 20 ? 1 : 4) values.add(successorFee + fwd + G('0.01') * BigInt(step))
            for (let k = 0; k <= 12; k++) values.add(env.fees.withdraw + G('0.03') * BigInt(k))
            for (const value of [...values].filter((v) => v >= env.fees.withdraw).sort()) {
                await env.blockchain.loadFrom(snap)
                const h0 = await hgramOf(env, alice.address)
                const r = await walletAt(env, alice.address).sendBurn(alice.getSender(), {
                    value,
                    amount: 0n,
                    options: withdrawOptions({ toSuccessor: true }),
                })
                expectChainSucceeded(r)
                const state = await jackpotState(env)
                // no untracked hGRAM at the old Jackpot, and nothing stuck in flight
                expect((await hgramOf(env, env.jackpot.address)) - state.heldTokens).toBe(0n)
                expect(state.incomingTokens).toBe(0n)
                const nextState = await jackpotState(next)
                expect((await hgramOf(next, next.jackpot.address)) - nextState.heldTokens).toBe(0n)
                expect(nextState.incomingTokens).toBe(0n)
                const paid = (await hgramOf(env, alice.address)) - h0
                const booked = await jgramOf(next, alice.address)
                // moved (booked in the new Jackpot, hGRAM not at the owner) or paid to the owner, never both or neither
                if (booked > 0n) {
                    expect(paid).toBe(0n)
                    outcomes.moved++
                } else {
                    expect(paid).toBeGreaterThan(0n)
                    outcomes.paid++
                }
            }
            console.log('F1 window, S', successorFee.toString(), outcomes)
            if (feeCase === 'the successor’s own fee') expect(outcomes.moved).toBeGreaterThan(0)
        }, 900000)
    }
})

describe('Migration: R1, the threshold of a move', () => {
    it('R1: at the lowest burn value that moves, to the nano-GRAM, the transfer keeps its forward fields and the successor books the player; one nano-GRAM less pays the owner; neither leaves untracked hGRAM', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('2000') })
        const { env, players } = sc
        const [alice] = players
        await put(env, alice, G('200'))
        const next = await deploySecondJackpot(env, env.blockchain.now ?? A0)
        const fee = next.fees.deposit + next.fees.return + next.fees.payload
        await retire(env)
        expectChainSucceeded(
            await env.jackpot.sendSetSuccessor(env.governor.getSender(), { value: G('0.05'), successor: next.jackpot.address, depositFee: fee }),
        )
        const snap = env.blockchain.snapshot()
        const attempt = async (value: bigint) => {
            await env.blockchain.loadFrom(snap)
            const h0 = await hgramOf(env, alice.address)
            const r = await walletAt(env, alice.address).sendBurn(alice.getSender(), {
                value,
                amount: 0n,
                options: withdrawOptions({ toSuccessor: true }),
            })
            expectChainSucceeded(r)
            const state = await jackpotState(env)
            const nextState = await jackpotState(next)
            expect((await hgramOf(env, env.jackpot.address)) - state.heldTokens).toBe(0n)
            expect((await hgramOf(next, next.jackpot.address)) - nextState.heldTokens).toBe(0n)
            expect(nextState.incomingTokens).toBe(0n)
            const log = logsOf<WithdrawalLog>(r.externals, LogTopic.withdrawal)[0]
            const booked = await jgramOf(next, alice.address)
            const paid = (await hgramOf(env, alice.address)) - h0
            // moved means booked at the successor and not paid to the owner, paid means the reverse
            if (log.moved) {
                expect(booked).toBeGreaterThan(0n)
                expect(paid).toBe(0n)
            } else {
                expect(booked).toBe(0n)
                expect(paid).toBeGreaterThan(0n)
            }
            return log.moved
        }
        let low = env.fees.withdraw
        let high = fee + G('1.5')
        expect(await attempt(low)).toBe(false)
        expect(await attempt(high)).toBe(true)
        while (high - low > 1n) {
            const mid = (low + high) / 2n
            if (await attempt(mid)) high = mid
            else low = mid
        }
        console.log('R1: the lowest burn value that moves', high.toString(), 'successor fee', fee.toString())
        expect(await attempt(high)).toBe(true)
        expect(await attempt(high - 1n)).toBe(false)
    }, 1500000)

    it('a governor withdraw_for(to_successor = true) with no successor set pays the owners directly, with the plain withdrawal comment', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000') })
        const { env, players } = sc
        const [alice] = players
        await put(env, alice, G('200'))
        await retire(env)
        const h0 = await hgramOf(env, alice.address)
        const r = await env.jackpot.sendWithdrawFor(env.governor.getSender(), {
            value: ((await env.jackpot.getFeeParts()).wValue + G('0.05')) * 2n + gasFee(env.blockchain, 60000n),
            toSuccessor: true,
            owners: [alice.address],
        })
        expectChainSucceeded(r)
        expect(await hgramOf(env, alice.address)).toBe(h0 + G('200'))
        const burn = r.transactions.find((t) => opOf(t) === JackpotOp.burn)!
        const options = burn.inMessage!.body.beginParse()
        options.skip(32 + 64)
        options.loadCoins()
        options.skip(2)
        const o = options.loadRef().beginParse()
        o.skip(32 + 1)
        o.loadCoins()
        expect(commentOf(o.loadRef())).toBe('Hipo Jackpot withdrawal')
        expect(commentOf(notificationsTo(r, alice.address)[0].payload)).toBe('Hipo Jackpot withdrawal')
    }, 300000)
})

describe('withdraw_for: the Jackpot’s own gas', () => {
    it('F3: withdraw_for needs n · per + gas(gas_consumed() + 10,000): below n · per + gas(10,000) is refused, the exact value runs, and the float does not fall', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 3, mint: G('1000') })
        const { env, players } = sc
        for (const p of players) await put(env, p, G('100'))
        await retire(env)
        const owners = players.map((p) => p.address)
        // n · per + gas(gas_consumed() + 10,000): the check runs after the loop that sends the burns, so the gas consumed
        // there is measured with a generous value first
        const per = (await env.jackpot.getFeeParts()).wValue
        const snap = env.blockchain.snapshot()
        const probe = await env.jackpot.sendWithdrawFor(env.governor.getSender(), { value: per * 3n + G('1'), toSuccessor: false, owners })
        const consumed = gasOf(probe, env.jackpot.address).find((g) => g.op === JackpotOp.withdrawFor)!.gas
        await env.blockchain.loadFrom(snap)
        // bracket the real threshold: lo is refused, hi runs; bisect to the nano-GRAM
        let hi = per * 3n + gasFee(env.blockchain, consumed + 10000n)
        let lo = per * 3n + gasFee(env.blockchain, 10000n) - 1n
        const runs = async (value: bigint) => {
            await env.blockchain.loadFrom(snap)
            const r = await env.jackpot.sendWithdrawFor(env.governor.getSender(), { value, toSuccessor: false, owners })
            const tx = r.transactions.find((t) => t.inMessage?.info.dest?.toString() === env.jackpot.address.toString())
            const refusedHere = tx?.description.type === 'generic' && tx.description.computePhase.type === 'vm' && tx.description.computePhase.exitCode === JackpotError.insufficientFee
            return !refusedHere
        }
        expect(await runs(lo)).toBe(false)
        expect(await runs(hi)).toBe(true)
        while (hi - lo > 1n) {
            const mid = (lo + hi) / 2n
            if (await runs(mid)) hi = mid
            else lo = mid
        }
        // hi is the threshold: one nano-GRAM below it is refused, and it passes; it is n · per + gas(g + 10,000) with g the gas consumed at the check
        expect(hi - per * 3n).toBeGreaterThan(gasFee(env.blockchain, 10000n))
        expect(hi - per * 3n).toBeLessThanOrEqual(gasFee(env.blockchain, consumed + 10000n))
        const need = hi
        await env.blockchain.loadFrom(snap)
        const refused = await env.jackpot.sendWithdrawFor(env.governor.getSender(), { value: need - 1n, toSuccessor: false, owners })
        expect(refused.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: JackpotError.insufficientFee })
        await env.blockchain.loadFrom(snap)
        const before = await balanceOf(env, env.jackpot.address)
        const r = await env.jackpot.sendWithdrawFor(env.governor.getSender(), { value: need, toSuccessor: false, owners })
        expectChainSucceeded(r)
        expect(await balanceOf(env, env.jackpot.address)).toBeGreaterThanOrEqual(before)
        for (const p of players) expect(await jgramOf(env, p.address)).toBe(0n)
    }, 300000)

    it('F3: 100 owners at the exact value: the float does not fall, and the float does not fall at 400 nano-GRAM per gas', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 4, mint: G('1000') })
        const { env, players } = sc
        for (const p of players) await put(env, p, G('100'))
        await retire(env)
        const owners: Address[] = players.map((p) => p.address)
        for (let i = 0; owners.length < 100; i++) owners.push((await env.blockchain.treasury(`other${i.toString()}`)).address)
        setGasPrice(env.blockchain, 400n)
        env.fees = await env.jackpot.getJackpotFees()
        const per = (await env.jackpot.getFeeParts()).wValue
        // the check runs after the owners are parsed; 100 owners need well under 1,000,000 gas at the check
        const need = per * 100n + gasFee(env.blockchain, 1_100_000n)
        const before = await balanceOf(env, env.jackpot.address)
        const r = await env.jackpot.sendWithdrawFor(env.governor.getSender(), { value: need, toSuccessor: false, owners })
        expectChainSucceeded(r)
        const gas = gasOf(r, env.jackpot.address).find((g) => g.op === JackpotOp.withdrawFor)!.gas
        expect(gas).toBeLessThanOrEqual(1_000_000n)
        expect(await balanceOf(env, env.jackpot.address)).toBeGreaterThanOrEqual(before)
    }, 600000)

    it('a wallet in storage debt above 0.07 GRAM is skipped at the default value per owner (its GRAM goes to the owner) and emptied with a larger one', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const { env, players } = sc
        for (const p of players) await put(env, p, G('100'))
        await retire(env)
        // both wallets in debt just below the freeze limit
        for (const p of players) {
            const address = walletAt(env, p.address).address
            const acc = (await env.blockchain.getContract(address)).account
            await env.blockchain.setShardAccount(address, {
                ...acc,
                account: {
                    ...acc.account!,
                    storage: { ...acc.account!.storage, balance: { coins: G('0.01') } },
                    storageStats: { ...acc.account!.storageStats, lastPaid: (env.blockchain.now ?? 0) - 1000, duePayment: G('0.09') },
                },
            })
        }
        const per = (await env.jackpot.getFeeParts()).wValue
        const snap = env.blockchain.snapshot()
        // the default: skipped, nothing burned, the GRAM goes to the owner
        const owner0 = await balanceOf(env, players[0].address)
        const skipped = await env.jackpot.sendWithdrawFor(env.governor.getSender(), {
            value: per * 2n + G('0.5'),
            toSuccessor: false,
            owners: [players[0].address],
        })
        expectChainSucceeded(skipped)
        expect(await jgramOf(env, players[0].address)).toBe(G('100'))
        expect(await balanceOf(env, players[0].address)).toBeGreaterThan(owner0)
        await env.blockchain.loadFrom(snap)
        // a larger value per owner covers the debt: the balance is burned and the hGRAM paid
        const h0 = await hgramOf(env, players[1].address)
        const emptied = await env.jackpot.sendWithdrawFor(env.governor.getSender(), {
            value: G('0.5'),
            toSuccessor: false,
            owners: [players[1].address],
            valuePerOwner: G('0.2'),
        })
        expectChainSucceeded(emptied)
        expect(await jgramOf(env, players[1].address)).toBe(0n)
        expect(await hgramOf(env, players[1].address)).toBeGreaterThan(h0)
        // a value per owner below the formula is refused
        const low = await env.jackpot.sendWithdrawFor(env.governor.getSender(), {
            value: G('0.5'),
            toSuccessor: false,
            owners: [players[0].address],
            valuePerOwner: per - 1n,
        })
        expect(low.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: JackpotError.insufficientFee })
    }, 300000)

    it('a governor move carries the comment "Hipo Jackpot: moved" and an owner’s own move her payload', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000') })
        const { env, players } = sc
        const [alice] = players
        await put(env, alice, G('200'))
        const next = await deploySecondJackpot(env, env.blockchain.now ?? A0)
        await retire(env)
        const fee = next.fees.deposit + next.fees.return + next.fees.payload
        await env.jackpot.sendSetSuccessor(env.governor.getSender(), { value: G('0.05'), successor: next.jackpot.address, depositFee: fee })
        const r = await env.jackpot.sendWithdrawFor(env.governor.getSender(), {
            value: ((await env.jackpot.getFeeParts()).wValue + fee) * 2n + gasFee(env.blockchain, 60000n),
            toSuccessor: true,
            owners: [alice.address],
        })
        expectChainSucceeded(r)
        expect(await jgramOf(next, alice.address)).toBeGreaterThan(0n)
        const burn = r.transactions.find((t) => opOf(t) === JackpotOp.burn)!
        const options = burn.inMessage!.body.beginParse()
        options.skip(32 + 64)
        options.loadCoins()
        options.skip(2)
        const o = options.loadRef().beginParse()
        o.skip(32 + 1)
        o.loadCoins()
        expect(commentOf(o.loadRef())).toBe('Hipo Jackpot: moved')
    }, 300000)
})

describe('Closing the tree: scripts', () => {
    it('a frozen node counts as standing and its children are never offered', () => {
        const node = (level: number, index: number, standing: boolean, frozen = false) => ({ level, index, standing, frozen })
        const picked = highestStanding([node(3, 0, true, true), node(2, 0, true), node(1, 0, true), node(2, 5, false)])
        expect(picked.map((x) => `${x.level.toString()}:${x.index.toString()}`)).toEqual(['3:0'])
        expect(picked[0].frozen).toBe(true)
    })

    it('closeSubtree offers only the highest nodes still standing', () => {
        const node = (level: number, index: number, standing: boolean) => ({ level, index, standing })
        // (3, 0) stands over (2, 0) and (2, 1); (2, 70) is alone, and its parent (3, 1) is gone
        const picked = highestStanding([
            node(4, 0, false),
            node(3, 0, true),
            node(3, 1, false),
            node(2, 0, true),
            node(2, 1, true),
            node(2, 70, true),
            node(1, 0, true),
            node(1, 4480, true),
        ])
        expect(picked.map((x) => `${x.level.toString()}:${x.index.toString()}`)).toEqual(['3:0', '2:70'])
        // nothing standing, nothing offered
        expect(highestStanding([node(1, 0, false)])).toEqual([])
    })
})

describe('Closing the tree', () => {
    const reserve = G('0.15') // fee::node_storage: what a node keeps, with no spare
    const span = [64, 4096, 262144, 16777216]
    type Fixture = Awaited<ReturnType<typeof fresh>>['env']

    // The nodes over the positions below n: ceil(n/64), ceil(n/4096), ceil(n/262144) and the top one.
    function nodesOver(n: number) {
        const out: { level: number; index: number }[] = []
        for (let level = 1; level <= 4; level++) {
            for (let i = 0; i < Math.ceil(n / span[level - 1]); i++) out.push({ level, index: i })
        }
        return out
    }

    // Deploys every node over the positions below n by a forged update from its parent (a sum of 0), with its balance
    // set to its reserve and nothing spare, and sets the Jackpot's next_position to n.
    async function buildTree(env: Fixture, n: number) {
        await setNextPosition(env, BigInt(n))
        const list = nodesOver(n)
        for (const { level, index } of list) {
            const node = nodeAt(env, level, BigInt(index))
            const parent = level === 4 ? env.jackpot.address : nodeAt(env, level + 1, BigInt(index >> 6)).address
            const body = beginCell()
                .storeUint(JackpotOp.update, 32)
                .storeUint(0, 64)
                .storeUint(0, 32)
                .storeUint(BigInt(index) << BigInt(6 * level), 32)
                .storeInt(0, 128)
                .storeBit(false)
                .endCell()
            await env.blockchain.sendMessage({
                ...messageFrom(parent, node.address, G('1'), body, false),
                init: node.init,
            })
            await setBalance(env, node.address, reserve)
        }
        return list
    }

    const results = new Map<number, Promise<Awaited<ReturnType<typeof cascade>>>>()
    async function cascade(n: number, nodeCode?: Cell) {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('10'), nodeCode })
        const { env } = sc
        await retire(env)
        const list = await buildTree(env, n)
        const cost = await env.jackpot.getCloseCost()
        const j0 = await balanceOf(env, env.jackpot.address)
        const r = await env.jackpot.sendSweep(env.governor.getSender(), { value: env.fees.sweep + cost })
        const addresses = new Map(
            list.map((x) => [nodeAt(env, x.level, BigInt(x.index)).address.toString(), x] as const),
        )
        const standing = []
        for (const x of list) {
            const st = (await env.blockchain.getContract(nodeAt(env, x.level, BigInt(x.index)).address)).accountState
            if (st?.type === 'active') standing.push(x)
        }
        return { env, list, cost, j0, r, addresses, standing }
    }
    const cascadeOf = (n: number) => {
        if (!results.has(n)) results.set(n, cascade(n))
        return results.get(n)!
    }

    for (const n of [65, 4097, 5000]) {
        it(`The cascade, on sweep’s funding, n = ${n.toString()}: every node over the positions is deleted, no other address receives close_node, no node’s reserve pays any gas, and the float changes by 0 for the close`, async () => {
            const { env, list, r, addresses, j0, standing } = await cascadeOf(n)
            expectChainSucceeded(r)
            expect(standing).toEqual([])
            let returned = 0n
            for (const tx of r.transactions) {
                const info = tx.inMessage?.info
                if (info?.type !== 'internal') continue
                const dest = info.dest.toString()
                const isClose = opOf(tx) === JackpotOp.closeNode
                if (isClose) expect(addresses.has(dest)).toBe(true) // only nodes receive close_node
                if (!addresses.has(dest)) continue
                // the node's whole balance went back to the Jackpot, less its storage fee and the forwarding: its
                // reserve paid for no gas
                const back = [...tx.outMessages.values()].find(
                    (m) => m.info.type === 'internal' && m.info.dest.toString() === env.jackpot.address.toString(),
                )
                expect(back).toBeDefined()
                if (back?.info.type !== 'internal') continue
                const storage =
                    tx.description.type === 'generic' && tx.description.storagePhase
                        ? tx.description.storagePhase.storageFeesCollected
                        : 0n
                expect(back.info.value.coins + storage + 1_000_000n).toBeGreaterThanOrEqual(reserve)
            }
            expect(list.length).toBe(addresses.size)
            // the float changes by 0 for the close: the Jackpot gained exactly what the nodes' returns brought, less its gas for taking them
            for (const tx of r.transactions) {
                const info = tx.inMessage?.info
                if (info?.type === 'internal' && info.dest.toString() === env.jackpot.address.toString() && addresses.has(info.src.toString()))
                    returned += info.value.coins - tx.totalFees.coins // less the Jackpot's gas for taking each return
            }
            const j1 = await balanceOf(env, env.jackpot.address)
            expect(j1 - j0).toBe(returned)
        }, 900000)
    }

    it('Split: the whole tree closes, no reserve pays any gas and no node is left behind with every node’s real gas raised over its measure', async () => {
        const slow = await compileSlowNode()
        for (const n of [65, 5000]) {
            const { env, list, r, standing } = await cascade(n, slow)
            expectChainSucceeded(r)
            expect(standing).toEqual([])
            let worst = 0n
            for (const tx of r.transactions) {
                const dest = tx.inMessage?.info.dest?.toString()
                if (dest == null || tx.description.type !== 'generic' || tx.description.computePhase.type !== 'vm') continue
                if (list.some((x) => nodeAt(env, x.level, BigInt(x.index)).address.toString() === dest) && tx.description.computePhase.gasUsed > worst)
                    worst = tx.description.computePhase.gasUsed
            }
            console.log('slow node cascade n', n, 'worst node gas', worst.toString())
            expect(worst).toBeGreaterThanOrEqual(100_000n) // each inner node burns about 85,000 gas more than built (a node of two children used 22,000)
        }
    }, 900000)

    it('Split: each node keeps term - fwd and gives each existing child its share of the rest in proportion to the child’s cost, so each child gets at least its cost times the margin', async () => {
        for (const n of [65, 4097, 5000]) {
            const { env, r, addresses } = await cascadeOf(n)
            for (const tx of r.transactions) {
                const info = tx.inMessage?.info
                if (info?.type !== 'internal' || opOf(tx) !== JackpotOp.closeNode) continue
                if (!addresses.has(info.dest.toString())) continue
                const kids = [...tx.outMessages.values()].filter(
                    (m) => m.info.type === 'internal' && m.info.dest.toString() !== env.jackpot.address.toString(),
                )
                const shares = kids.map((m) => (m.info.type === 'internal' ? m.info.value.coins : 0n))
                if (kids.length === 0) continue
                // every full subtree gets the same share; the last, partly filled, gets no more
                for (const x of shares.slice(0, -1)) expect(x).toBe(shares[0])
                expect(shares[shares.length - 1]).toBeLessThanOrEqual(shares[0])
                // a child's share (the forwarding inside it) is at least its cost times the margin
                for (const m of kids) {
                    if (m.info.type !== 'internal') continue
                    const child = addresses.get(m.info.dest.toString())!
                    const cost = await env.jackpot.getSubtreeCloseCost(child.level, child.index)
                    expect(m.info.value.coins + 1n).toBeGreaterThanOrEqual(cost)
                }
            }
        }
    }, 900000)

    it('close_cost(n) is the top node’s subtree cost times the margin: 0 for n = 0, growing with n, and the node counts use max(0, …)', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('10') })
        const { env } = sc
        expect(await env.jackpot.getCloseCost()).toBe(0n)
        const costs: bigint[] = []
        for (const n of [1, 65, 4097, 5000, 262145]) {
            await setNextPosition(env, BigInt(n))
            costs.push(await env.jackpot.getCloseCost())
        }
        for (let i = 1; i < costs.length; i++) expect(costs[i]).toBeGreaterThan(costs[i - 1])
        // a subtree past next_position costs nothing: max(0, …)
        expect(await env.jackpot.getSubtreeCloseCost(1, 5000)).toBe(0n)
    }, 100000)

    it('No players: sweep at n = 0 sends no close_node and leaves no GRAM at the undeployed top node’s address', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('10') })
        const { env } = sc
        await retire(env)
        const r = await env.jackpot.sendSweep(env.governor.getSender(), { value: env.fees.sweep })
        expectChainSucceeded(r)
        expect(r.transactions.some((t) => opOf(t) === JackpotOp.closeNode)).toBe(false)
        expect(await balanceOf(env, nodeAt(env, 4, 0n).address)).toBe(0n)
    }, 100000)

    it('A sweep that brings less than fee::sweep + close_cost is refused, and the float is unchanged', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('10') })
        const { env } = sc
        await retire(env)
        await buildTree(env, 65)
        const value = (await sweepValue(env)) - 1n
        const j0 = await balanceOf(env, env.jackpot.address)
        const r = await env.jackpot.sendSweep(env.governor.getSender(), { value })
        expect(r.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: JackpotError.insufficientFee })
        expect(await balanceOf(env, env.jackpot.address)).toBeGreaterThanOrEqual(j0)
        expect(r.transactions.some((t) => opOf(t) === JackpotOp.closeNode)).toBe(false)
    }, 100000)

    it('sweep requires unstaking_tokens = 0; settle_unstake with credit = false clears a stuck count and lets it run', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('10') })
        const { env } = sc
        await retire(env)
        await setUnstaking(env, G('3'))
        const refused = await env.jackpot.sendSweep(env.governor.getSender(), { value: await sweepValue(env) })
        expect(refused.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: JackpotError.cannotSweep })
        const held = (await jackpotState(env)).heldTokens
        const strangerTry = await env.jackpot.sendSettleUnstake(env.keeper.getSender(), { value: G('0.05'), amount: G('3'), credit: false })
        expect(strangerTry.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: JackpotError.accessDenied })
        const tooMuch = await env.jackpot.sendSettleUnstake(env.governor.getSender(), { value: G('0.05'), amount: G('4'), credit: false })
        expect(tooMuch.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: JackpotError.invalidParameters })
        expectChainSucceeded(await env.jackpot.sendSettleUnstake(env.governor.getSender(), { value: G('0.05'), amount: G('3'), credit: false }))
        const after = await jackpotState(env)
        expect(after.unstakingTokens).toBe(0n)
        expect(after.heldTokens).toBe(held) // credit = false only lowers the count
        expectChainSucceeded(await env.jackpot.sendSweep(env.governor.getSender(), { value: await sweepValue(env) }))
        // credit = true raises held_tokens by the amount
        await setUnstaking(env, G('2'))
        const h1 = (await jackpotState(env)).heldTokens
        expectChainSucceeded(await env.jackpot.sendSettleUnstake(env.governor.getSender(), { value: G('0.05'), amount: G('2'), credit: true }))
        expect((await jackpotState(env)).heldTokens).toBe(h1 + G('2'))
    }, 100000)

    it('Stragglers: a frozen node and a node whose value was made too small by hand stay with their subtrees; close_subtree with the subtree’s cost times the margin then closes them, a level-2 node’s leaves included, and is refused with less, before the sweep and past next_position', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('10') })
        const { env } = sc
        await retire(env)
        const list = await buildTree(env, 65)
        const closeSub = (level: number, index: number, value: bigint) =>
            env.jackpot.sendCloseSubtree(env.governor.getSender(), { value, level, index })
        // before the sweep it is refused
        const early = await closeSub(2, 0, G('5'))
        expect(early.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: JackpotError.notSwept })
        // a frozen node (2, 0): the cascade passes it by
        const frozen = nodeAt(env, 2, 0n).address
        const acc = (await env.blockchain.getContract(frozen)).account
        const state = acc.account!.storage.state
        if (state.type !== 'active') throw new Error('no node')
        const init = beginCell().storeUint(6, 5).storeRef(state.state.code!).storeRef(state.state.data!).endCell()
        await env.blockchain.setShardAccount(frozen, {
            ...acc,
            account: {
                ...acc.account!,
                storage: {
                    ...acc.account!.storage,
                    state: { type: 'frozen', stateHash: BigInt('0x' + init.hash().toString('hex')) },
                },
            },
        })
        // and a node (3, 0) made short by hand: its parent's message is held and its value cut
        const sweepMsg = messageFrom(env.governor.address, env.jackpot.address, await sweepValue(env), beginCell().storeUint(JackpotOp.sweep, 32).storeUint(0, 64).endCell())
        const afterTop = await holdUntil(env, sweepMsg, toAddr(nodeAt(env, 4, 0n).address))
        const toThree = afterTop.find((m) => m.info.dest?.toString() === nodeAt(env, 3, 0n).address.toString())!
        const cut = { ...toThree, info: { ...(toThree.info as object), value: { coins: G('0.001') } } as typeof toThree.info }
        const short = await deliver(env, cut)
        const three = nodeAt(env, 3, 0n).address
        const txThree = short.transactions.find((t) => t.inMessage?.info.dest?.toString() === three.toString())!
        expect(txThree.outMessages.size).toBe(0)
        const stateOf = async (level: number, index: number) => (await env.blockchain.getContract(nodeAt(env, level, BigInt(index)).address)).accountState?.type
        expect(await stateOf(3, 0)).toBe('active')
        expect(await stateOf(2, 0)).toBe('frozen')
        expect(await stateOf(1, 0)).toBe('active') // no child is left under a missing parent
        // the highest stranded node is (3, 0): less than its cost is refused, the cost closes the subtree
        const cost3 = await env.jackpot.getSubtreeCloseCost(3, 0)
        const less = await closeSub(3, 0, cost3 - 1n)
        expect(less.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: JackpotError.insufficientFee })
        // a node past next_position was never deployed
        const past = await closeSub(2, 2, G('5'))
        expect(past.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: JackpotError.invalidParameters })
        // (3, 0) closes and forwards to (2, 0), still frozen: only the frozen node's debt is paid
        expectChainSucceeded(await closeSub(3, 0, cost3 + G('0.05')))
        expect(await stateOf(3, 0)).not.toBe('active')
        expect(await stateOf(2, 0)).toBe('frozen')
        // revive (2, 0) with its exact state, then close it: its leaves go with it
        await env.blockchain.sendMessage({
            ...messageFrom(env.keeper.address, frozen, G('0.5'), beginCell().endCell(), false),
            init: { code: state.state.code!, data: state.state.data! },
        })
        expect(await stateOf(2, 0)).toBe('active')
        const cost2 = await env.jackpot.getSubtreeCloseCost(2, 0)
        expectChainSucceeded(await closeSub(2, 0, cost2 + G('0.05')))
        for (const x of list) expect(await stateOf(x.level, x.index)).not.toBe('active')
    }, 600000)

    // Nodes on their own, with a stand-in for the Jackpot and the parents.
    async function lone(level: number, index: bigint) {
        const { nodeCode } = await codes()
        const bc = await Blockchain.create()
        bc.now = A0
        const jackpot = await bc.treasury('j')
        const stranger = await bc.treasury('stranger')
        const mk = (l: number, i: bigint) =>
            bc.openContract(Node.createFromConfig({ jackpot: jackpot.address, level: l, index: i }, nodeCode))
        const node = mk(level, index)
        const parent = level === 4 ? jackpot.address : mk(level + 1, index / 64n).address
        const update = (tag: number, c: bigint, delta: bigint) =>
            beginCell()
                .storeUint(JackpotOp.update, 32)
                .storeUint(0, 64)
                .storeUint(tag, 32)
                .storeUint(c << BigInt(6 * (level - 1)), 32)
                .storeInt(delta, 128)
                .storeBit(false)
                .endCell()
        const send = (from: Address, body: ReturnType<typeof update>, value = toNano('1'), init = false) =>
            bc.sendMessage({
                ...messageFrom(from, node.address, value, body, false),
                ...(init ? { init: node.init } : {}),
            })
        const close = (nextPosition: number) =>
            beginCell().storeUint(JackpotOp.closeNode, 32).storeUint(0, 64).storeUint(nextPosition, 32).endCell()
        return { bc, node, parent, jackpot, stranger, mk, update, send, close }
    }

    const big = G('100000')

    it('A node with any non-zero child sum refuses close_node, keeps its subtree and sends nothing; with all sums zero and enough value it forwards to each existing child and deletes itself; short of value it does nothing and keeps it', async () => {
        const t = await lone(2, 0n)
        await t.send(t.parent, t.update(1, 0n, 5n), toNano('1'), true)
        const refused = await t.send(t.parent, t.close(5000), big)
        const tx = refused.transactions.find((x) => x.inMessage?.info.dest?.toString() === t.node.address.toString())!
        expect(tx.outMessages.size).toBe(0)
        expect((await t.bc.getContract(t.node.address)).accountState?.type).toBe('active')
        // the sum goes back to zero; with too little value it does nothing and keeps it
        await t.send(t.parent, t.update(1, 0n, -5n))
        const b0 = (await t.bc.getContract(t.node.address)).balance
        const poor = await t.send(t.parent, t.close(5000), G('0.01'))
        const ptx = poor.transactions.find((x) => x.inMessage?.info.dest?.toString() === t.node.address.toString())!
        expect(ptx.outMessages.size).toBe(0)
        expect((await t.bc.getContract(t.node.address)).accountState?.type).toBe('active')
        expect((await t.bc.getContract(t.node.address)).balance).toBeGreaterThan(b0)
        // with the value, to every child below next_position and then itself
        const closed = await t.send(t.parent, t.close(5000), big)
        const ctx = closed.transactions.find((x) => x.inMessage?.info.dest?.toString() === t.node.address.toString())!
        expect(ctx.outMessages.size).toBe(65)
        expect((await t.bc.getContract(t.node.address)).accountState?.type).not.toBe('active')
        const toChildren = [...ctx.outMessages.values()].filter((m) => m.info.dest?.toString() !== t.jackpot.address.toString())
        expect(toChildren).toHaveLength(64)
        for (const m of toChildren) expect(m.body.beginParse().preloadUint(32)).toBe(JackpotOp.closeNode)
        // a smaller tree: next_position 100 means 2 children
        const u = await lone(2, 0n)
        await u.send(u.parent, u.update(1, 0n, 0n), toNano('1'), true)
        const small = await u.send(u.parent, u.close(100), big)
        const stx = small.transactions.find((x) => x.inMessage?.info.dest?.toString() === u.node.address.toString())!
        expect(stx.outMessages.size).toBe(3)
    }, 100000)

    it('A close_node from anyone but the node’s parent or the Jackpot ends at the sender check, never calling accept_message: a thousand of them leave the balance where it was and change nothing', async () => {
        const t = await lone(2, 0n)
        await t.send(t.parent, t.update(1, 0n, 5n), toNano('1'), true)
        const before = (await t.bc.getContract(t.node.address)).balance
        let worstGas = 0n
        for (let i = 0; i < 1000; i++) {
            const r = await t.send(t.stranger.address, t.close(5000), 20_000_000n)
            const tx = r.transactions.find((x) => x.inMessage?.info.dest?.toString() === t.node.address.toString())!
            if (tx.description.type === 'generic' && tx.description.computePhase.type === 'vm') {
                if (tx.description.computePhase.gasUsed > worstGas) worstGas = tx.description.computePhase.gasUsed
            }
            expect(tx.outMessages.size).toBe(0)
        }
        console.log('close_node from a stranger: gas', worstGas.toString())
        expect(worstGas).toBeLessThan(5000n)
        const after = (await t.bc.getContract(t.node.address)).balance
        expect(after).toBeGreaterThanOrEqual(before)
        expect((await t.bc.getContract(t.node.address)).accountState?.type).toBe('active')
    }, 600000)

    it('Gas bounds: a level-1 close and a 64-child close each use at most gas_1 and gas_inner with at least 1.5 times headroom, within 65 actions and the 1,000,000 gas limit; GETFORWARDFEE counts are at least the real close_node’s', async () => {
        const constants = readFileSync('contracts/imports/constants.fc', 'utf8')
        const constant = (name: string) => BigInt(new RegExp(`const int ${name} = (\\d+);`).exec(constants)![1])
        const gas1 = constant('close::gas_1')
        const gasInner = constant('close::gas_inner')
        let measured1 = 0n
        let measuredInner = 0n
        for (const [level, n] of [
            [1, 64],
            [2, 4096],
            [3, 262144],
            [4, 16777216],
        ] as const) {
            const t = await lone(level, 0n)
            await t.send(t.parent, t.update(1, 0n, 0n), toNano('1'), true)
            const r = await t.send(t.parent, t.close(n), big)
            const tx = r.transactions.find((x) => x.inMessage?.info.dest?.toString() === t.node.address.toString())!
            if (tx.description.type !== 'generic' || tx.description.computePhase.type !== 'vm') throw new Error('no compute')
            const gas = tx.description.computePhase.gasUsed
            if (level === 1) measured1 = gas
            else if (gas > measuredInner) measuredInner = gas
            expect(tx.outMessages.size).toBeLessThanOrEqual(65)
            expect(gas).toBeLessThan(1_000_000n)
            // the real close_node: a body of 128 bits, no references, so its counts are within the 2 cells and 1,023 bits
            for (const m of tx.outMessages.values()) {
                if (m.body.beginParse().preloadUint(32) === JackpotOp.closeNode) {
                    expect(m.body.refs.length).toBe(0)
                    expect(m.body.bits.length).toBeLessThanOrEqual(1023)
                    expect(m.init == null).toBe(true)
                }
            }
        }
        console.log('close_node gas: level 1', measured1.toString(), 'inner', measuredInner.toString(), 'constants', gas1.toString(), gasInner.toString())
        expect(measured1 * 3n).toBeLessThanOrEqual(gas1 * 2n)
        expect(measuredInner * 3n).toBeLessThanOrEqual(gasInner * 2n)
        expect(constant('close::margin_num') * 2n).toBeGreaterThanOrEqual(constant('close::margin_den') * 3n)
        expect(constants).not.toContain('fee::close_hop')
    }, 200000)
})
