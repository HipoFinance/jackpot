/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests read state they just made */
// The acceptance criteria of docs/specs/2026-10-27-jackpot-v1.md, one group per criterion, named after it,
// against Hipo's real treasury, parent and wallet (or a stand-in treasury where the test must choose the
// rate). A test marked openBug asserts what the criterion asks and fails today; SHOW_BUGS=1 runs it as a
// plain test so that its failure prints.
import { Message, Transaction, beginCell, toNano } from '@ton/core'
import '@ton/test-utils'
import {
    BookingLog,
    DrawStartLog,
    DrawState,
    JackpotError,
    JackpotOp,
    LogTopic,
    QuoteKind,
    SlotLog,
    SlotResult,
    logsOf,
} from '../wrappers/Jackpot'
import { BLS12_381_P, DrandError, buildWitness, roundTime } from '../wrappers/drand'
import { getConfig } from './hipo/chain'
import { ParticipationState } from './hipo/Treasury'
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
import {
    Player,
    breakWalletOf,
    checkBody,
    counters,
    dataHash,
    deliver,
    drawReady,
    failed,
    gasExcessBody,
    hitBody,
    isTo,
    jackpotWallet,
    missBody,
    msg,
    opBody,
    queryIdOfMessage,
    rangeOf,
    rangeSetupBody,
    sendTokensBody,
    setParticipations,
    setWalletTokens,
    setupAt,
    submitBody,
    ticketOf,
    walletTokens,
} from './jackpot/adversary'
import { SequenceResult, drandRounds, makeWorld, runSequence } from './jackpot/sequences'

const openBug = process.env.SHOW_BUGS != null ? it : it.failing

let env: Env
let alice: Player
let bob: Player
let carol: Player
let mallory: Player

async function players() {
    alice = await env.blockchain.treasury('alice')
    bob = await env.blockchain.treasury('bob')
    carol = await env.blockchain.treasury('carol')
    mallory = await env.blockchain.treasury('mallory')
}

const jackpotHash = () => dataHash(env.blockchain, env.jackpot.address)

// Plays the keeper until the draw is idle, using the bookings known to env.
async function resolveAll() {
    return resolveDraw(env)
}

function slotLogs(results: { externals: { info: { dest?: unknown }; body: unknown }[] }[]): SlotLog[] {
    return results.flatMap((r) => logsOf<SlotLog>(r.externals as never, LogTopic.slot))
}

function gasOf(tx: Transaction): bigint {
    return tx.description.type === 'generic' && tx.description.computePhase.type === 'vm'
        ? tx.description.computePhase.gasUsed
        : 0n
}

describe('AC 1–2: property test (short run here; the long run is tests/Property.spec.ts)', () => {
    const results: SequenceResult[] = []
    let error: unknown

    beforeAll(async () => {
        const world = await makeWorld()
        try {
            for (let seed = 1; seed <= 3; seed++) results.push(await runSequence(world, seed))
        } catch (e) {
            error = e
        }
    }, 300_000)

    it('random sequences of deposits, withdrawals, rate rises and draws keep F·TC ≥ P·TT and the real wallet ≥ T after every transaction', () => {
        expect(error).toBeUndefined()
        expect(results.length).toBe(3)
        expect(results.reduce((a, r) => a + r.transactions, 0)).toBeGreaterThan(0)
    })

    it('after full withdrawals by every player, each received hGRAM worth ≥ principal less 1 nano-hGRAM per withdrawal', () => {
        // runSequence ends every sequence with this check, and with no payout left unconfirmed
        expect(error).toBeUndefined()
        expect(results.reduce((a, r) => a + r.withdrawals, 0)).toBeGreaterThan(0)
    })
})

describe('AC 3: a rate drop pays withdrawals pro-rata, refuses draw starts, holds prizes and returns bookings until the governor clears the flag', () => {
    const rate = (n: bigint) => [n, 1000n] as const

    beforeEach(async () => {
        env = await setupJackpot({ fakeTreasury: true })
        await players()
    })

    async function book(p: Player, gram: bigint, coins: bigint) {
        const minted = await mintHgram(env, p, gram)
        await depositHgram(env, p, minted)
        const result = await replyQuote(env, await pendingQuote(env, QuoteKind.booking), coins, 1000n)
        const booked = logsOf<BookingLog>(result.externals, LogTopic.booking)
        env.bookings.push(...booked)
        return { minted, booking: booked.length > 0 ? booked[0] : undefined }
    }

    it('holds everything back while the flag is up, and resumes after clear_falling', async () => {
        const a = await book(alice, toNano('1000'), 1100n)
        await book(bob, toNano('1000'), 1100n)
        await env.hipo.nextValidationRound()
        await startDraw(env)
        await replyQuote(env, await pendingQuote(env, QuoteKind.draw), ...rate(1200n))
        await env.hipo.nextValidationRound()
        await startDraw(env, roundTime(drawRounds[0]) - 60)
        await replyQuote(env, await pendingQuote(env, QuoteKind.draw), ...rate(1300n))
        await submitRound(env, drawRounds[0])

        // the rate falls: the withdrawal is paid its pro-rata share of F, not x at the new rate
        const x = toNano('100')
        await rangeAt(env, a.booking!.start).sendWithdraw(alice.getSender(), { value: env.fees.withdraw, amount: x })
        const s0 = await counters(env)
        const F = s0.T - s0.I - s0.O
        await replyQuote(env, await pendingQuote(env, QuoteKind.withdrawal), ...rate(900n))
        let c = await counters(env)
        expect(c.falling).toBe(true)
        expect(await hgramOf(env, alice.address)).toBe((F * x) / s0.P)
        expect((F * x) / s0.P).toBeLessThan((x * 1000n) / 900n)

        // prizes held as claims
        const logs = slotLogs(await resolveAll())
        expect(logs.filter((l) => l.result === SlotResult.held).length).toBe(3)
        expect(logs.filter((l) => l.result === SlotResult.hit).length).toBe(0)
        const winners = [...new Set(logs.map((l) => l.owner!.toString()))]
        const winner = [alice, bob].find((p) => p.address.toString() === winners[0])!
        const owed = logs.filter((l) => l.owner!.equals(winner.address)).reduce((s, l) => s + l.amount, 0n)
        expect(await env.jackpot.getClaimable(winner.address)).toBe(owed)
        const claim = await env.jackpot.sendClaim(winner.getSender(), { value: env.fees.claim })
        expect(claim.transactions).toHaveTransaction({ success: false, exitCode: JackpotError.rateFalling })
        // draw starts refused
        await env.hipo.nextValidationRound()
        const refused = await startDraw(env)
        expect(refused.transactions).toHaveTransaction({ success: false, exitCode: JackpotError.rateFalling })
        // a new booking is returned, even at a rate above the fallen one
        const c1 = await book(carol, toNano('100'), 950n)
        expect(c1.booking).toBeUndefined()
        expect(await hgramOf(env, carol.address)).toBe(c1.minted)
        // the burn is held too
        c = await counters(env)
        expect((await jackpotState(env)).burnOwed).toBeGreaterThan(0n)

        // only the governor clears it; then all of it resumes
        const notGovernor = await env.jackpot.sendClearFalling(mallory.getSender(), { value: toNano('0.05') })
        expect(notGovernor.transactions).toHaveTransaction({ success: false, exitCode: JackpotError.accessDenied })
        await env.jackpot.sendClearFalling(env.governor.getSender(), { value: toNano('0.05') })
        const before = await hgramOf(env, winner.address)
        expectChainSucceeded(await env.jackpot.sendClaim(winner.getSender(), { value: env.fees.claim }))
        expect(await hgramOf(env, winner.address)).toBe(before + owed)
        const c2 = await book(carol, toNano('100'), 950n)
        expect(c2.booking).toBeDefined()
        await startDraw(env)
        expect((await env.jackpot.getDrawState()).state).toBe(DrawState.quoting)
        expect(c.falling).toBe(true)
    })
})

describe('AC 4: a range booked after a draw starts is never paid by that draw or the next one', () => {
    beforeEach(async () => {
        env = await setupJackpot()
        await players()
    })

    it('the late range is refused by locate, answers no forced check, and wins nothing in either draw', async () => {
        await depositGram(env, alice, toNano('1000'))
        await depositGram(env, bob, toNano('1000'))
        await nextRound(env, toNano('30'))
        await startDraw(env) // opens the first period
        await nextRound(env, toNano('30'))
        await startDraw(env, roundTime(drawRounds[0]) - 60)
        // carol books after draw 1 started, with far more than everyone else
        const { booking: late } = await depositGram(env, carol, toNano('100000'))
        const s = await jackpotState(env)
        expect(late!.start).toBeGreaterThanOrEqual(s.cutoff) // ≥ the next draw's E too

        for (const [i, round] of drawRounds.entries()) {
            if (i === 1) {
                await nextRound(env, toNano('300'))
                await startDraw(env, roundTime(round) - 60)
            }
            await submitRound(env, round)
            const draw = await env.jackpot.getDrawState()
            expect(late!.start).toBeGreaterThanOrEqual(draw.cutoff)
            // every attempt of every slot lands below E, so never on the late range
            for (const slot of [0, 1, 2]) {
                for (let j = 0; j < 64; j++) expect(ticketOf(draw.seed, slot, j, draw.cutoff)).toBeLessThan(late!.start)
            }
            const before = await hgramOf(env, carol.address)
            for (const slot of [0, 1, 2]) {
                // the keeper (or carol) names the late range: refused before anything is asked
                const named = await env.jackpot.sendLocate(carol.getSender(), {
                    value: env.fees.locate,
                    slot,
                    start: late!.start,
                })
                expect(named.transactions).toHaveTransaction({
                    to: env.jackpot.address,
                    success: false,
                    exitCode: JackpotError.ticketOutOfRange,
                })
                // forced: the late range is asked, as if by the Jackpot, about its own first ticket; it says
                // hit, and the Jackpot ignores it because that is not the ticket it drew
                const hash = await jackpotHash()
                const forced = await deliver(
                    env.blockchain,
                    msg(
                        env.jackpot.address,
                        rangeAt(env, late!.start).address,
                        toNano('0.1'),
                        checkBody({
                            draw: draw.drawId,
                            slot,
                            j: draw.attempts[slot],
                            r: late!.start,
                            start: late!.start,
                        }),
                    ),
                )
                expect(forced.transactions).toHaveTransaction({
                    from: rangeAt(env, late!.start).address,
                    to: env.jackpot.address,
                    op: JackpotOp.hit,
                })
                expect(await jackpotHash()).toBe(hash)
            }
            const logs = slotLogs(await resolveAll())
            for (const l of logs) expect(l.owner?.equals(carol.address) ?? false).toBe(false)
            expect(await hgramOf(env, carol.address)).toBe(before)
        }
    })
})

describe("AC 5: check to one's own range, hit or miss straight to the Jackpot, and a second hit change nothing", () => {
    beforeEach(async () => {
        env = await setupJackpot()
        await players()
        await drawReady(env, [
            [alice, toNano('1000')],
            [bob, toNano('1000')],
        ])
    })

    it('no prize is paid and no attempt advances; a second hit for a closed slot pays nothing', async () => {
        const draw = await env.jackpot.getDrawState()
        const hash = await jackpotHash()
        const r = await env.jackpot.getTicket(0)
        const range = rangeOf(env, r)!
        const owner = range.owner.equals(alice.address) ? alice : bob
        const own = await owner.send({
            to: rangeAt(env, range.start).address,
            value: toNano('1'),
            body: checkBody({ draw: draw.drawId, slot: 0, j: 0, r, start: range.start }),
        })
        expect(own.transactions).toHaveTransaction({
            to: rangeAt(env, range.start).address,
            success: false,
            exitCode: JackpotError.accessDenied,
        })
        await owner.send({
            to: env.jackpot.address,
            value: toNano('1'),
            body: hitBody({ draw: draw.drawId, slot: 0, j: 0, r, start: range.start, owner: owner.address }),
        })
        await owner.send({
            to: env.jackpot.address,
            value: toNano('1'),
            body: missBody({ draw: draw.drawId, slot: 0, j: 0, r, start: range.start }),
        })
        expect(await jackpotHash()).toBe(hash)
        expect(await env.jackpot.getDrawState()).toEqual(draw)

        // the real hit closes slot 0; replaying the hit, even from the range itself, pays nothing
        const before = await hgramOf(env, owner.address)
        const located = await deliver(
            env.blockchain,
            msg(
                env.keeper.address,
                env.jackpot.address,
                env.fees.locate,
                opBody(JackpotOp.locate, [0, 8], [range.start, 128]),
            ),
        )
        expect(logsOf<SlotLog>(located.externals, LogTopic.slot)[0].result).toBe(SlotResult.hit)
        const paid = (await hgramOf(env, owner.address)) - before
        expect(paid).toBe(draw.prizes[0])
        const hash2 = await jackpotHash()
        await deliver(
            env.blockchain,
            msg(
                rangeAt(env, range.start).address,
                env.jackpot.address,
                toNano('0.1'),
                hitBody({ draw: draw.drawId, slot: 0, j: 0, r, start: range.start, owner: owner.address }),
            ),
        )
        expect(await jackpotHash()).toBe(hash2)
        expect(await hgramOf(env, owner.address)).toBe(before + paid)
    })
})

describe('AC 6: a range setup comes only from the Jackpot, once; a deposit below the minimum is returned and the next booking gets its range', () => {
    beforeEach(async () => {
        env = await setupJackpot()
        await players()
    })

    it("refuses a stranger's and a second setup, returns a small deposit, and books and pays the next one", async () => {
        const range0 = rangeAt(env, 0n)
        const squat = await mallory.send({
            to: range0.address,
            value: toNano('0.2'),
            init: range0.init,
            body: rangeSetupBody(mallory.address, toNano('1000')),
        })
        expect(squat.transactions).toHaveTransaction({
            to: range0.address,
            success: false,
            exitCode: JackpotError.accessDenied,
        })

        const tokens = await mintHgram(env, alice, toNano('5'))
        const small = await depositHgram(env, alice, tokens)
        expect(small.booking).toBeUndefined()
        expect(await hgramOf(env, alice.address)).toBe(tokens)
        const gram = await env.jackpot.sendDeposit(alice.getSender(), { value: toNano('9') + env.fees.deposit })
        expect(gram.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.depositTooSmall,
        })

        const { booking } = await depositGram(env, bob, toNano('20'))
        expect(booking!.start).toBe(0n)
        const second = await deliver(
            env.blockchain,
            msg(env.jackpot.address, range0.address, toNano('0.2'), rangeSetupBody(mallory.address, 1n)),
        )
        expect(second.transactions).toHaveTransaction({
            to: range0.address,
            success: false,
            exitCode: JackpotError.alreadySetUp,
        })
        const w = await range0.sendWithdraw(bob.getSender(), { value: env.fees.withdraw, amount: 0n })
        expectChainSucceeded(w)
        expect(await hgramOf(env, bob.address)).toBeGreaterThan(0n)
        expect((await jackpotState(env)).principal).toBe(0n)
    })
})

describe('AC 7: every entry message below its minimum is refused with no state change; start_draw, locate, requote and withdraw run to the end on the bare minimum', () => {
    beforeEach(async () => {
        env = await setupJackpot()
        await players()
    })

    it('refuses each one a nano-GRAM short', async () => {
        await drawReady(env, [
            [alice, toNano('1000')],
            [bob, toNano('1000')],
        ])
        const short = (fee: bigint) => fee - 1n
        const range0 = rangeAt(env, 0n)
        const hash = await jackpotHash()
        const rangeHash = await dataHash(env.blockchain, range0.address)
        const sends = [
            () => env.jackpot.sendDeposit(alice.getSender(), { value: short(env.fees.deposit) }),
            () => env.jackpot.sendStartDraw(alice.getSender(), { value: short(env.fees.startDraw) }),
            () =>
                env.jackpot.sendSubmitRandomness(alice.getSender(), {
                    value: short(env.fees.submitRandomness),
                    signature: beginCell().endCell(),
                    witness: beginCell().endCell(),
                }),
            () => env.jackpot.sendLocate(alice.getSender(), { value: short(env.fees.locate), slot: 0, start: 0n }),
            () => env.jackpot.sendRequote(alice.getSender(), { value: short(env.fees.requote), target: 1n }),
            () => env.jackpot.sendExpire(alice.getSender(), { value: short(env.fees.expire), slot: 0 }),
            () => env.jackpot.sendClaim(alice.getSender(), { value: short(env.fees.claim) }),
            () => range0.sendWithdraw(alice.getSender(), { value: short(env.fees.withdraw), amount: 0n }),
        ]
        for (const send of sends) {
            const result = await send()
            expect(result.transactions).toHaveTransaction({ success: false, exitCode: JackpotError.insufficientFee })
        }
        expect(await jackpotHash()).toBe(hash)
        expect(await dataHash(env.blockchain, range0.address)).toBe(rangeHash)

        // an hGRAM deposit whose forward is short of the fee is not booked: it goes back
        const tokens = await mintHgram(env, carol, toNano('50'))
        const c = await counters(env)
        const h = await depositHgram(env, carol, tokens, env.fees.hgramDeposit - 1n)
        expect(h.booking).toBeUndefined()
        expect(await hgramOf(env, carol.address)).toBe(tokens)
        expect(await counters(env)).toMatchObject({ T: c.T, I: c.I, O: c.O, P: c.P, N: c.N })
    })

    it('runs start_draw, locate, requote and withdraw to the end on exactly their fee', async () => {
        await depositGram(env, alice, toNano('1000'))
        await depositGram(env, bob, toNano('1000'))
        await nextRound(env, toNano('30'))
        expectChainSucceeded(await env.jackpot.sendStartDraw(mallory.getSender(), { value: env.fees.startDraw }))
        await nextRound(env, toNano('30'))
        env.blockchain.now = roundTime(drawRounds[0]) - 60
        expectChainSucceeded(await env.jackpot.sendStartDraw(mallory.getSender(), { value: env.fees.startDraw }))
        expect((await env.jackpot.getDrawState()).state).toBe(DrawState.waiting)
        await submitRound(env, drawRounds[0])
        for (let guard = 0; guard < 200; guard++) {
            const d = await env.jackpot.getDrawState()
            if (d.openSlots === 0) break
            const slot = [0, 1, 2].find((i) => (d.openSlots >> i) & 1)!
            const t = await env.jackpot.getTicket(slot)
            const res = await env.jackpot.sendLocate(mallory.getSender(), {
                value: env.fees.locate,
                slot,
                start: rangeOf(env, t)!.start,
            })
            expectChainSucceeded(res)
            expect(logsOf<SlotLog>(res.externals, LogTopic.slot).length).toBe(1)
        }
        expect((await env.jackpot.getDrawState()).state).toBe(DrawState.idle)
        const w = await rangeAt(env, 0n).sendWithdraw(alice.getSender(), {
            value: env.fees.withdraw,
            amount: toNano('5'),
        })
        expectChainSucceeded(w)
        expect(logsOf(w.externals, LogTopic.withdrawal).length).toBe(1)
        // requote: a withdrawal whose reply is dropped
        const lost = await deliver(
            env.blockchain,
            msg(
                alice.address,
                rangeAt(env, 0n).address,
                env.fees.withdraw,
                opBody(JackpotOp.withdraw).asBuilder().storeCoins(toNano('5')).endCell(),
            ),
            {
                hold: (m) => isTo(m, env.jackpot.address, JackpotOp.takeCurrentQuote),
            },
        )
        env.blockchain.now += 600
        const rq = await env.jackpot.sendRequote(mallory.getSender(), {
            value: env.fees.requote,
            target: queryIdOfMessage(lost.held[0]),
        })
        expectChainSucceeded(rq)
        expect(logsOf(rq.externals, LogTopic.withdrawal).length).toBe(1)
        await expectSolvent(env)
    })
})

describe("AC 8: a payout made to bounce is booked as claimable, and the owner's claim pays it", () => {
    it('restores a bounced withdrawal payout as a claim, and pays the claim', async () => {
        env = await setupJackpot()
        await players()
        await depositGram(env, alice, toNano('100'))
        const jw = await jackpotWallet(env)
        const held = await walletTokens(env.blockchain, jw)
        // the Jackpot's wallet cannot pay (the test empties it for one message): send_tokens bounces
        await setWalletTokens(env.blockchain, jw, 0n)
        const w = await rangeAt(env, 0n).sendWithdraw(alice.getSender(), {
            value: env.fees.withdraw,
            amount: toNano('40'),
        })
        await setWalletTokens(env.blockchain, jw, held)
        expect(w.transactions).toHaveTransaction({ from: jw, to: env.jackpot.address, op: 0xffffffff })
        const claimable = await env.jackpot.getClaimable(alice.address)
        expect(claimable).toBeGreaterThan(0n)
        expect((await env.jackpot.getBooks()).payouts.size).toBe(0)
        await expectSolvent(env)
        const claim = await env.jackpot.sendClaim(alice.getSender(), { value: env.fees.claim })
        expectChainSucceeded(claim)
        expect(await hgramOf(env, alice.address)).toBe(claimable)
        expect(await env.jackpot.getClaimable(alice.address)).toBe(0n)
        await expectSolvent(env)
    })
})

describe('AC 9: a deposit from a masterchain address is refunded, not booked', () => {
    it('refunds it', async () => {
        env = await setupJackpot()
        const mc = await env.blockchain.treasury('mc', { workchain: -1 })
        const hash = await jackpotHash()
        const { result, booking } = await depositGram(env, mc, toNano('100'))
        expect(booking).toBeUndefined()
        expect(result.transactions).toHaveTransaction({
            from: env.jackpot.address,
            to: mc.address,
            value: (v) => v! > toNano('100'),
        })
        expect(result.transactions).not.toHaveTransaction({ to: env.hipo.treasury.address })
        expect(await jackpotHash()).toBe(hash)
    })
})

describe('AC 10–11: a lost quote reply is recovered with requote; repeated requotes and late replies book or pay each record once', () => {
    beforeEach(async () => {
        env = await setupJackpot()
        await players()
    })

    const holdQuotes = (m: Message) => isTo(m, env.jackpot.address, JackpotOp.takeCurrentQuote)
    const requote = (id: bigint) =>
        deliver(
            env.blockchain,
            msg(mallory.address, env.jackpot.address, env.fees.requote, opBody(JackpotOp.requote, [id, 64])),
            { hold: holdQuotes },
        )

    it('for a booking, a withdrawal and a draw start, against the real treasury', async () => {
        // booking: the first reply is lost, two requotes, then every reply arrives
        const booking = await deliver(
            env.blockchain,
            msg(alice.address, env.jackpot.address, toNano('100') + env.fees.deposit, opBody(JackpotOp.deposit)),
            { hold: holdQuotes },
        )
        expect(booking.held.length).toBe(1)
        env.blockchain.now! += 600
        const r1 = await requote(queryIdOfMessage(booking.held[0]))
        env.blockchain.now! += 600
        const r2 = await requote(queryIdOfMessage(r1.held[0]))
        const all = await deliver(env.blockchain, [r2.held[0], booking.held[0], r1.held[0], r2.held[0]])
        const booked = logsOf<BookingLog>(all.externals, LogTopic.booking)
        expect(booked.length).toBe(1)
        env.bookings.push(...booked)
        expect((await jackpotState(env)).principal).toBe(booked[0].principal)
        await expectSolvent(env)

        // withdrawal
        const w = await deliver(
            env.blockchain,
            msg(
                alice.address,
                rangeAt(env, 0n).address,
                env.fees.withdraw,
                opBody(JackpotOp.withdraw).asBuilder().storeCoins(toNano('30')).endCell(),
            ),
            { hold: holdQuotes },
        )
        env.blockchain.now! += 600
        const rw = await requote(queryIdOfMessage(w.held[0]))
        const paid = await deliver(env.blockchain, [w.held[0], rw.held[0], rw.held[0]])
        expect(logsOf(paid.externals, LogTopic.withdrawal).length).toBe(1)
        expect((await jackpotState(env)).principal).toBe(booked[0].principal - toNano('30'))
        await expectSolvent(env)

        // draw start
        await nextRound(env, toNano('30'))
        const d = await deliver(
            env.blockchain,
            msg(mallory.address, env.jackpot.address, env.fees.startDraw, opBody(JackpotOp.startDraw)),
            { hold: holdQuotes },
        )
        expect((await env.jackpot.getDrawState()).state).toBe(DrawState.quoting)
        env.blockchain.now! += 600
        const rd = await requote(queryIdOfMessage(d.held[0]))
        expect((await env.jackpot.getDrawState()).queryId).toBe(queryIdOfMessage(rd.held[0]))
        const late = await deliver(env.blockchain, d.held[0])
        expect(logsOf<DrawStartLog>(late.externals, LogTopic.drawStart).length).toBe(0)
        expect((await env.jackpot.getDrawState()).state).toBe(DrawState.quoting)
        const live = await deliver(env.blockchain, [rd.held[0], rd.held[0]])
        expect(logsOf<DrawStartLog>(live.externals, LogTopic.drawStart).length).toBe(1)
        expect((await env.jackpot.getDrawState()).state).toBe(DrawState.idle)
        expect((await env.jackpot.getBooks()).quotes.size).toBe(0)
    })
})

describe('AC 12: a second-hop failure stays open until settle_failed_payout; forged gas_excess credits nothing; two claims pay once; a failed burn returns to the burn owed', () => {
    beforeEach(async () => {
        env = await setupJackpot({ config: { burnBatch: 0n } })
        await players()
    })

    it('keeps a second-hop failure open through forged confirmations, then settles it as a claim paid once', async () => {
        await depositGram(env, alice, toNano('100'))
        const held = await mintHgram(env, alice, toNano('1'))
        const repair = await breakWalletOf(env, alice.address)
        await rangeAt(env, 0n).sendWithdraw(alice.getSender(), { value: env.fees.withdraw, amount: toNano('40') })
        const [[id, record]] = [...(await env.jackpot.getBooks()).payouts.entries()]
        const c = await counters(env)
        await mallory.send({ to: env.jackpot.address, value: toNano('0.1'), body: gasExcessBody(id) })
        await mintHgram(env, mallory, toNano('1'))
        const forged = await deliver(
            env.blockchain,
            msg(
                mallory.address,
                await env.hipo.walletAddress(mallory.address),
                toNano('0.2'),
                sendTokensBody({
                    queryId: id,
                    amount: 0n,
                    recipient: env.jackpot.address,
                    returnExcess: env.jackpot.address,
                }),
            ),
        )
        expect(forged.transactions).toHaveTransaction({
            from: await jackpotWallet(env),
            to: env.jackpot.address,
            op: JackpotOp.gasExcess,
        })
        expect((await env.jackpot.getBooks()).payouts.has(id)).toBe(true)
        expect(await counters(env)).toEqual(c)
        expect(await env.jackpot.getClaimable(alice.address)).toBe(0n)

        expectChainSucceeded(
            await env.jackpot.sendSettleFailedPayout(env.governor.getSender(), { value: toNano('0.1'), target: id }),
        )
        expect(await env.jackpot.getClaimable(alice.address)).toBe(record.amount)
        await expectSolvent(env)
        await repair()
        const claims = await deliver(env.blockchain, [
            msg(alice.address, env.jackpot.address, env.fees.claim, opBody(JackpotOp.claim)),
            msg(alice.address, env.jackpot.address, env.fees.claim, opBody(JackpotOp.claim)),
        ])
        expect(claims.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.nothingToClaim,
        })
        expect(await hgramOf(env, alice.address)).toBe(held + record.amount)
        await expectSolvent(env)
    })

    it('returns a burn that bounces at the first hop, and one that fails at the second hop once settled, to the burn owed', async () => {
        await drawReady(env, [[alice, toNano('2000')]])
        const jw = await jackpotWallet(env)
        // resolve slots 0 and 1; the burn goes out when the last slot closes
        for (const slot of [0, 1]) {
            const t = await env.jackpot.getTicket(slot)
            await env.jackpot.sendLocate(env.keeper.getSender(), {
                value: env.fees.locate,
                slot,
                start: rangeOf(env, t)!.start,
            })
        }
        const owed = (await jackpotState(env)).burnOwed
        expect(owed).toBeGreaterThan(0n)
        const held = await walletTokens(env.blockchain, jw)
        const t2 = await env.jackpot.getTicket(2)
        // first hop: the Jackpot's wallet cannot pay at that moment
        const last = await deliver(
            env.blockchain,
            msg(
                env.keeper.address,
                env.jackpot.address,
                env.fees.locate,
                opBody(JackpotOp.locate, [2, 8], [rangeOf(env, t2)!.start, 128]),
            ),
            {
                hold: (m) =>
                    isTo(m, jw, JackpotOp.sendTokens) &&
                    opOf(m) === JackpotOp.sendTokens &&
                    isBurn(m, env.burner.address),
            },
        )
        expect(last.held.length).toBe(1)
        await setWalletTokens(env.blockchain, jw, 0n)
        await deliver(env.blockchain, last.held)
        await setWalletTokens(env.blockchain, jw, held)
        expect((await jackpotState(env)).burnOwed).toBe(owed)
        expect((await env.jackpot.getBooks()).payouts.size).toBe(0)
        await expectSolvent(env)

        // the next draw sends it again; this time the burner's wallet fails the second hop
        await mintHgram(env, env.burner, toNano('1'))
        const repair = await breakWalletOf(env, env.burner.address)
        await nextRound(env, toNano('30'))
        await startDraw(env, roundTime(drawRounds[1]) - 60)
        await submitRound(env, drawRounds[1])
        await resolveAll()
        const payouts = (await env.jackpot.getBooks()).payouts
        const burn = [...payouts.entries()].find(([, p]) => p.kind === 1)!
        expect(burn).toBeDefined()
        expect((await jackpotState(env)).burnOwed).toBe(0n)
        expectChainSucceeded(
            await env.jackpot.sendSettleFailedPayout(env.governor.getSender(), {
                value: toNano('0.1'),
                target: burn[0],
            }),
        )
        expect((await jackpotState(env)).burnOwed).toBe(burn[1].amount)
        await repair()
        await expectSolvent(env)
    })
})

describe('AC 13: splitting is neutral', () => {
    it('one 3,000 GRAM booking and three 1,000 GRAM bookings by one owner cover the same tickets and win the same slots', async () => {
        const outcomes: { tickets: [string, bigint, bigint][]; wins: [number, string, bigint][] }[] = []
        for (const split of [false, true]) {
            env = await setupJackpot({ fakeTreasury: true })
            await players()
            const book = async (p: Player, gram: bigint) => {
                const tokens = await mintHgram(env, p, gram)
                expect(tokens).toBe(gram)
                await depositHgram(env, p, tokens)
                const reply = await replyQuote(env, await pendingQuote(env, QuoteKind.booking), 1n, 1n)
                env.bookings.push(...logsOf<BookingLog>(reply.externals, LogTopic.booking))
            }
            if (split) for (let i = 0; i < 3; i++) await book(alice, toNano('1000'))
            else await book(alice, toNano('3000'))
            await book(bob, toNano('1000'))
            await book(carol, toNano('2000'))
            await env.hipo.nextValidationRound()
            await startDraw(env)
            await replyQuote(env, await pendingQuote(env, QuoteKind.draw), 11n, 10n)
            await env.hipo.nextValidationRound()
            await startDraw(env, roundTime(drawRounds[0]) - 60)
            await replyQuote(env, await pendingQuote(env, QuoteKind.draw), 12n, 10n)
            await submitRound(env, drawRounds[0])
            const logs = slotLogs(await resolveAll())
            const owners = new Map<string, string>(
                [alice, bob, carol].map((p, i) => [p.address.toString(), ['alice', 'bob', 'carol'][i]]),
            )
            // the tickets each owner holds, merged into intervals
            const tickets: [string, bigint, bigint][] = []
            for (const b of env.bookings) {
                const prev = tickets.length > 0 ? tickets[tickets.length - 1] : undefined
                const name = owners.get(b.owner.toString())!
                if (prev?.[0] === name && prev[2] === b.start) prev[2] = b.start + b.principal
                else tickets.push([name, b.start, b.start + b.principal])
            }
            outcomes.push({
                tickets,
                wins: logs
                    .filter((l) => l.result === SlotResult.hit)
                    .map((l) => [l.slot, owners.get(l.owner!.toString())!, l.ticket]),
            })
        }
        expect(outcomes[1].tickets).toEqual(outcomes[0].tickets)
        expect(outcomes[1].wins).toEqual(outcomes[0].wins)
        expect(outcomes[0].wins.length).toBe(3)
    })
})

describe('AC 14: one owner can win two slots of the same draw', () => {
    it('pays every slot to the only eligible owner', async () => {
        env = await setupJackpot()
        await players()
        await drawReady(env, [[alice, toNano('1000')]])
        const draw = await env.jackpot.getDrawState()
        const before = await hgramOf(env, alice.address)
        const logs = slotLogs(await resolveAll())
        const hits = logs.filter((l) => l.result === SlotResult.hit)
        expect(hits.length).toBe(3)
        for (const h of hits) expect(h.owner!.equals(alice.address)).toBe(true)
        expect((await hgramOf(env, alice.address)) - before).toBe(draw.prizes[0] + draw.prizes[1] + draw.prizes[2])
    })
})

describe("AC 15: a withdrawal sent before a slot's check reaches the range turns that attempt into a miss", () => {
    it('misses, and the next attempt follows', async () => {
        env = await setupJackpot()
        await players()
        await drawReady(env, [
            [alice, toNano('1000')],
            [bob, toNano('1000')],
        ])
        const r = await env.jackpot.getTicket(0)
        const range = rangeOf(env, r)!
        const owner = range.owner.equals(alice.address) ? alice : bob
        const located = await deliver(
            env.blockchain,
            msg(
                env.keeper.address,
                env.jackpot.address,
                env.fees.locate,
                opBody(JackpotOp.locate, [0, 8], [range.start, 128]),
            ),
            {
                hold: (m) => opOf(m) === JackpotOp.check,
            },
        )
        expect(located.held.length).toBe(1)
        expectChainSucceeded(
            await rangeAt(env, range.start).sendWithdraw(owner.getSender(), { value: env.fees.withdraw, amount: 0n }),
        )
        const answer = await deliver(env.blockchain, located.held)
        const logs = logsOf<SlotLog>(answer.externals, LogTopic.slot)
        expect(logs.map((l) => l.result)).toEqual([SlotResult.miss])
        const draw = await env.jackpot.getDrawState()
        expect(draw.attempts[0]).toBe(1)
        expect(draw.openSlots & 1).toBe(1)
        const next = await env.jackpot.getTicket(0)
        expect(next).toBe(ticketOf(draw.seed, 0, 1, draw.cutoff))
        const res = await env.jackpot.sendLocate(env.keeper.getSender(), {
            value: env.fees.locate,
            slot: 0,
            start: rangeOf(env, next)!.start,
        })
        expect(logsOf<SlotLog>(res.externals, LogTopic.slot).length).toBe(1)
    })
})

describe('AC 16: locate with a wrong start changes no state; A misses roll the prize over, and so does expiry after one round', () => {
    it('ignores wrong starts, rolls over after 64 misses, and expires a slot after one round', async () => {
        env = await setupJackpot()
        await players()
        await drawReady(env, [
            [alice, toNano('1000')],
            [bob, toNano('1000')],
        ])
        const draw = await env.jackpot.getDrawState()
        const r = await env.jackpot.getTicket(0)
        const right = rangeOf(env, r)!
        const other = env.bookings.find((b) => b !== right)!
        const hash = await jackpotHash()
        for (const start of [r + 1n, other.start < r ? other.start : r - 1n, r]) {
            if (start === right.start) continue
            const res = await env.jackpot.sendLocate(env.keeper.getSender(), { value: env.fees.locate, slot: 0, start })
            // refused at the Jackpot, or the check bounces at a range that does not hold r (or does not exist)
            expect(logsOf<SlotLog>(res.externals, LogTopic.slot)).toEqual([])
            expect(await jackpotHash()).toBe(hash)
        }

        // everyone eligible leaves: every attempt misses
        for (const b of env.bookings) {
            const p = b.owner.equals(alice.address) ? alice : bob
            await rangeAt(env, b.start).sendWithdraw(p.getSender(), { value: env.fees.withdraw, amount: 0n })
        }
        const O = (await counters(env)).O
        const results = []
        for (let j = 0; j < 64; j++) {
            const t = await env.jackpot.getTicket(0)
            results.push(
                await env.jackpot.sendLocate(env.keeper.getSender(), {
                    value: env.fees.locate,
                    slot: 0,
                    start: rangeOf(env, t)!.start,
                }),
            )
        }
        const logs = slotLogs(results)
        expect(logs.filter((l) => l.result === SlotResult.miss).length).toBe(63)
        expect(logs[logs.length - 1].result).toBe(SlotResult.rolledOver)
        expect((await counters(env)).O).toBe(O - draw.prizes[0])

        // expiry: refused before one validation round, accepted after
        const early = await env.jackpot.sendExpire(env.keeper.getSender(), { value: env.fees.expire, slot: 1 })
        expect(early.transactions).toHaveTransaction({ success: false, exitCode: JackpotError.tooSoon })
        const electedFor = getConfig(env.blockchain, 15n)!.beginParse().loadUint(32)
        env.blockchain.now! += electedFor
        for (const slot of [1, 2]) {
            const res = await env.jackpot.sendExpire(env.keeper.getSender(), { value: env.fees.expire, slot })
            expectChainSucceeded(res)
            expect(logsOf<SlotLog>(res.externals, LogTopic.slot)[0].result).toBe(SlotResult.expired)
        }
        expect((await env.jackpot.getDrawState()).state).toBe(DrawState.idle)
        await expectSolvent(env)
    })
})

describe('AC 17: submit_randomness accepts the real quicknet signatures of at least 20 recorded rounds and rejects the bad ones, within 200,000 gas', () => {
    const P = BLS12_381_P
    const modPow = (b: bigint, e: bigint, m: bigint) => {
        let r = 1n
        b %= m
        while (e > 0n) {
            if (e & 1n) r = (r * b) % m
            b = (b * b) % m
            e >>= 1n
        }
        return r
    }
    // a point on y² = x³ + 4 outside G1 (cofactor ≈ 2^126), compressed
    const onCurveNotInG1 = (() => {
        for (let x = 5n; ; x++) {
            const rhs = (x * x * x + 4n) % P
            const y = modPow(rhs, (P + 1n) / 4n, P)
            if ((y * y) % P === rhs) {
                const out = Buffer.from(x.toString(16).padStart(96, '0'), 'hex')
                out[0] |= 0x80
                if (y > (P - 1n) / 2n) out[0] |= 0x20
                return out
            }
        }
    })()
    const infinity = Buffer.concat([Buffer.from([0xc0]), Buffer.alloc(47)])

    it('runs a real draw for every recorded round and checks the rejections on the way', async () => {
        env = await setupAt(roundTime(drandRounds[0]) - 3600)
        await players()
        await depositGram(env, alice, toNano('1000'))
        await depositGram(env, bob, toNano('1000'))
        await nextRound(env, toNano('30'))
        await startDraw(env)
        let accepted = 0
        let maxGas = 0n
        for (const [i, round] of drandRounds.entries()) {
            await nextRound(env, toNano('30'))
            await startDraw(env, roundTime(round) - 60)
            const draw = await env.jackpot.getDrawState()
            expect(draw.state).toBe(DrawState.waiting)
            expect(draw.round).toBe(BigInt(round))
            if (i === drandRounds.length - 1) {
                const other = drandRounds[i - 1]
                const bad: [Buffer, Message['body'], number][] = [
                    [Buffer.from(fixtureRound(other).signature, 'hex'), buildWitness(round), DrandError.wrongSignature],
                    [onCurveNotInG1, buildWitness(round), DrandError.signatureNotInG1],
                    [infinity, buildWitness(round), DrandError.signatureIsZero],
                    [Buffer.from(fixtureRound(round).signature, 'hex'), buildWitness(other), DrandError.badWitness],
                ]
                for (const [sig, witness, code] of bad) {
                    const hash = await jackpotHash()
                    const res = await deliver(
                        env.blockchain,
                        msg(
                            env.keeper.address,
                            env.jackpot.address,
                            env.fees.submitRandomness,
                            submitBody(round, sig, witness),
                        ),
                    )
                    expect(res.transactions).toHaveTransaction({
                        to: env.jackpot.address,
                        success: false,
                        exitCode: code,
                    })
                    expect(await jackpotHash()).toBe(hash)
                }
            }
            const res = await deliver(
                env.blockchain,
                msg(env.keeper.address, env.jackpot.address, env.fees.submitRandomness, submitBody(round)),
            )
            expect(failed(res.transactions)).toEqual([])
            const gas = gasOf(res.transactions[0])
            if (gas > maxGas) maxGas = gas
            expect((await env.jackpot.getDrawState()).seed).toBe(BigInt('0x' + fixtureRound(round).randomness))
            accepted++
            await resolveAll()
        }
        console.log(`submit_randomness: ${accepted.toString()} rounds accepted, max gas ${maxGas.toString()}`)
        expect(accepted).toBeGreaterThanOrEqual(20)
        expect(maxGas).toBeLessThanOrEqual(200_000n)
    }, 600_000)
})

describe('AC 18: a draw cannot start twice in one validation round, nor with the rate unchanged, nor with a pot below m', () => {
    it('refuses or returns to idle with nothing changed', async () => {
        env = await setupJackpot()
        await players()
        await depositGram(env, alice, toNano('1000'))
        const unchanged = async (
            s: Awaited<ReturnType<typeof jackpotState>>,
            res: Awaited<ReturnType<typeof startDraw>>,
        ) => {
            expectChainSucceeded(res)
            expect(logsOf(res.externals, LogTopic.drawStart).length).toBe(0)
            expect((await env.jackpot.getDrawState()).state).toBe(DrawState.idle)
            expect(await jackpotState(env)).toMatchObject({
                lastRoundSince: s.lastRoundSince,
                cutoff: s.cutoff,
                lastCoins: s.lastCoins,
                lastTokens: s.lastTokens,
                setAside: 0n,
            })
        }

        // a new round and a higher rate, but the pot is below m (1 hGRAM)
        await nextRound(env, toNano('0.1'))
        let s = await jackpotState(env)
        await unchanged(s, await startDraw(env))

        // the reward is booked: the start goes through, once in this round
        await env.hipo.raiseRate(toNano('30'))
        const opened = await startDraw(env)
        expect(logsOf(opened.externals, LogTopic.drawStart).length).toBe(1)
        const twice = await startDraw(env)
        expect(twice.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.roundNotChanged,
        })

        // a new round, the rate unchanged since the last start
        await nextRound(env, 0n)
        s = await jackpotState(env)
        await unchanged(s, await startDraw(env))
    })
})

describe('AC 19: b above 2000 is refused; the burn reaches the burner as an hGRAM transfer carrying 0.5 GRAM', () => {
    it('refuses 2001 and burns with 0.5 GRAM forwarded', async () => {
        env = await setupJackpot({ config: { burnBatch: 0n } })
        await players()
        const refused = await env.jackpot.sendSetBurnShare(env.governor.getSender(), {
            value: toNano('0.05'),
            burnShare: 2001n,
        })
        expect(refused.transactions).toHaveTransaction({ success: false, exitCode: JackpotError.invalidParameters })
        const notGovernor = await env.jackpot.sendSetBurnShare(mallory.getSender(), {
            value: toNano('0.05'),
            burnShare: 2000n,
        })
        expect(notGovernor.transactions).toHaveTransaction({ success: false, exitCode: JackpotError.accessDenied })
        await drawReady(env, [[alice, toNano('1000')]])
        const owed = (await jackpotState(env)).burnOwed
        const results = await resolveAll()
        const last = results[results.length - 1]
        expect(last.transactions).toHaveTransaction({
            from: await env.hipo.walletAddress(env.burner.address),
            to: env.burner.address,
            op: JackpotOp.transferNotification,
            value: (v) => v != null && v >= toNano('0.499') && v <= toNano('0.5'),
        })
        expect(await hgramOf(env, env.burner.address)).toBe(owed)
    })
})

describe('AC 20: a GRAM deposit while Hipo is halted is refunded in full less gas; with instant_mint off it is booked when the bill mints', () => {
    it('refunds a deposit Hipo refuses', async () => {
        env = await setupJackpot()
        await players()
        await env.hipo.setStopped(true)
        const balance = await alice.getBalance()
        const { result, booking } = await depositGram(env, alice, toNano('100'))
        expect(booking).toBeUndefined()
        expect(result.transactions).toHaveTransaction({
            from: env.jackpot.address,
            to: alice.address,
            value: (v) => v! > toNano('100'),
        })
        expect(balance - (await alice.getBalance())).toBeLessThan(env.fees.deposit)
        expect((await env.jackpot.getBooks()).pending.size).toBe(0)
    })

    // Hipo mints a bill with the query_id of the message that burned the bills, not the deposit's, so the
    // Jackpot finds no pending record: the tokens stay in its wallet outside T, unbooked, until the
    // governor's resolve_pending two rounds later. See Attacks.spec.ts for the theft this enables.
    openBug('books a deposit made with instant_mint off when its bill mints', async () => {
        env = await setupJackpot({ instantMint: false })
        await players()
        const now = BigInt(env.blockchain.now!)
        await setParticipations(env, [
            [now - 100000n, ParticipationState.ReadyToBurn],
            [now - 10n, ParticipationState.Open],
        ])
        const { booking } = await depositGram(env, alice, toNano('100'))
        expect(booking).toBeUndefined() // a bill for now
        expect((await env.jackpot.getBooks()).pending.size).toBe(1)
        const burn = await env.hipo.treasury.sendParticipateInElection({ queryId: 1234n, roundSince: now - 10n })
        expect(burn.transactions).toHaveTransaction({ to: env.jackpot.address, op: JackpotOp.transferNotification })
        const booked = logsOf<BookingLog>(burn.externals, LogTopic.booking)
        expect(booked.length).toBe(1) // fails: nothing is booked
        expect(booked[0].owner.equals(alice.address)).toBe(true)
        expect((await env.jackpot.getBooks()).pending.size).toBe(0)
    })
})

describe('AC 21: while halted, withdrawals still pay and a running draw completes', () => {
    it('completes the draw and pays a withdrawal while halted', async () => {
        env = await setupJackpot()
        await players()
        await drawReady(env, [
            [alice, toNano('1000')],
            [bob, toNano('1000')],
        ])
        await env.jackpot.sendSetHalted(env.halter.getSender(), { value: toNano('0.05'), halted: true })
        expect((await jackpotState(env)).halted).toBe(true)
        const logs = slotLogs(await resolveAll())
        expect(logs.filter((l) => l.result === SlotResult.hit).length).toBe(3)
        expect((await env.jackpot.getDrawState()).state).toBe(DrawState.idle)
        const before = await hgramOf(env, alice.address)
        expectChainSucceeded(
            await rangeAt(env, 0n).sendWithdraw(alice.getSender(), { value: env.fees.withdraw, amount: 0n }),
        )
        expect(await hgramOf(env, alice.address)).toBeGreaterThan(before)
        await expectSolvent(env)
    })
})

describe('AC 22: gas and storage', () => {
    it('keeps every handler of a full flow within its budget, and deploys ranges with their storage reserve (pins: tests/Gas.spec.ts, tests/Range.spec.ts)', async () => {
        env = await setupJackpot()
        await players()
        await drawReady(env, [
            [alice, toNano('1000')],
            [bob, toNano('1000')],
        ])
        const results = await resolveAll()
        for (const r of results) {
            for (const tx of r.transactions) {
                const gas = gasOf(tx)
                expect(gas).toBeLessThanOrEqual(30_000n)
            }
        }
        for (const b of env.bookings)
            expect(await rangeAt(env, b.start).getBalance()).toBeGreaterThanOrEqual(toNano('0.1'))
    })
})

describe('AC 23: two money audits and a code review pass', () => {
    it.todo('is not a test: the audits and the review are separate work')
})

function opOf(m: Message): number | undefined {
    const s = m.body.beginParse()
    return s.remainingBits >= 32 ? s.loadUint(32) : undefined
}

// A send_tokens from the Jackpot to its wallet whose recipient is the burner.
function isBurn(m: Message, burner: Player['address']): boolean {
    const s = m.body.beginParse()
    s.skip(32 + 64)
    s.loadCoins()
    return s.loadAddress().equals(burner)
}
