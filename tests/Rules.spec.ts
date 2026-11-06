/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests read state they just made */
// Rules the audits found untested, each driven in the state where it matters (a live draw, a draw waiting, the
// flag up) and each failing if the rule is removed.
import '@ton/test-utils'
import { beginCell, toNano } from '@ton/core'
import {
    BoundaryLog,
    DrawState,
    JackpotError,
    JackpotOp,
    LogTopic,
    RefusedLog,
    Reason,
    SlotResult,
    UnstakeLog,
    logsOf,
    rewardSubmit,
} from '../wrappers/Jackpot'
import {
    balanceOf,
    expectChainSucceeded,
    expectSolvent,
    hgramOf,
    jackpotState,
    jgramOf,
    messageFrom,
    nodeAt,
    reward,
    slotsIn,
    walletAt,
    withdraw,
    depositHgram,
} from './jackpot/setup'
import {
    A0,
    atJackpot,
    deliver,
    forge,
    fresh,
    holdUntil,
    pokeFake,
    put,
    setNextPosition,
    setBalance,
    setNow,
    submitDraw,
    submitMessage,
    toBoundary,
} from './jackpot/scenario'

const G = (n: string | number) => toNano(String(n))

// A waiting draw with a pot: a 300 and b 100 deposited, a reward landed, a boundary passed.
async function waiting(opts: { burnBatch?: bigint; float?: bigint } = {}) {
    const sc = await fresh({ minDeposit: 1n, players: 4, mint: G('1000'), ...opts })
    const { env, players } = sc
    await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
    await put(env, players[0], G('300'))
    await put(env, players[1], G('100'))
    await toBoundary(env, G('30'))
    return sc
}

const bodyOf = (op: number, ...parts: ((b: ReturnType<typeof beginCell>) => void)[]) => {
    const b = beginCell().storeUint(op, 32).storeUint(0, 64)
    for (const p of parts) p(b)
    return b.endCell()
}

describe('Senders during a live draw', () => {
    it('a forged hit, miss and lost change nothing while the searches run; a duplicate hit changes nothing after', async () => {
        const sc = await waiting()
        const { env, players } = sc
        const stranger = players[3]
        // hold the chain at the submit: the three searches are on their way
        const outs = await holdUntil(env, await submitMessage(env), atJackpot(env, JackpotOp.submitRandomness))
        const d = await env.jackpot.getDrawState()
        expect(d.state).toBe(DrawState.resolving)
        expect(d.openSlots).toBe(7)
        const k0 = await env.jackpot.getPosition(0)
        const before = await jackpotState(env)
        const h0 = await hgramOf(env, stranger.address)
        const common = (b: ReturnType<typeof beginCell>) =>
            b.storeUint(d.tag, 32).storeUint(0, 8).storeUint(0, 8).storeUint(k0, 128)
        const forged = [
            bodyOf(JackpotOp.hit, common, (b) => b.storeUint(0, 32).storeAddress(stranger.address)),
            bodyOf(JackpotOp.miss, common, (b) => b.storeUint(0, 32)),
            bodyOf(JackpotOp.lost, common, (b) => b.storeUint(1, 8).storeUint(0, 32)),
        ]
        for (const body of forged) expectChainSucceeded(await forge(env, stranger.address, body))
        const mid = await env.jackpot.getDrawState()
        expect([mid.state, mid.openSlots, mid.attempts]).toEqual([DrawState.resolving, 7, [0, 0, 0]])
        expect(await hgramOf(env, stranger.address)).toBe(h0)
        expect(await jackpotState(env)).toEqual(before)
        // the real searches finish; none is won by the stranger
        const hits: Parameters<typeof deliver>[1][] = []
        for (const m of outs) {
            const iter = await env.blockchain.sendMessageIter(m)
            for await (const tx of iter) {
                if (atJackpot(env, JackpotOp.hit)(tx)) hits.push(tx.inMessage!)
            }
        }
        expect((await env.jackpot.getDrawState()).state).toBe(DrawState.none)
        expect(hits.length).toBe(3)
        expect(await hgramOf(env, stranger.address)).toBe(h0)
        // a duplicate of a real hit pays nothing more
        const after = await jackpotState(env)
        const winnerH = await Promise.all(players.map((p) => hgramOf(env, p.address)))
        await deliver(env, hits[0])
        expect(await jackpotState(env)).toEqual(after)
        expect(await Promise.all(players.map((p) => hgramOf(env, p.address)))).toEqual(winnerH)
    }, 300000)

    it('update and descend from a stranger are refused at every node', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const { env, players } = sc
        await put(env, players[0], G('100'))
        const stranger = players[1].address
        const upd = bodyOf(JackpotOp.update, (b) =>
            b.storeUint(9, 32).storeUint(0, 32).storeInt(G('999'), 128).storeBit(false),
        )
        const desc = bodyOf(JackpotOp.descend, (b) =>
            b.storeUint(1, 32).storeUint(0, 8).storeUint(0, 8).storeUint(1, 128).storeUint(1, 128),
        )
        for (let level = 1; level <= 4; level++) {
            const node = nodeAt(env, level, 0n).address
            for (const body of [upd, desc]) {
                const r = await forge(env, stranger, body, G('0.5'), node)
                expect(r.transactions).toHaveTransaction({
                    to: node,
                    success: false,
                    exitCode: JackpotError.accessDenied,
                })
            }
        }
        await expectSolvent(env)
    }, 200000)

    it('a quote from a stranger is ignored: the stored rate and the boundary rate stay', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const { env, players } = sc
        await put(env, players[0], G('100'))
        const before = await jackpotState(env)
        const b0 = await env.jackpot.getBoundary()
        const ctx = beginCell().storeUint(3, 4).storeUint(0, 32).storeAddress(players[1].address).endCell()
        const forged = beginCell()
            .storeUint(JackpotOp.takeCurrentQuote, 32)
            .storeUint(0, 64)
            .storeUint(G('5'), 128)
            .storeUint(G('1'), 128)
            .storeMaybeRef(ctx)
            .endCell()
        const r = await forge(env, players[1].address, forged)
        expectChainSucceeded(r)
        expect(
            r.transactions.filter((t) => t.inMessage?.info.src?.toString() === env.jackpot.address.toString()),
        ).toHaveLength(0)
        expect(await jackpotState(env)).toEqual(before)
        expect(await env.jackpot.getBoundary()).toEqual(b0)
    }, 200000)

    it('a transfer_notification from a stranger books nothing', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const { env, players } = sc
        const before = await jackpotState(env)
        const body = beginCell()
            .storeUint(JackpotOp.transferNotification, 32)
            .storeUint(1, 64)
            .storeCoins(G('50'))
            .storeAddress(players[1].address)
            .storeBit(false)
            .endCell()
        expectChainSucceeded(await forge(env, players[1].address, body, env.fees.deposit))
        expect(await jackpotState(env)).toEqual(before)
    }, 100000)

    it('a deposit_ready from the wrong sender on a live deposit changes nothing; the real one still books', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const { env, players } = sc
        const { startDeposit, toAddr } = await import('./jackpot/scenario')
        const out = await startDeposit(env, players[0], G('100'), toAddr(walletAt(env, players[0].address).address))
        const before = await jackpotState(env)
        const ctx = out[0].body.beginParse()
        ctx.skip(32 + 64 + 2)
        const ready = beginCell()
            .storeUint(JackpotOp.depositReady, 32)
            .storeUint(0, 64)
            .storeBit(false)
            .storeBit(false)
            .storeRef(ctx.loadRef())
            .endCell()
        const r = await deliver(env, messageFrom(players[1].address, env.jackpot.address, G('0.5'), ready))
        expect(
            r.transactions.filter((t) => t.inMessage?.info.src?.toString() === env.jackpot.address.toString()),
        ).toHaveLength(0)
        expect(await jackpotState(env)).toEqual(before)
        // the real deposit_ready still books
        expectChainSucceeded(await deliver(env, out[0]))
        expect(await jgramOf(env, players[0].address)).toBeGreaterThan(0n)
    }, 200000)
})

describe('The submit', () => {
    it('r_s is paid exactly once: the keeper gets back its value less the Jackpot’s fee, plus r_s', async () => {
        const sc = await waiting()
        const { env } = sc
        const r = await submitDraw(env)
        expectChainSucceeded(r)
        const toKeeper = r.transactions.find(
            (t) =>
                t.inMessage?.info.dest?.toString() === env.keeper.address.toString() &&
                t.inMessage.info.src?.toString() === env.jackpot.address.toString(),
        )!
        const out = toKeeper.inMessage!.info.type === 'internal' ? toKeeper.inMessage!.info.value.coins : 0n
        const submitTx = r.transactions.find(
            (t) =>
                t.inMessage?.info.dest?.toString() === env.jackpot.address.toString() &&
                t.inMessage.info.src?.toString() === env.keeper.address.toString(),
        )!
        // out = value + r_s - the Jackpot's fee for the submit, up to the forwarding fee of the excess itself
        const expected = env.fees.submit + rewardSubmit - submitTx.totalFees.coins
        expect(out).toBeGreaterThan(expected - 150_000n)
        expect(out).toBeLessThan(expected + 150_000n)
        // a second submit finds the draw over and pays no reward
        const again = await submitDraw(env)
        expect(again.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.notWaitingForRandomness,
        })
    }, 200000)

    it('the float gate does not count the submit’s own value', async () => {
        const sc = await waiting()
        const { env } = sc
        await setBalance(env, env.jackpot.address, env.fees.drawBudget - G('0.05'))
        const g = await balanceOf(env, env.jackpot.address)
        expect(g).toBeLessThan(env.fees.drawBudget)
        expect(g + env.fees.submit).toBeGreaterThan(env.fees.drawBudget)
        const r = await submitDraw(env)
        expect(r.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.floatTooLow,
        })
    }, 200000)

    it('a bounced burn_notification restores x in the new and the old format, and the pending a full burn raised in the new one only: the old format keeps no `last`, so pending stays', async () => {
        for (const format of ['new', 'old'] as const) {
            const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
            const {
                env,
                players: [a],
            } = sc
            await put(env, a, G('100'))
            const w = walletAt(env, a.address)
            const burn = bodyOf(JackpotOp.burn, (b) => b.storeCoins(0n).storeAddress(null).storeMaybeRef(null))
            const [note] = await holdUntil(
                env,
                messageFrom(a.address, w.address, env.fees.withdraw, burn),
                (tx) => tx.inMessage?.info.dest?.toString() === w.address.toString(),
            )
            expect(await w.getWalletState()).toMatchObject({ balance: 0n, pending: 1n })
            const bounced =
                format === 'new'
                    ? beginCell().storeUint(0xfffffffe, 32).storeRef(note.body).endCell()
                    : beginCell().storeUint(0xffffffff, 32).storeBits(note.body.beginParse().loadBits(256)).endCell()
            await deliver(env, {
                info: {
                    type: 'internal',
                    ihrDisabled: true,
                    bounce: false,
                    bounced: true,
                    src: env.jackpot.address,
                    dest: w.address,
                    value: { coins: G('0.2') },
                    ihrFee: 0n,
                    forwardFee: 0n,
                    createdLt: 0n,
                    createdAt: 0,
                },
                body: bounced,
            })
            expect(await w.getWalletState()).toMatchObject({ balance: G('100'), pending: format === 'new' ? 0n : 1n })
        }
    }, 200000)
})

describe('The flag up', () => {
    // a stand-in treasury at 1:1; a boundary at 12:10 makes a pot; the submit is held with its searches on the way,
    // and then a lower quote raises the flag before the searches arrive
    async function flagged() {
        const sc = await fresh({ minDeposit: 1n, players: 3, mint: G('1000'), fake: true, burnBatch: 1n })
        const { env, players } = sc
        await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
        await put(env, players[0], G('300'))
        setNow(env, A0 + 3600)
        await pokeFake(sc, G('12'), G('10')) // a boundary
        expect((await env.jackpot.getDrawState()).state).toBe(DrawState.waiting)
        const outs = await holdUntil(env, await submitMessage(env), atJackpot(env, JackpotOp.submitRandomness))
        return { sc, env, players, outs }
    }

    it('a prize won under the flag goes back into free_tokens and the burn is held', async () => {
        const { sc, env, players, outs } = await flagged()
        const a = players[0]
        expect((await env.jackpot.getDrawState()).state).toBe(DrawState.resolving)
        await pokeFake(sc, G('11'), G('10')) // lower than 12/10: the flag rises
        expect((await jackpotState(env)).falling).toBe(true)
        const h0 = await hgramOf(env, a.address)
        const burner0 = await hgramOf(env, env.burner.address)
        const owedBefore = (await jackpotState(env)).burnOwed
        const logs: ReturnType<typeof slotsIn> = []
        for (const m of outs) logs.push(...slotsIn(await deliver(env, m)))
        expect(logs.filter((x) => x.result === SlotResult.returned)).toHaveLength(3)
        expect(logs.filter((x) => x.result === SlotResult.hit)).toHaveLength(0)
        const s = await jackpotState(env)
        expect(s.carried).toBeGreaterThan(0n)
        expect(s.burnOwed).toBeGreaterThan(0n) // held, not sent
        expect(s.burnOwed).toBe(owedBefore)
        expect(await hgramOf(env, env.burner.address)).toBe(burner0)
        expect(await hgramOf(env, a.address)).toBe(h0) // no prize
        await expectSolvent(env)
    }, 300000)
})

describe('Governor and float rules', () => {
    it('the 7-day rule: with unstaking above 0 and an unstake less than 7 days old, a boundary below float_low unstakes nothing; after 7 days it does', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000'), float: G('7.5') })
        const { env, players } = sc
        await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
        await put(env, players[0], G('300'))
        // the first boundary unstakes, and the unstake is dropped on its way: the counter stays up
        await reward(env, G('30'))
        const b = await env.jackpot.getBoundary()
        setNow(env, b.lastBoundary + b.minGap)
        const outs = await holdUntil(
            env,
            messageFrom(env.keeper.address, env.jackpot.address, env.fees.poke, bodyOf(JackpotOp.poke)),
            atJackpot(env, JackpotOp.takeCurrentQuote),
        )
        // the poke chain stops at the Jackpot's reply; its unstake is dropped
        expect(outs.some((m) => m.body.beginParse().loadUint(32) === JackpotOp.unstakeTokens)).toBe(true)
        expect((await jackpotState(env)).unstakingTokens).toBeGreaterThan(0n)
        expectChainSucceeded(await submitDraw(env))
        // the next boundary: the float is still below float_low, and a draw runs. No unstake.
        const second = await toBoundary(env, G('30'))
        expect(await balanceOf(env, env.jackpot.address)).toBeLessThan(G('8'))
        expect(logsOf<UnstakeLog>(second.externals, LogTopic.unstake)).toHaveLength(0)
        expect(logsOf<BoundaryLog>(second.externals, LogTopic.boundary)[0].unstaked).toBe(0n)
        await submitDraw(env, 1)
        // 8 days later it unstakes again
        await reward(env, G('30'))
        setNow(env, A0 + 8 * 86400)
        const third = await toBoundary(env, 0n)
        expect(logsOf<BoundaryLog>(third.externals, LogTopic.boundary)[0].unstaked).toBeGreaterThan(0n)
    }, 300000)

    it('withdraw_surplus keeps float_high and the node float, and sends the rest to the governor', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000'), float: G('60') })
        const { env, players } = sc
        await put(env, players[0], G('100'))
        const s = await jackpotState(env)
        const g0 = await balanceOf(env, env.governor.address)
        expectChainSucceeded(await env.jackpot.sendWithdrawSurplus(env.governor.getSender(), { value: G('0.05') }))
        const left = await balanceOf(env, env.jackpot.address)
        const target = env.fees.floatHigh + s.nodeFloat
        expect(left).toBeGreaterThanOrEqual(target - G('0.001'))
        expect(left).toBeLessThan(target + G('0.01'))
        expect((await balanceOf(env, env.governor.address)) - g0).toBeGreaterThan(G('30'))
        const denied = await env.jackpot.sendWithdrawSurplus(players[1].getSender(), { value: G('0.05') })
        expect(denied.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.accessDenied,
        })
    }, 200000)

    it('capacity: at next_position = 16,777,216 a new wallet is refused (tree_full) and its tokens return, while a wallet with a position still deposits and withdraws', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 3, mint: G('1000') })
        const { env, players } = sc
        await put(env, players[0], G('100'))
        await setNextPosition(env, 16_777_216n)
        const held = await hgramOf(env, players[1].address)
        const refused = await depositHgram(env, players[1], G('100'), { minC: 0n })
        expect(refused.booking).toBeUndefined()
        expect(logsOf<RefusedLog>(refused.result.externals, LogTopic.refused)[0].reason).toBe(Reason.treeFull)
        expect(await hgramOf(env, players[1].address)).toBe(held)
        expect((await jackpotState(env)).nextPosition).toBe(16_777_216n)
        const again = await put(env, players[0], G('50'))
        expect(again.booking?.b).toBe(0n)
        expectChainSucceeded(await withdraw(env, players[0], G('20')))
        await expectSolvent(env)
    }, 200000)

    it('set_content replaces the metadata, for the governor only', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('10') })
        const { env, players } = sc
        const content = beginCell().storeUint(1, 8).storeStringTail('https://example.com/jgram.json').endCell()
        const denied = await env.jackpot.sendSetContent(players[0].getSender(), { value: G('0.05'), content })
        expect(denied.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.accessDenied,
        })
        const before = (await env.jackpot.getJettonData()).content
        expectChainSucceeded(await env.jackpot.sendSetContent(env.governor.getSender(), { value: G('0.05'), content }))
        const after = (await env.jackpot.getJettonData()).content
        expect(after.equals(content)).toBe(true)
        expect(after.equals(before)).toBe(false)
    }, 100000)

    it('min_pot is honoured: a pot below it sets nothing aside, no draw waits, and the pot stays free; a pot above pays', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const { env, players } = sc
        await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: G('1000') })
        await put(env, players[0], G('300'))
        const before = await jackpotState(env)
        const r = await toBoundary(env, G('30'))
        expectChainSucceeded(r)
        const [log] = logsOf<BoundaryLog>(r.externals, LogTopic.boundary)
        expect(log.prizes).toBeUndefined()
        expect(log.pot).toBeGreaterThan(0n)
        expect((await env.jackpot.getDrawState()).state).toBe(DrawState.none)
        const after = await jackpotState(env)
        expect([after.reservedTokens, after.heldTokens]).toEqual([before.reservedTokens, before.heldTokens])
        // no draw waits, so a submit is refused
        const refused = await submitDraw(env)
        expect(refused.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.notWaitingForRandomness,
        })
        // the next boundary, min_pot back to 1 nano-hGRAM: the pot (and the earlier one with it) pays
        await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
        await toBoundary(env, G('1'))
        const paid = await submitDraw(env, 1)
        expect(slotsIn(paid).filter((x) => x.result === SlotResult.hit)).toHaveLength(3)
    }, 300000)

    it('set_hipo_wallet really moves the wallet the Jackpot listens to', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const { env, players } = sc
        const a = await env.jackpot.getAddresses()
        const other = players[1].address
        // the setter needs the Jackpot halted; the deposit below is refused either way, and resumed it hears the new wallet
        await env.jackpot.sendSetHalted(env.governor.getSender(), { value: G('0.05'), halted: true })
        expectChainSucceeded(
            await env.jackpot.sendSetHipoWallet(env.governor.getSender(), {
                value: G('0.05'),
                parent: a.parent,
                wallet: other,
                walletCode: a.walletCode,
            }),
        )
        expect((await env.jackpot.getAddresses()).wallet.toString()).toBe(other.toString())
        await env.jackpot.sendSetHalted(env.governor.getSender(), { value: G('0.05'), halted: false })
        // the old wallet’s notifications are now strangers’
        const r = await depositHgram(env, players[0], G('100'), { minC: 0n })
        expect(r.booking).toBeUndefined()
        expect((await jackpotState(env)).incomingTokens).toBe(0n)
        // and the new one’s are heard
        const body = beginCell()
            .storeUint(JackpotOp.transferNotification, 32)
            .storeUint(1, 64)
            .storeCoins(G('50'))
            .storeAddress(players[0].address)
            .storeBit(false)
            .endCell()
        await deliver(env, messageFrom(other, env.jackpot.address, env.fees.deposit, body, false))
        // the notification was heard: the tokens are counted as incoming or booked
        expect((await jackpotState(env)).heldTokens).toBe(G('50'))
    }, 200000)
})
