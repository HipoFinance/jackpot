/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests read state they just made */
// End-to-end flows of the Jackpot against Hipo's real treasury, parent and wallet.
import { SandboxContract, TreasuryContract } from '@ton/sandbox'
import '@ton/test-utils'
import { toNano } from '@ton/core'
import {
    BookingLog,
    DrawStartLog,
    DrawState,
    JackpotError,
    JackpotOp,
    LogTopic,
    QuoteKind,
    RandomnessLog,
    SlotLog,
    SlotResult,
    WithdrawalLog,
    logsOf,
} from '../wrappers/Jackpot'
import { roundTime } from '../wrappers/drand'
import {
    Env,
    depositGram,
    depositHgram,
    drawRounds,
    expectChainSucceeded,
    expectSolvent,
    fixtureRound,
    hgramOf,
    jackpotState,
    mintHgram,
    nextRound,
    pendingQuote,
    rangeAt,
    replyQuote,
    resolveDraw,
    setupJackpot,
    startDraw,
    submitRound,
} from './jackpot/setup'

describe('Jackpot', () => {
    let env: Env
    let alice: SandboxContract<TreasuryContract>
    let bob: SandboxContract<TreasuryContract>
    let carol: SandboxContract<TreasuryContract>

    beforeEach(async () => {
        env = await setupJackpot()
        alice = await env.blockchain.treasury('alice')
        bob = await env.blockchain.treasury('bob')
        carol = await env.blockchain.treasury('carol')
    })

    it('books a GRAM deposit: mint, quote, booking, range', async () => {
        const { result, booking } = await depositGram(env, alice, toNano('100'))
        expectChainSucceeded(result)

        const jackpotWallet = await env.hipo.walletAddress(env.jackpot.address)
        // deposit_coins to the treasury, the mint notification from our own wallet, a quote round trip
        expect(result.transactions).toHaveTransaction({
            from: env.jackpot.address,
            to: env.hipo.treasury.address,
            op: JackpotOp.depositCoins,
            success: true,
        })
        expect(result.transactions).toHaveTransaction({
            from: jackpotWallet,
            to: env.jackpot.address,
            op: JackpotOp.transferNotification,
            success: true,
        })
        expect(result.transactions).toHaveTransaction({
            from: env.hipo.treasury.address,
            to: env.jackpot.address,
            op: JackpotOp.takeCurrentQuote,
            success: true,
        })

        const tokens = await hgramOf(env, env.jackpot.address)
        const [tc, tt] = await env.hipo.quote()
        const c = (tokens * tc) / tt
        expect(booking).toBeDefined()
        expect(booking!.owner.equals(alice.address)).toBe(true)
        expect(booking!.start).toBe(0n)
        expect(booking!.principal).toBe(c)
        expect(booking!.tokens).toBe(tokens)

        const s = await jackpotState(env)
        expect(s.totalTokens).toBe(tokens)
        expect(s.inFlight).toBe(0n)
        expect(s.setAside).toBe(0n)
        expect(s.principal).toBe(c)
        expect(s.nextTicket).toBe(c)
        expect([s.quoteCoins, s.quoteTokens]).toEqual([tc, tt])

        const range = rangeAt(env, 0n)
        expect(result.transactions).toHaveTransaction({
            from: env.jackpot.address,
            to: range.address,
            op: JackpotOp.rangeSetup,
            deploy: true,
            success: true,
        })
        const data = await range.getRangeData()
        expect(data.setUp).toBe(true)
        expect(data.owner!.equals(alice.address)).toBe(true)
        expect(data.length).toBe(c)
        expect(data.live).toBe(c)
        expect(await range.getBalance()).toBeGreaterThanOrEqual(toNano('0.1'))
        expect((await env.jackpot.getRangeAddress(0n)).equals(range.address)).toBe(true)

        const books = await env.jackpot.getBooks()
        expect(books.pending.size).toBe(0)
        expect(books.quotes.size).toBe(0)
        await expectSolvent(env)

        // a second booking takes the next range
        const second = await depositGram(env, bob, toNano('20'))
        expect(second.booking!.start).toBe(c)
        await expectSolvent(env)
    })

    it('books an hGRAM deposit', async () => {
        const tokens = await mintHgram(env, alice, toNano('50'))
        await env.hipo.raiseRate('3')
        const { result, booking } = await depositHgram(env, alice, tokens)
        expectChainSucceeded(result)

        const [tc, tt] = await env.hipo.quote()
        expect(booking!.owner.equals(alice.address)).toBe(true)
        expect(booking!.tokens).toBe(tokens)
        expect(booking!.principal).toBe((tokens * tc) / tt)
        expect(await hgramOf(env, alice.address)).toBe(0n)

        const s = await jackpotState(env)
        expect(s.totalTokens).toBe(tokens)
        expect(s.principal).toBe(booking!.principal)
        await expectSolvent(env)
    })

    it('returns an hGRAM deposit that carries too little GRAM, and a booking below the minimum', async () => {
        const tokens = await mintHgram(env, alice, toNano('50'))

        // forward enough to pay the return, not the booking
        const short = await depositHgram(env, alice, tokens / 2n, toNano('0.1'))
        expect(short.booking).toBeUndefined()
        expect(await hgramOf(env, alice.address)).toBe(tokens)

        // 5 GRAM worth is below the 10 GRAM minimum: returned at the booking
        const small = await depositHgram(env, alice, toNano('5'))
        expect(small.booking).toBeUndefined()
        expectChainSucceeded(small.result)
        expect(await hgramOf(env, alice.address)).toBe(tokens)

        const s = await jackpotState(env)
        expect(s.totalTokens).toBe(0n)
        expect(s.principal).toBe(0n)
        expect(s.nextTicket).toBe(0n)
        const { payouts } = await env.jackpot.getBooks()
        expect(payouts.size).toBe(0) // both returns confirmed by alice's wallet

        // the next booking still gets range 0
        const ok = await depositHgram(env, alice, tokens)
        expect(ok.booking!.start).toBe(0n)
    })

    it('refunds a GRAM deposit from the masterchain', async () => {
        const mc = await env.blockchain.treasury('masterchain-player', { workchain: -1 })
        const { result, booking } = await depositGram(env, mc, toNano('100'))
        expect(booking).toBeUndefined()
        expect(result.transactions).toHaveTransaction({ from: env.jackpot.address, to: mc.address, success: true })
        expect(result.transactions).not.toHaveTransaction({ to: env.hipo.treasury.address })
        expect((await jackpotState(env)).totalTokens).toBe(0n)
    })

    it('refunds a GRAM deposit that Hipo refuses, less gas', async () => {
        await env.hipo.setStopped(true)
        const balance = await alice.getBalance()
        const { result, booking } = await depositGram(env, alice, toNano('100'))
        expect(booking).toBeUndefined()
        expect(result.transactions).toHaveTransaction({
            from: env.jackpot.address,
            to: env.hipo.treasury.address,
            op: JackpotOp.depositCoins,
            success: false,
        })
        expect(result.transactions).toHaveTransaction({ from: env.jackpot.address, to: alice.address, success: true })
        // what Alice lost is the part of the fee the Jackpot keeps, and gas
        expect(balance - (await alice.getBalance())).toBeLessThan(env.fees.deposit)
        expect((await env.jackpot.getBooks()).pending.size).toBe(0)
        expect((await jackpotState(env)).totalTokens).toBe(0n)
    })

    it('pays partial and full withdrawals at the latest quote', async () => {
        const { booking } = await depositGram(env, alice, toNano('100'))
        const c = booking!.principal
        await env.hipo.raiseRate('20')

        const range = rangeAt(env, 0n)
        const x = toNano('30')
        const partial = await range.sendWithdraw(alice.getSender(), { value: env.fees.withdraw, amount: x })
        expectChainSucceeded(partial)
        const [tc, tt] = await env.hipo.quote()
        const w1 = (x * tt) / tc
        expect(await hgramOf(env, alice.address)).toBe(w1)
        const log = logsOf<WithdrawalLog>(partial.externals, LogTopic.withdrawal)[0]
        expect(log.principal).toBe(x)
        expect(log.tokens).toBe(w1)
        expect((await range.getRangeData()).live).toBe(c - x)
        // the payout was confirmed by alice's wallet
        expect((await env.jackpot.getBooks()).payouts.size).toBe(0)

        let s = await jackpotState(env)
        expect(s.principal).toBe(c - x)
        await expectSolvent(env)

        // below 1 GRAM, and not the whole live part: refused at the range
        const tiny = await range.sendWithdraw(alice.getSender(), { value: env.fees.withdraw, amount: toNano('0.5') })
        expect(tiny.transactions).toHaveTransaction({
            to: range.address,
            success: false,
            exitCode: JackpotError.invalidParameters,
        })
        // only the owner
        const theft = await range.sendWithdraw(bob.getSender(), { value: env.fees.withdraw, amount: 0n })
        expect(theft.transactions).toHaveTransaction({
            to: range.address,
            success: false,
            exitCode: JackpotError.accessDenied,
        })

        const full = await range.sendWithdraw(alice.getSender(), { value: env.fees.withdraw, amount: 0n })
        expectChainSucceeded(full)
        const w2 = ((c - x) * tt) / tc
        expect(await hgramOf(env, alice.address)).toBe(w1 + w2)
        expect((await range.getRangeData()).live).toBe(0n)
        s = await jackpotState(env)
        expect(s.principal).toBe(0n)
        // what alice got is worth her principal, less at most 1 nano-hGRAM of rounding per withdrawal
        expect(((w1 + w2 + 2n) * tc) / tt).toBeGreaterThanOrEqual(c)
        await expectSolvent(env)

        // nothing left to withdraw
        const again = await range.sendWithdraw(alice.getSender(), { value: env.fees.withdraw, amount: 0n })
        expect(again.transactions).toHaveTransaction({ to: range.address, success: false })
    })

    it('opens an empty first period, then runs a full draw: three winners paid, burn batched to the burner', async () => {
        const players = [alice, bob, carol]
        for (const p of players) await depositGram(env, p, toNano('1000'))

        // first start: nobody eligible yet (E = 0), the period opens and the pot rolls over
        await nextRound(env, toNano('30'))
        const first = await startDraw(env)
        expectChainSucceeded(first)
        let draw = await env.jackpot.getDrawState()
        expect(draw.state).toBe(DrawState.idle)
        expect(draw.drawId).toBe(0n)
        const opened = logsOf<DrawStartLog>(first.externals, LogTopic.drawStart)[0]
        expect(opened.cutoff).toBe(0n)
        expect(opened.pot).toBe(0n)
        let s = await jackpotState(env)
        expect(s.cutoff).toBe(s.nextTicket)
        expect(s.setAside).toBe(0n)

        // not twice in one validation round
        const twice = await startDraw(env)
        expect(twice.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.roundNotChanged,
        })

        // a late joiner books after the period opened: not eligible for the next draw
        const late = await depositGram(env, await env.blockchain.treasury('late'), toNano('1000'))
        expect(late.booking!.start).toBe(s.cutoff)

        // the second start draws for real; the pot is small, so its burn waits for the batch
        await nextRound(env, toNano('30'))
        const R0 = drawRounds[0]
        const second = await startDraw(env, roundTime(R0) - 60)
        expectChainSucceeded(second)
        const started = logsOf<DrawStartLog>(second.externals, LogTopic.drawStart)[0]
        draw = await env.jackpot.getDrawState()
        expect(draw.state).toBe(DrawState.waiting)
        expect(draw.drawId).toBe(1n)
        expect(draw.round).toBe(BigInt(R0))
        expect(draw.cutoff).toBe(s.cutoff)
        expect(started.burn).toBe((started.pot * 1000n) / 10000n)
        const rest = started.pot - started.burn
        expect(draw.prizes).toEqual([
            (rest * 5000n) / 10000n,
            (rest * 3000n) / 10000n,
            rest - (rest * 5000n) / 10000n - (rest * 3000n) / 10000n,
        ])
        s = await jackpotState(env)
        expect(s.setAside).toBe(started.pot)
        expect(s.burnOwed).toBe(started.burn)
        expect(started.burn).toBeLessThan(s.burnBatch)
        await expectSolvent(env)

        const randomness = await submitRound(env, R0)
        expectChainSucceeded(randomness)
        const seed = logsOf<RandomnessLog>(randomness.externals, LogTopic.randomness)[0].seed
        expect(seed).toBe(BigInt('0x' + fixtureRound(R0).randomness))

        const before = await Promise.all(players.map((p) => hgramOf(env, p.address)))
        const results = await resolveDraw(env)
        const slots = results.flatMap((r) => logsOf<SlotLog>(r.externals, LogTopic.slot))
        const hits = slots.filter((l) => l.result === SlotResult.hit)
        expect(hits.length).toBe(3)
        for (const r of results) expectChainSucceeded(r)
        // every winning ticket is below the cutoff, so the late joiner never wins
        for (const h of hits) expect(h.ticket).toBeLessThan(draw.cutoff)

        const after = await Promise.all(players.map((p) => hgramOf(env, p.address)))
        const won = after.map((a, i) => a - before[i])
        expect(won.reduce((a, b) => a + b, 0n)).toBe(rest)
        for (const h of hits) expect(h.amount).toBe(draw.prizes[h.slot])

        draw = await env.jackpot.getDrawState()
        expect(draw.state).toBe(DrawState.idle)
        s = await jackpotState(env)
        expect(s.setAside).toBe(started.burn)
        expect(await hgramOf(env, env.burner.address)).toBe(0n)
        expect((await env.jackpot.getBooks()).payouts.size).toBe(0)
        await expectSolvent(env)

        // a bigger round: the burn owed passes the 50 hGRAM batch and goes to the burner with 0.5 GRAM
        await nextRound(env, toNano('2000'))
        const R1 = drawRounds[1]
        const third = await startDraw(env, roundTime(R1) - 60)
        const started2 = logsOf<DrawStartLog>(third.externals, LogTopic.drawStart)[0]
        expect(started2.cutoff).toBe(started.nextCutoff)
        await submitRound(env, R1)
        const results2 = await resolveDraw(env)
        const owed = started.burn + started2.burn
        expect(owed).toBeGreaterThanOrEqual(toNano('50'))
        const last = results2[results2.length - 1]
        expectChainSucceeded(last)
        expect(last.transactions).toHaveTransaction({
            from: await env.hipo.walletAddress(env.burner.address),
            to: env.burner.address,
            op: JackpotOp.transferNotification,
            value: (v) => v != null && v >= toNano('0.5') - toNano('0.001') && v <= toNano('0.5'),
        })
        expect(await hgramOf(env, env.burner.address)).toBe(owed)
        s = await jackpotState(env)
        expect(s.burnOwed).toBe(0n)
        expect(s.setAside).toBe(0n)
        expect((await env.jackpot.getBooks()).payouts.size).toBe(0)
        await expectSolvent(env)
    })

    it('stops deposits and draw starts while halted; withdrawals and a running draw go on', async () => {
        await depositGram(env, alice, toNano('500'))
        await depositGram(env, bob, toNano('500'))
        await nextRound(env, toNano('30'))
        await startDraw(env) // opens the first period
        await nextRound(env, toNano('30'))
        const R0 = drawRounds[0]
        await startDraw(env, roundTime(R0) - 60)
        expect((await env.jackpot.getDrawState()).state).toBe(DrawState.waiting)

        // only the governor resumes; the halter can only stop
        await env.jackpot.sendSetHalted(env.halter.getSender(), { value: toNano('0.05'), halted: true })
        expect((await jackpotState(env)).halted).toBe(true)
        const resume = await env.jackpot.sendSetHalted(env.halter.getSender(), { value: toNano('0.05'), halted: false })
        expect(resume.transactions).toHaveTransaction({ success: false, exitCode: JackpotError.accessDenied })

        // GRAM deposit bounces
        const gram = await env.jackpot.sendDeposit(carol.getSender(), { value: toNano('100') + env.fees.deposit })
        expect(gram.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.halted,
        })
        // hGRAM deposit goes back
        const tokens = await mintHgram(env, carol, toNano('50'))
        const hgram = await depositHgram(env, carol, tokens)
        expect(hgram.booking).toBeUndefined()
        expect(await hgramOf(env, carol.address)).toBe(tokens)

        // the running draw completes
        await submitRound(env, R0)
        const results = await resolveDraw(env)
        const hits = results.flatMap((r) => logsOf<SlotLog>(r.externals, LogTopic.slot))
        expect(hits.filter((h) => h.result === SlotResult.hit).length).toBe(3)
        expect((await env.jackpot.getDrawState()).state).toBe(DrawState.idle)

        // no new draw
        await nextRound(env, toNano('30'))
        const refused = await startDraw(env)
        expect(refused.transactions).toHaveTransaction({ success: false, exitCode: JackpotError.halted })

        // withdrawals still pay
        const before = await hgramOf(env, alice.address)
        const w = await rangeAt(env, 0n).sendWithdraw(alice.getSender(), { value: env.fees.withdraw, amount: 0n })
        expectChainSucceeded(w)
        expect(await hgramOf(env, alice.address)).toBeGreaterThan(before)

        await env.jackpot.sendSetHalted(env.governor.getSender(), { value: toNano('0.05'), halted: false })
        const resumed = await startDraw(env)
        expectChainSucceeded(resumed)
        await expectSolvent(env)
    })

    it('refuses b above 2000', async () => {
        const r = await env.jackpot.sendSetBurnShare(env.governor.getSender(), {
            value: toNano('0.05'),
            burnShare: 2001n,
        })
        expect(r.transactions).toHaveTransaction({ success: false, exitCode: JackpotError.invalidParameters })
        await env.jackpot.sendSetBurnShare(env.governor.getSender(), { value: toNano('0.05'), burnShare: 2000n })
        expect((await jackpotState(env)).burnShare).toBe(2000n)
    })
})

// The Jackpot asks a stand-in for quotes, so the test decides when a reply comes, and at what rate.
describe('Jackpot with a stand-in treasury', () => {
    let env: Env
    let alice: SandboxContract<TreasuryContract>
    let bob: SandboxContract<TreasuryContract>
    const rate = (n: bigint) => [n, 1000n] as const // coins per 1000 tokens

    beforeEach(async () => {
        env = await setupJackpot({ fakeTreasury: true })
        alice = await env.blockchain.treasury('alice')
        bob = await env.blockchain.treasury('bob')
    })

    async function book(player: SandboxContract<TreasuryContract>, gram: bigint, coins: bigint, tokens: bigint) {
        const minted = await mintHgram(env, player, gram)
        await depositHgram(env, player, minted)
        const id = await pendingQuote(env, QuoteKind.booking)
        const result = await replyQuote(env, id, coins, tokens)
        const booked = logsOf<BookingLog>(result.externals, LogTopic.booking)
        env.bookings.push(...booked)
        return { minted, booking: booked.length > 0 ? booked[0] : undefined, result }
    }

    it('recovers a lost quote reply with requote, for a booking, a withdrawal and a draw start', async () => {
        // booking
        const tokens = await mintHgram(env, alice, toNano('100'))
        await depositHgram(env, alice, tokens)
        const lost = await pendingQuote(env, QuoteKind.booking)

        const early = await env.jackpot.sendRequote(env.keeper.getSender(), { value: env.fees.requote, target: lost })
        expect(early.transactions).toHaveTransaction({ success: false, exitCode: JackpotError.tooSoon })

        env.blockchain.now! += 600
        const requote = await env.jackpot.sendRequote(env.keeper.getSender(), {
            value: env.fees.requote,
            target: lost,
        })
        expectChainSucceeded(requote)
        const fresh = await pendingQuote(env, QuoteKind.booking)
        expect(fresh).not.toBe(lost)
        // asked again
        expect(requote.transactions).toHaveTransaction({
            from: env.jackpot.address,
            to: env.fakeTreasury!.address,
            op: JackpotOp.provideCurrentQuote,
        })

        // the late reply to the voided id books nothing
        const late = await replyQuote(env, lost, ...rate(1100n))
        expect(logsOf<BookingLog>(late.externals, LogTopic.booking).length).toBe(0)
        expect((await jackpotState(env)).principal).toBe(0n)

        // the live one books once; a repeat finds no record
        const reply = await replyQuote(env, fresh, ...rate(1100n))
        const booked = logsOf<BookingLog>(reply.externals, LogTopic.booking)
        expect(booked.length).toBe(1)
        expect(booked[0].principal).toBe((tokens * 1100n) / 1000n)
        env.bookings.push(booked[0])
        const repeat = await replyQuote(env, fresh, ...rate(1100n))
        expect(logsOf<BookingLog>(repeat.externals, LogTopic.booking).length).toBe(0)
        expect((await jackpotState(env)).principal).toBe(booked[0].principal)

        // withdrawal
        const x = toNano('20')
        await rangeAt(env, 0n).sendWithdraw(alice.getSender(), { value: env.fees.withdraw, amount: x })
        const lostW = await pendingQuote(env, QuoteKind.withdrawal)
        env.blockchain.now! += 600
        await env.jackpot.sendRequote(env.keeper.getSender(), { value: env.fees.requote, target: lostW })
        const freshW = await pendingQuote(env, QuoteKind.withdrawal)
        await replyQuote(env, lostW, ...rate(1100n))
        expect(await hgramOf(env, alice.address)).toBe(0n)
        await replyQuote(env, freshW, ...rate(1100n))
        await replyQuote(env, freshW, ...rate(1100n))
        expect(await hgramOf(env, alice.address)).toBe((x * 1000n) / 1100n)
        expect((await jackpotState(env)).principal).toBe(booked[0].principal - x)

        // draw start
        await env.hipo.nextValidationRound()
        await startDraw(env)
        const lostD = await pendingQuote(env, QuoteKind.draw)
        expect((await env.jackpot.getDrawState()).queryId).toBe(lostD)
        env.blockchain.now! += 600
        await env.jackpot.sendRequote(env.keeper.getSender(), { value: env.fees.requote, target: lostD })
        const freshD = await pendingQuote(env, QuoteKind.draw)
        expect((await env.jackpot.getDrawState()).queryId).toBe(freshD)
        await replyQuote(env, lostD, ...rate(1300n))
        expect((await env.jackpot.getDrawState()).state).toBe(DrawState.quoting)
        const opened = await replyQuote(env, freshD, ...rate(1300n))
        expect(logsOf<DrawStartLog>(opened.externals, LogTopic.drawStart).length).toBe(1)
        expect((await env.jackpot.getDrawState()).state).toBe(DrawState.idle)
        expect((await env.jackpot.getBooks()).quotes.size).toBe(0)
        await expectSolvent(env)
    })

    it('handles a falling rate: pro-rata withdrawals, no draw starts, prizes held, bookings returned', async () => {
        const a = await book(alice, toNano('1000'), ...rate(1100n))
        const b = await book(bob, toNano('1000'), ...rate(1100n))
        expect(a.booking).toBeDefined()
        expect(b.booking).toBeDefined()

        // open the first period, then start a real draw at a higher rate
        await env.hipo.nextValidationRound()
        await startDraw(env)
        await replyQuote(env, await pendingQuote(env, QuoteKind.draw), ...rate(1200n))
        await env.hipo.nextValidationRound()
        const R0 = drawRounds[0]
        await startDraw(env, roundTime(R0) - 60)
        await replyQuote(env, await pendingQuote(env, QuoteKind.draw), ...rate(1300n))
        const draw = await env.jackpot.getDrawState()
        expect(draw.state).toBe(DrawState.waiting)
        await submitRound(env, R0)

        // a withdrawal's quote comes back lower: the flag goes up, and the payout is pro-rata
        const x = toNano('100')
        await rangeAt(env, a.booking!.start).sendWithdraw(alice.getSender(), { value: env.fees.withdraw, amount: x })
        let s = await jackpotState(env)
        const free = s.totalTokens - s.inFlight - s.setAside
        const P = s.principal
        await replyQuote(env, await pendingQuote(env, QuoteKind.withdrawal), ...rate(900n))
        s = await jackpotState(env)
        expect(s.falling).toBe(true)
        expect([s.quoteCoins, s.quoteTokens]).toEqual([900n, 1000n])
        const proRata = (free * x) / P
        expect(proRata).toBeLessThan((x * 1000n) / 900n)
        expect(await hgramOf(env, alice.address)).toBe(proRata)

        // the running draw resolves, but its prizes are held as claims, not paid
        const results = await resolveDraw(env)
        const slots = results.flatMap((r) => logsOf<SlotLog>(r.externals, LogTopic.slot))
        expect(slots.filter((l) => l.result === SlotResult.held).length).toBe(3)
        expect(slots.filter((l) => l.result === SlotResult.hit).length).toBe(0)
        const held = new Map<string, bigint>()
        for (const l of slots) held.set(l.owner!.toString(), (held.get(l.owner!.toString()) ?? 0n) + l.amount)
        const winner = [alice, bob].find((p) => held.has(p.address.toString()))!
        const owed = held.get(winner.address.toString())!
        expect(await env.jackpot.getClaimable(winner.address)).toBe(owed)
        expect(await hgramOf(env, winner.address)).toBe(winner === alice ? proRata : 0n)

        // no claim, no draw start, and a new booking is returned
        const claim = await env.jackpot.sendClaim(winner.getSender(), { value: env.fees.claim })
        expect(claim.transactions).toHaveTransaction({ success: false, exitCode: JackpotError.rateFalling })
        await env.hipo.nextValidationRound()
        const refused = await startDraw(env)
        expect(refused.transactions).toHaveTransaction({ success: false, exitCode: JackpotError.rateFalling })
        const carol = await env.blockchain.treasury('carol')
        const c = await book(carol, toNano('100'), ...rate(950n))
        expect(c.booking).toBeUndefined()
        expect(await hgramOf(env, carol.address)).toBe(c.minted)

        // only the governor clears the flag; then the held prize is claimed, once
        const notGovernor = await env.jackpot.sendClearFalling(alice.getSender(), { value: toNano('0.05') })
        expect(notGovernor.transactions).toHaveTransaction({ success: false, exitCode: JackpotError.accessDenied })
        await env.jackpot.sendClearFalling(env.governor.getSender(), { value: toNano('0.05') })
        expect((await jackpotState(env)).falling).toBe(false)
        const before = await hgramOf(env, winner.address)
        const paid = await env.jackpot.sendClaim(winner.getSender(), { value: env.fees.claim })
        expectChainSucceeded(paid)
        expect(await hgramOf(env, winner.address)).toBe(before + owed)
        const twice = await env.jackpot.sendClaim(winner.getSender(), { value: env.fees.claim })
        expect(twice.transactions).toHaveTransaction({ success: false, exitCode: JackpotError.nothingToClaim })
        expect(await hgramOf(env, winner.address)).toBe(before + owed)
        expect((await env.jackpot.getBooks()).payouts.size).toBe(0)
    })
})
