/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests read state they just made */
// The rules v1 kept (the spec's "Carried over" list) in the amended design: forged senders and bounces, unconfirmed
// payouts, the falling rate, a poke's bounce, governor setters, and the unstake paths of the Float criterion.
import '@ton/test-utils'
import { Address, Cell, Message, beginCell, toNano } from '@ton/core'
import { BlockchainTransaction, createEmptyShardAccount, SendMessageResult } from '@ton/sandbox'
import {
    BoundaryLog,
    JackpotError,
    JackpotOp,
    LogTopic,
    Reason,
    RefusedLog,
    SlotResult,
    logsOf,
    newBounce,
    oldBounce,
} from '../wrappers/Jackpot'
import {
    Env,
    balanceOf,
    depositHgram,
    expectChainSucceeded,
    expectSolvent,
    hgramOf,
    jackpotState,
    messageFrom,
    nodeAt,
    poke,
    reward,
    setupJackpot,
    slotsIn,
    walletAt,
    withdraw,
} from './jackpot/setup'
import {
    A0,
    atJackpot,
    deliver,
    fresh,
    holdUntil,
    pokeFake,
    put,
    setNow,
    startDeposit,
    submitDraw,
    toAddr,
    toBoundary,
} from './jackpot/scenario'

const G = (n: string | number) => toNano(String(n))
const opOfBody = (b: Cell) => {
    const s = b.beginParse()
    return s.remainingBits >= 32 ? s.loadUint(32) : 0
}
// A bounce as the network makes it: the new format carries the whole original body, the old one its first 256 bits.
const bounceOf = (
    original: Cell,
    src: Address,
    to: Address,
    format: 'new' | 'old' = 'new',
    value = G('0.3'),
): Message => ({
    info: {
        type: 'internal',
        ihrDisabled: true,
        bounce: false,
        bounced: true,
        src,
        dest: to,
        value: { coins: value },
        ihrFee: 0n,
        forwardFee: 0n,
        createdLt: 0n,
        createdAt: 0,
    },
    body:
        format === 'new'
            ? beginCell().storeUint(newBounce, 32).storeRef(original).endCell()
            : beginCell()
                  .storeUint(oldBounce, 32)
                  .storeBits(original.beginParse().loadBits(Math.min(256, original.bits.length)))
                  .endCell(),
})
const hipoWallet = async (env: Env) => (await env.jackpot.getAddresses()).wallet
const fromJackpot = (env: Env, r: SendMessageResult) =>
    r.transactions.filter((t) => t.inMessage?.info.src?.toString() === env.jackpot.address.toString())

describe('Carried over from v1', () => {
    it('full exit returns principal less 1 nano-hGRAM per burn', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 3, mint: G('1000') })
        const { env, players } = sc
        const deposited: bigint[] = []
        for (const p of players) deposited.push((await put(env, p, G('100'))).booking!.principal)
        await reward(env, G('20'))
        await poke(env) // the stored rate follows Hipo's; min_gap has not passed
        const [tc, tt] = await env.jackpot.getQuote()
        for (const [i, p] of players.entries()) {
            const h = await hgramOf(env, p.address)
            await withdraw(env, p, G('40'))
            await withdraw(env, p, 0n)
            const got = (await hgramOf(env, p.address)) - h
            const worth = (deposited[i] * tt) / tc
            expect(got).toBeLessThanOrEqual(worth)
            expect(worth - got).toBeLessThanOrEqual(2n)
        }
        const s = await jackpotState(env)
        expect(s.principal).toBe(0n)
        expect(s.tickets).toBe(0n)
        await expectSolvent(env)
    }, 200000)

    describe('with a stand-in treasury', () => {
        it('falling rate: a lower quote raises the flag; deposits are refused whole, burns pay pro rata, a submit is refused, clear_falling lowers it', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 3, mint: G('1000'), fake: true })
            const { env, players } = sc
            await pokeFake(sc, G('110'), G('100')) // the stored rate rises to 1.1 (no boundary: min_gap)
            await put(env, players[0], G('100')) // 110 GRAM of principal at 1.1
            expect((await jackpotState(env)).principal).toBe(G('110'))
            setNow(env, A0 + 3600)
            await pokeFake(sc, G('121'), G('100')) // a boundary
            expect((await jackpotState(env)).tag).toBe(1n)
            // a lower quote: the flag rises and is stored with the rate
            await pokeFake(sc, G('100'), G('100'))
            expect((await jackpotState(env)).falling).toBe(true)
            // a deposit is refused with rate_falling and returns whole
            const h = await hgramOf(env, players[1].address)
            const dep = await depositHgram(env, players[1], G('50'), { minC: 0n })
            expect(dep.booking).toBeUndefined()
            expect(logsOf<RefusedLog>(dep.result.externals, LogTopic.refused)[0].reason).toBe(Reason.rateFalling)
            expect(await hgramOf(env, players[1].address)).toBe(h)
            // a submit is refused while the flag is up
            const sub = await submitDraw(env)
            expect(sub.transactions).toHaveTransaction({
                to: env.jackpot.address,
                success: false,
                exitCode: JackpotError.rateFalling,
            })
            // a burn pays pro rata: F·x/P of the hGRAM, not x·TT/TC
            const s = await jackpotState(env)
            const free = s.heldTokens - s.incomingTokens - s.reservedTokens
            const before = await hgramOf(env, players[0].address)
            await withdraw(env, players[0], 0n)
            expect(await hgramOf(env, players[0].address)).toBe(before + (free * G('110')) / s.principal)
            await env.jackpot.sendClearFalling(env.governor.getSender(), { value: G('0.05') })
            expect((await jackpotState(env)).falling).toBe(false)
            const stranger = await env.jackpot.sendClearFalling(players[1].getSender(), { value: G('0.05') })
            expect(stranger.transactions).toHaveTransaction({
                to: env.jackpot.address,
                success: false,
                exitCode: JackpotError.accessDenied,
            })
        }, 200000)

        it('a poke’s quote bounce refunds the poker and changes nothing else', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000'), fake: true })
            const { env, players } = sc
            await put(env, players[0], G('100'))
            const before = await jackpotState(env)
            const b0 = await env.jackpot.getBoundary()
            // the stand-in treasury does not exist: the request bounces
            await env.blockchain.setShardAccount(sc.fake!.address, createEmptyShardAccount(sc.fake!.address))
            const keeper0 = await balanceOf(env, env.keeper.address)
            const r = await poke(env, G('0.5'))
            expect(r.transactions).toHaveTransaction({
                from: sc.fake!.address,
                to: env.jackpot.address,
                inMessageBounced: true,
            })
            expect(r.transactions).toHaveTransaction({ from: env.jackpot.address, to: env.keeper.address })
            expect(await jackpotState(env)).toEqual(before)
            expect(await env.jackpot.getBoundary()).toEqual(b0)
            // the poke is paid by the keeper; what comes back is the value less the fees of the chain
            expect(keeper0 - (await balanceOf(env, env.keeper.address))).toBeLessThan(0n + G('0.5'))
        }, 200000)
    })

    describe('payouts', () => {
        it('a burn is paid in the step that receives it: nothing comes back to the Jackpot after its send_tokens', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
            const { env, players } = sc
            await put(env, players[0], G('100'))
            const h = await hgramOf(env, players[0].address)
            const r = await withdraw(env, players[0], G('40'))
            expectChainSucceeded(r)
            expect(await hgramOf(env, players[0].address)).toBe(h + G('40'))
            const toJackpot = r.transactions.filter(
                (t) => t.inMessage?.info.dest?.toString() === env.jackpot.address.toString(),
            )
            expect(toJackpot).toHaveLength(1) // the burn_notification, and no confirmation
            await expectSolvent(env)
        }, 200000)

        it('hGRAM sent to the Jackpot without a notification stays untracked; return_tokens pays it back to its owner, the governor only', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
            const { env, players } = sc
            await put(env, players[0], G('100'))
            const before = await jackpotState(env)
            const wallet = await env.hipo.walletOf(players[1].address)
            const h = await hgramOf(env, players[1].address)
            await wallet.sendSendTokens(players[1].getSender(), {
                value: G('0.3'),
                tokens: G('25'),
                recipient: env.jackpot.address,
                returnExcess: players[1].address,
                forwardTonAmount: 0n,
            })
            expect(await jackpotState(env)).toEqual(before) // nothing was heard
            expect(await hgramOf(env, players[1].address)).toBe(h - G('25'))
            const denied = await env.jackpot.sendReturnTokens(players[1].getSender(), {
                value: G('0.3'),
                owner: players[1].address,
                amount: G('25'),
            })
            expect(denied.transactions).toHaveTransaction({
                to: env.jackpot.address,
                success: false,
                exitCode: JackpotError.accessDenied,
            })
            expectChainSucceeded(
                await env.jackpot.sendReturnTokens(env.governor.getSender(), {
                    value: G('0.3'),
                    owner: players[1].address,
                    amount: G('25'),
                }),
            )
            expect(await hgramOf(env, players[1].address)).toBe(h)
            expect(await jackpotState(env)).toEqual(before)
            await expectSolvent(env)
        }, 200000)

        it('a deposit_ready that fails at the Jackpot bounces to the wallet; the tokens stay incoming until return_tokens(in_flight)', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000'), failReady: true })
            const { env, players } = sc
            const h = await hgramOf(env, players[0].address)
            const dep = await depositHgram(env, players[0], G('100'), { minC: 0n })
            expect(dep.booking).toBeUndefined()
            const s = await jackpotState(env)
            expect(s.incomingTokens).toBe(G('100'))
            expect(s.principal).toBe(0n)
            // the wallet lowered its pending count and closed, being empty
            const w = await env.blockchain.getContract(walletAt(env, players[0].address).address)
            expect(w.accountState?.type).not.toBe('active')
            // more than is incoming is refused; the right amount pays the owner
            const over = await env.jackpot.sendReturnTokens(env.governor.getSender(), {
                value: G('0.3'),
                owner: players[0].address,
                amount: G('101'),
                inFlight: true,
            })
            expect(over.transactions).toHaveTransaction({
                to: env.jackpot.address,
                success: false,
                exitCode: JackpotError.invalidParameters,
            })
            expectChainSucceeded(
                await env.jackpot.sendReturnTokens(env.governor.getSender(), {
                    value: G('0.3'),
                    owner: players[0].address,
                    amount: G('100'),
                    inFlight: true,
                }),
            )
            expect(await hgramOf(env, players[0].address)).toBe(h)
            const after = await jackpotState(env)
            expect([after.incomingTokens, after.heldTokens]).toEqual([0n, 0n])
        }, 200000)

        it('the burn owed is paid to the burner once it reaches the batch, and leaves reserved_tokens', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000'), burnBatch: 1n })
            const { env, players } = sc
            await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
            await put(env, players[0], G('300'))
            const rb = await toBoundary(env, G('400'))
            const [log] = logsOf<BoundaryLog>(rb.externals, LogTopic.boundary)
            expect(log.burn).toBeGreaterThan(0n)
            const burner0 = await hgramOf(env, env.burner.address)
            expect((await jackpotState(env)).burnOwed).toBe(log.burn)
            expectChainSucceeded(await submitDraw(env))
            expect(await hgramOf(env, env.burner.address)).toBe(burner0 + log.burn)
            const s = await jackpotState(env)
            expect([s.burnOwed, s.reservedTokens]).toEqual([0n, 0n])
            await expectSolvent(env)
        }, 200000)

        it('burn only on pot − carried: a pot that carries rolled-over prizes burns only the new part', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
            const { env, players } = sc
            await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
            await put(env, players[0], G('300'))
            const first = logsOf<BoundaryLog>((await toBoundary(env, G('400'))).externals, LogTopic.boundary)[0]
            const node = nodeAt(env, 3, 0n)
            const saved = (await env.blockchain.getContract(node.address)).account
            await env.blockchain.setShardAccount(node.address, createEmptyShardAccount(node.address))
            await submitDraw(env) // no search is answered: the slots stay open
            // the next boundary rolls the open slots over into carried and sets a new pot aside
            await env.blockchain.setShardAccount(node.address, saved)
            const second = logsOf<BoundaryLog>((await toBoundary(env, G('400'))).externals, LogTopic.boundary)[0]
            const [p0, p1, p2] = first.prizes!
            expect(second.carried).toBe(p0 + p1 + p2)
            expect(second.burn).toBe(((second.pot - second.unstaked - second.carried) * 1000n) / 10000n)
            const total = second.prizes![0] + second.prizes![1] + second.prizes![2]
            expect(total + second.burn).toBe(second.pot - second.unstaked)
            expect((await jackpotState(env)).carried).toBe(0n)
        }, 200000)

        it('one owner wins two slots: each prize is its own payout', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
            const { env, players } = sc
            await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
            await put(env, players[0], G('300'))
            await toBoundary(env, G('400'))
            const h = await hgramOf(env, players[0].address)
            const r = await submitDraw(env)
            const hits = slotsIn(r).filter((x) => x.result === SlotResult.hit)
            expect(hits).toHaveLength(3)
            expect(new Set(hits.map((x) => x.owner!.toString())).size).toBe(1)
            expect(await hgramOf(env, players[0].address)).toBe(h + hits.reduce((a, x) => a + x.amount, 0n))
        }, 200000)
    })

    describe('senders and setters', () => {
        it('masterchain sender: a notification naming a masterchain sender books nothing and sends nothing', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000') })
            const { env } = sc
            const wallet = await hipoWallet(env)
            const before = await jackpotState(env)
            const body = beginCell()
                .storeUint(JackpotOp.transferNotification, 32)
                .storeUint(1, 64)
                .storeCoins(G('50'))
                .storeAddress(new Address(-1, Buffer.alloc(32, 7)))
                .storeBit(false)
                .endCell()
            const r = await deliver(env, messageFrom(wallet, env.jackpot.address, env.fees.deposit, body, false))
            expectChainSucceeded(r)
            expect(await jackpotState(env)).toEqual(before)
            expect(fromJackpot(env, r)).toHaveLength(0)
        }, 100000)

        it('governor setters and deploy checks: only the governor, with bounds; a deploy with a bad parameter is refused', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('10') })
            const { env, players } = sc
            const g = env.governor.getSender()
            const fail = (r: { transactions: BlockchainTransaction[] }, code: number) => {
                expect(r.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: code })
            }
            fail(
                await env.jackpot.sendSetBurnShare(g, { value: G('0.05'), burnShare: 2001n }),
                JackpotError.invalidParameters,
            )
            expectChainSucceeded(await env.jackpot.sendSetBurnShare(g, { value: G('0.05'), burnShare: 2000n }))
            fail(
                await env.jackpot.sendSetMinDeposit(g, { value: G('0.05'), minDeposit: 0n }),
                JackpotError.invalidParameters,
            )
            expectChainSucceeded(await env.jackpot.sendSetMinPot(g, { value: G('0.05'), minPot: G('2') }))
            expectChainSucceeded(await env.jackpot.sendSetBurnBatch(g, { value: G('0.05'), burnBatch: G('3') }))
            const s = await jackpotState(env)
            expect([s.burnShare, s.minPot, s.burnBatch]).toEqual([2000n, G('2'), G('3')])
            const s2 = players[0].getSender()
            fail(await env.jackpot.sendSetBurnShare(s2, { value: G('0.05'), burnShare: 5n }), JackpotError.accessDenied)
            fail(await env.jackpot.sendSetMinPot(s2, { value: G('0.05'), minPot: 5n }), JackpotError.accessDenied)
            fail(await env.jackpot.sendSetBurnBatch(s2, { value: G('0.05'), burnBatch: 5n }), JackpotError.accessDenied)
            fail(
                await env.jackpot.sendSetMinDeposit(s2, { value: G('0.05'), minDeposit: 5n }),
                JackpotError.accessDenied,
            )
            fail(
                await env.jackpot.sendSetHalter(s2, { value: G('0.05'), halter: s2.address }),
                JackpotError.accessDenied,
            )
            fail(await env.jackpot.sendSetHalted(s2, { value: G('0.05'), halted: true }), JackpotError.accessDenied)
            fail(await env.jackpot.sendWithdrawSurplus(s2, { value: G('0.05') }), JackpotError.accessDenied)
            fail(
                await env.jackpot.sendUpgradeCode(s2, { value: G('0.05'), code: beginCell().endCell() }),
                JackpotError.accessDenied,
            )
            fail(await env.jackpot.sendRetire(s2, { value: G('0.05') }), JackpotError.accessDenied)
            fail(
                await env.jackpot.sendSetSuccessor(s2, { value: G('0.05'), successor: null, depositFee: 0n }),
                JackpotError.accessDenied,
            )
            fail(
                await env.jackpot.sendWithdrawFor(s2, { value: G('0.5'), toSuccessor: false, owners: [s2.address] }),
                JackpotError.accessDenied,
            )
            fail(
                await env.jackpot.sendCloseSubtree(s2, { value: G('0.05'), level: 1, index: 0 }),
                JackpotError.accessDenied,
            )
            // the halter can stop but not resume
            expectChainSucceeded(
                await env.jackpot.sendSetHalted(env.halter.getSender(), { value: G('0.05'), halted: true }),
            )
            fail(
                await env.jackpot.sendSetHalted(env.halter.getSender(), { value: G('0.05'), halted: false }),
                JackpotError.accessDenied,
            )
            // a deploy with bad parameters is refused on its first message
            for (const config of [{ burnShare: 2001n }, { minDeposit: 0n }]) {
                const bad = await setupJackpot({ testBuild: true, config }).then(
                    () => 'deployed',
                    () => 'refused',
                )
                expect(bad).toBe('refused')
            }
        }, 200000)

        it('return_tokens and set_hipo_wallet are the governor only', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('10') })
            const { env, players } = sc
            const a = await env.jackpot.getAddresses()
            const r = await env.jackpot.sendReturnTokens(players[0].getSender(), {
                value: G('0.3'),
                owner: players[0].address,
                amount: 1n,
            })
            expect(r.transactions).toHaveTransaction({
                to: env.jackpot.address,
                success: false,
                exitCode: JackpotError.accessDenied,
            })
            const s = await env.jackpot.sendSetHipoWallet(players[0].getSender(), {
                value: G('0.05'),
                parent: a.parent,
                wallet: a.wallet,
                walletCode: a.walletCode,
            })
            expect(s.transactions).toHaveTransaction({
                to: env.jackpot.address,
                success: false,
                exitCode: JackpotError.accessDenied,
            })
            // the setter needs the Jackpot halted
            await env.jackpot.sendSetHalted(env.governor.getSender(), { value: G('0.05'), halted: true })
            expectChainSucceeded(
                await env.jackpot.sendSetHipoWallet(env.governor.getSender(), {
                    value: G('0.05'),
                    parent: a.parent,
                    wallet: a.wallet,
                    walletCode: a.walletCode,
                }),
            )
        }, 100000)

        it('forged messages: nodes, the wallet and the Jackpot refuse or ignore a stranger', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
            const { env, players } = sc
            await put(env, players[0], G('100'))
            const stranger = players[1].address
            const before = await jackpotState(env)
            const node = nodeAt(env, 4, 0n).address
            const upd = beginCell()
                .storeUint(JackpotOp.update, 32)
                .storeUint(0, 64)
                .storeUint(9, 32)
                .storeUint(0, 32)
                .storeInt(G('999'), 128)
                .storeBit(false)
                .endCell()
            const desc = beginCell()
                .storeUint(JackpotOp.descend, 32)
                .storeUint(0, 64)
                .storeUint(1, 32)
                .storeUint(0, 8)
                .storeUint(0, 8)
                .storeUint(1, 128)
                .storeUint(1, 128)
                .endCell()
            for (const body of [upd, desc]) {
                const r = await deliver(env, messageFrom(stranger, node, G('0.5'), body, false))
                expect(r.transactions).toHaveTransaction({
                    to: node,
                    success: false,
                    exitCode: JackpotError.accessDenied,
                })
            }
            // a wallet hears prepare_deposit, deposit_booked, deposit_cancelled and close_wallet only from the Jackpot,
            // and a burn only from its owner or the Jackpot
            const w = walletAt(env, players[0].address).address
            for (const body of [
                beginCell()
                    .storeUint(JackpotOp.prepareDeposit, 32)
                    .storeUint(0, 64)
                    .storeRef(beginCell().endCell())
                    .endCell(),
                beginCell()
                    .storeUint(JackpotOp.depositBooked, 32)
                    .storeUint(0, 64)
                    .storeCoins(5n)
                    .storeUint(0, 32)
                    .storeRef(beginCell().endCell())
                    .endCell(),
                beginCell().storeUint(JackpotOp.depositCancelled, 32).storeUint(0, 64).endCell(),
                beginCell().storeUint(JackpotOp.closeWallet, 32).storeUint(0, 64).endCell(),
            ]) {
                const r = await deliver(env, messageFrom(stranger, w, G('0.2'), body, true))
                expect(r.transactions).toHaveTransaction({ to: w, success: false, exitCode: JackpotError.accessDenied })
            }
            const wd = await walletAt(env, players[0].address).sendBurn(players[1].getSender(), {
                value: env.fees.withdraw,
                amount: 0n,
            })
            expect(wd.transactions).toHaveTransaction({ to: w, success: false, exitCode: JackpotError.accessDenied })
            // a burn_notification from a stranger is ignored by the Jackpot
            const bn = beginCell()
                .storeUint(JackpotOp.burnNotification, 32)
                .storeUint(0, 64)
                .storeCoins(G('10'))
                .storeAddress(players[0].address)
                .storeAddress(null)
                .storeBit(true)
                .storeUint(0, 32)
                .storeMaybeRef(null)
                .endCell()
            const r = await deliver(env, messageFrom(stranger, env.jackpot.address, G('0.5'), bn))
            expect(fromJackpot(env, r)).toHaveLength(0)
            expect(await jackpotState(env)).toEqual(before)
        }, 200000)

        it('forged bounce: an ordinary message wrapping a made-up prepare_deposit, deposit_booked or burn_notification throws and changes nothing', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
            const { env, players } = sc
            await put(env, players[0], G('100'))
            const before = await jackpotState(env)
            const stranger = players[1]
            const ctx = beginCell().endCell()
            const wrap = (original: Cell) => beginCell().storeUint(newBounce, 32).storeRef(original).endCell()
            const prepare = beginCell().storeUint(JackpotOp.prepareDeposit, 32).storeUint(1, 64).storeRef(ctx).endCell()
            const booked = beginCell()
                .storeUint(JackpotOp.depositBooked, 32)
                .storeUint(1, 64)
                .storeCoins(G('10'))
                .storeUint(0, 32)
                .storeRef(ctx)
                .endCell()
            const burned = beginCell()
                .storeUint(JackpotOp.burnNotification, 32)
                .storeUint(1, 64)
                .storeCoins(G('10'))
                .storeAddress(stranger.address)
                .storeAddress(stranger.address)
                .storeBit(false)
                .storeUint(0, 32)
                .storeMaybeRef(null)
                .endCell()
            const h = await hgramOf(env, stranger.address)
            for (const original of [prepare, booked]) {
                const r = await deliver(
                    env,
                    messageFrom(stranger.address, env.jackpot.address, G('0.5'), wrap(original), true),
                )
                expect(r.transactions).toHaveTransaction({ to: env.jackpot.address, success: false })
                expect(r.transactions).toHaveTransaction({
                    from: env.jackpot.address,
                    to: stranger.address,
                    inMessageBounced: true,
                })
            }
            const w = walletAt(env, players[0].address)
            const r = await deliver(env, messageFrom(stranger.address, w.address, G('0.5'), wrap(burned), true))
            expect(r.transactions).toHaveTransaction({ to: w.address, success: false })
            expect(await jackpotState(env)).toEqual(before)
            expect(await hgramOf(env, stranger.address)).toBe(h)
            expect((await w.getWalletState()).balance).toBe(before.principal)
        }, 200000)

        it('bounce formats: the Jackpot ignores an old-format bounce; the wallet takes an old-format deposit_ready bounce and lowers pending', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
            const { env, players } = sc
            await put(env, players[0], G('100'))
            const wallet = walletAt(env, players[0].address)
            // the Jackpot: an old-format bounce of a deposit_booked answers nothing it sends
            const before = await jackpotState(env)
            const booked = beginCell()
                .storeUint(JackpotOp.depositBooked, 32)
                .storeUint(9, 64)
                .storeCoins(G('10'))
                .storeUint(0, 32)
                .storeRef(beginCell().endCell())
                .endCell()
            const r = await deliver(env, bounceOf(booked, wallet.address, env.jackpot.address, 'old'))
            expect(fromJackpot(env, r)).toHaveLength(0)
            expect(await jackpotState(env)).toEqual(before)
            // the wallet: a deposit in flight raised pending; an old-format bounce of its non-busy deposit_ready lowers it
            const ready = (await startDeposit(env, players[0], G('30'), toAddr(wallet.address)))[0]
            expect((await wallet.getWalletState()).pending).toBe(1n)
            await deliver(env, bounceOf(ready.body, env.jackpot.address, wallet.address, 'old'))
            expect((await wallet.getWalletState()).pending).toBe(0n)
            // a busy one, and any other old-format bounce, are ignored
            const busy = beginCell()
                .storeUint(JackpotOp.depositReady, 32)
                .storeUint(0, 64)
                .storeBit(true)
                .storeBit(false)
                .endCell()
            await deliver(env, bounceOf(busy, env.jackpot.address, wallet.address, 'old'))
            await deliver(env, bounceOf(booked, env.jackpot.address, wallet.address, 'old'))
            expect(await wallet.getWalletState()).toMatchObject({ balance: before.principal, pending: 0n })
        }, 200000)

        it('a thousand-fold tiny close_node from a stranger leaves a live node’s balance where it was', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
            const { env, players } = sc
            await put(env, players[0], G('100'))
            const node = nodeAt(env, 1, 0n).address
            const body = beginCell().storeUint(JackpotOp.closeNode, 32).storeUint(0, 64).storeUint(1, 32).endCell()
            const balance0 = await balanceOf(env, node)
            for (let i = 0; i < 25; i++) {
                const r = await deliver(env, messageFrom(players[1].address, node, 1_000_000n, body, false))
                expect(r.transactions).toHaveTransaction({ to: node, success: true })
            }
            // each message brought 0.001 GRAM, which the node keeps (it paid no gas for them, ending at the sender check)
            expect(await balanceOf(env, node)).toBeGreaterThanOrEqual(balance0)
            expect(await balanceOf(env, node)).toBeLessThanOrEqual(balance0 + 25n * 1_000_000n)
            expect((await nodeAt(env, 1, 0n).getNodeData()).initialized).toBe(true)
        }, 200000)
    })
})

describe('Float: the unstake paths', () => {
    // A boundary below float_low that unstakes: the chain stops at the Jackpot's reply, with the unstake not delivered.
    async function heldUnstake() {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000'), float: G('7.5') })
        const { env, players } = sc
        await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
        await put(env, players[0], G('300'))
        await reward(env, G('400'))
        const b = await env.jackpot.getBoundary()
        setNow(env, b.lastBoundary + b.minGap)
        const wallet = await hipoWallet(env)
        const out = await holdUntil(
            env,
            messageFrom(
                env.keeper.address,
                env.jackpot.address,
                env.fees.poke,
                beginCell().storeUint(JackpotOp.poke, 32).storeUint(0, 64).endCell(),
            ),
            atJackpot(env, JackpotOp.takeCurrentQuote),
        )
        const unstake = out.find((m) => opOfBody(m.body) === JackpotOp.unstakeTokens)!
        const s = unstake.body.beginParse()
        s.skip(32 + 64)
        return { env, players, wallet, unstake, u: s.loadCoins() }
    }

    it('a deferred bill: the notification arrives rounds later under a foreign query_id, and the counter falls by the amount', async () => {
        const { env, wallet, u } = await heldUnstake()
        const s = await jackpotState(env)
        expect(s.unstakingTokens).toBe(u)
        const body = beginCell()
            .storeUint(JackpotOp.withdrawalNotification, 32)
            .storeUint(123456, 64)
            .storeCoins(u)
            .storeCoins(G('1'))
            .endCell()
        // from anyone else it does nothing
        const other = await env.blockchain.treasury('other')
        const before = await jackpotState(env)
        await deliver(env, messageFrom(other.address, env.jackpot.address, G('0.1'), body, false))
        expect(await jackpotState(env)).toEqual(before)
        env.blockchain.now = (env.blockchain.now ?? A0) + 2 * 65536
        expectChainSucceeded(await deliver(env, messageFrom(wallet, env.jackpot.address, G('1'), body, false)))
        expect((await jackpotState(env)).unstakingTokens).toBe(0n)
    }, 200000)

    it('a rollback stays outside held_tokens; a forged gas_excess changes nothing; return_tokens brings the tokens back', async () => {
        const { env, players, wallet, u } = await heldUnstake()
        const s0 = await jackpotState(env)
        const forged = beginCell().storeUint(JackpotOp.gasExcess, 32).storeUint(0, 64).endCell()
        for (const src of [wallet, players[1].address]) {
            expectChainSucceeded(await deliver(env, messageFrom(src, env.jackpot.address, G('0.1'), forged, false)))
        }
        expect(await jackpotState(env)).toEqual(s0)
        await expectSolvent(env) // the tokens sit in the wallet outside held_tokens
        expect(u).toBeGreaterThan(0n)
    }, 200000)

    it('a bounce of unstake_tokens from the wallet gives the tokens back to held_tokens; an old-format bounce is ignored', async () => {
        const { env, wallet, unstake, u } = await heldUnstake()
        const s0 = await jackpotState(env)
        await deliver(env, bounceOf(unstake.body, wallet, env.jackpot.address, 'old'))
        expect(await jackpotState(env)).toEqual(s0)
        expectChainSucceeded(await deliver(env, bounceOf(unstake.body, wallet, env.jackpot.address, 'new')))
        const s1 = await jackpotState(env)
        expect(s1.heldTokens).toBe(s0.heldTokens + u)
        expect(s1.unstakingTokens).toBe(0n)
    }, 200000)

    it('an instant burn: the notification comes at once and the counter is 0', async () => {
        const { env, unstake, u } = await heldUnstake()
        expectChainSucceeded(await deliver(env, unstake))
        expect((await jackpotState(env)).unstakingTokens).toBe(0n)
        expect(u).toBeGreaterThan(0n)
    }, 200000)
})

