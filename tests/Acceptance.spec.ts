/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests read state they just made */
// The acceptance criteria of docs/specs/2026-10-27-jackpot-v1.md (as amended), one group per criterion,
// named after it, against Hipo's real treasury, parent and wallet (or a stand-in treasury where the test
// must choose the rate). The whale and permanent-gap criteria are in tests/Attacks.spec.ts, "Economic
// attacks".
import { compile } from '@ton/blueprint'
import { Message, Transaction, beginCell, toNano } from '@ton/core'
import '@ton/test-utils'
import {
    BookingLog,
    DrawStartLog,
    DrawState,
    JackpotError,
    JackpotOp,
    LogTopic,
    PayoutKind,
    QuoteKind,
    SlotLog,
    SlotResult,
    WithdrawnLog,
    attemptsPerSlot,
    logsOf,
    treeLevels,
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
    nodeAt,
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
    descendBody,
    drawReady,
    failed,
    gasExcessBody,
    hitBody,
    isTo,
    jackpotWallet,
    lostBody,
    missBody,
    msg,
    opBody,
    positionOf,
    queryIdOfMessage,
    rangeOf,
    rangeSetupBody,
    sendTokensBody,
    setParticipations,
    setWalletTokens,
    setupAt,
    submitBody,
    updateBody,
    walkTree,
    walletTokens,
} from './jackpot/adversary'
import { SequenceResult, drandRounds, makeWorld, runSequence } from './jackpot/sequences'

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
const treeHash = () =>
    Promise.all([1, 2, 3, 4].map((level) => dataHash(env.blockchain, nodeAt(env, level, 0n).address)))

function slotLogs(results: { externals: { info: { dest?: unknown }; body: unknown }[] }[]): SlotLog[] {
    return results.flatMap((r) => logsOf<SlotLog>(r.externals as never, LogTopic.slot))
}

function gasOf(tx: Transaction): bigint {
    return tx.description.type === 'generic' && tx.description.computePhase.type === 'vm'
        ? tx.description.computePhase.gasUsed
        : 0n
}

function opOf(m: Message): number | undefined {
    const s = m.body.beginParse()
    return s.remainingBits >= 32 ? s.loadUint(32) : undefined
}

// The current attempt of a slot: its position, and the booking the tree puts it in.
async function current(slot: number) {
    const draw = await env.jackpot.getDrawState()
    const k = await env.jackpot.getPosition(slot)
    return { draw: draw.drawId, slot, j: draw.attempts[slot], k, range: (await rangeOf(env, k))! }
}

describe('AC 1–2: property test (short run here; the long run is tests/Property.spec.ts)', () => {
    const results: SequenceResult[] = []
    let error: unknown

    beforeAll(async () => {
        const world = await makeWorld()
        try {
            // a few sequences, and more until some draw has had its winners checked
            for (let i = 0; i < 12; i++) {
                results.push(await runSequence(world, 20261027 + i))
                if (i >= 3 && results.some((r) => r.winners > 0)) break
            }
        } catch (e) {
            error = e
        }
    }, 600_000)

    it('random sequences of deposits, withdrawals, rate rises and draws keep F·TC ≥ P·TT and the real wallet ≥ T after every transaction', () => {
        expect(error).toBeUndefined()
        expect(results.length).toBeGreaterThanOrEqual(4)
        expect(results.reduce((a, r) => a + r.transactions, 0)).toBeGreaterThan(0)
    })

    it('every winner is the range holding the k(i, j)-th eligible live ticket as of the start; the nodes and L_lo + L_hi match the live tickets', () => {
        // runSequence recomputes each answer from the logs and checks the tree after every draw
        expect(error).toBeUndefined()
        expect(results.reduce((a, r) => a + r.winners, 0)).toBeGreaterThan(0)
    })

    it('after full withdrawals by every player, each received hGRAM worth ≥ principal less 1 nano-hGRAM per withdrawal', () => {
        // runSequence ends every sequence with this check, and with no payout left unconfirmed
        expect(error).toBeUndefined()
        expect(results.reduce((a, r) => a + r.withdrawals, 0)).toBeGreaterThan(0)
    })
})

describe('AC 3: a rate drop pays withdrawals pro-rata, refuses draw starts, returns prizes to F, holds the burn, returns bookings, and pays only other claims until the governor clears the flag', () => {
    const rate = (n: bigint) => [n, 1000n] as const

    beforeEach(async () => {
        env = await setupJackpot({ fakeTreasury: true, config: { burnBatch: 0n } })
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
        const draw = await env.jackpot.getDrawState()

        // slot 0 is won while the Jackpot's wallet cannot pay: the prize comes back as a prize claim
        const jw = await jackpotWallet(env)
        const tokens = await walletTokens(env.blockchain, jw)
        await setWalletTokens(env.blockchain, jw, 0n)
        const first = await env.jackpot.sendLocate(env.keeper.getSender(), { value: env.fees.locate, slot: 0 })
        await setWalletTokens(env.blockchain, jw, tokens)
        const won = slotLogs([first])[0]
        expect(won.result).toBe(SlotResult.hit)
        const winner = [alice, bob].find((p) => p.address.equals(won.owner!))!
        expect(await env.jackpot.getClaimableParts(winner.address)).toEqual({ prize: draw.prizes[0], other: 0n })

        // the rate falls on a withdrawal's quote: it is paid its pro-rata share of F, not x at the new rate.
        // Its payout fails at the first hop too, and becomes an `other` claim.
        const x = toNano('100')
        const s = await env.jackpot.getSurcharge(a.booking!.b, x)
        await rangeAt(env, a.booking!.b).sendWithdraw(alice.getSender(), { value: env.fees.withdraw + s, amount: x })
        const s0 = await counters(env)
        const F = s0.T - s0.I - s0.O
        await setWalletTokens(env.blockchain, jw, 0n)
        await replyQuote(env, await pendingQuote(env, QuoteKind.withdrawal), ...rate(900n))
        await setWalletTokens(env.blockchain, jw, tokens)
        expect((await counters(env)).falling).toBe(true)
        const proRata = (F * x) / s0.P
        expect(proRata).toBeLessThan((x * 1000n) / 900n)
        const aliceParts = await env.jackpot.getClaimableParts(alice.address)
        expect(aliceParts.other).toBe(proRata)

        // the other slots: a prize won now goes back into F and is added to carried
        const before = await jackpotState(env)
        const logs = slotLogs(await resolveDraw(env))
        expect(logs.filter((l) => l.result === SlotResult.hit).length).toBe(0)
        const back = logs
            .filter((l) => l.result === SlotResult.returned || l.result === SlotResult.rolledOver)
            .reduce((t, l) => t + l.amount, 0n)
        expect(back).toBe(draw.prizes[1] + draw.prizes[2])
        expect(logs.some((l) => l.result === SlotResult.returned)).toBe(true)
        let state = await jackpotState(env)
        expect(state.carried).toBe(before.carried + back)
        // the burn owed is held, though the batch is 0
        expect(state.burnOwed).toBeGreaterThan(0n)
        expect(await hgramOf(env, env.burner.address)).toBe(0n)

        // an `other` claim is paid; a prize claim waits
        const otherBefore = await hgramOf(env, alice.address)
        expectChainSucceeded(await env.jackpot.sendClaim(alice.getSender(), { value: env.fees.claim }))
        expect((await hgramOf(env, alice.address)) - otherBefore).toBe(proRata)
        expect((await env.jackpot.getClaimableParts(winner.address)).prize).toBe(draw.prizes[0])
        if (winner === bob) {
            const waits = await env.jackpot.sendClaim(bob.getSender(), { value: env.fees.claim })
            expect(waits.transactions).toHaveTransaction({ success: false, exitCode: JackpotError.rateFalling })
        }

        // draw starts refused; a new booking is returned, even at a rate above the fallen one
        await env.hipo.nextValidationRound()
        const refused = await startDraw(env)
        expect(refused.transactions).toHaveTransaction({ success: false, exitCode: JackpotError.rateFalling })
        const c1 = await book(carol, toNano('100'), 950n)
        expect(c1.booking).toBeUndefined()
        expect(await hgramOf(env, carol.address)).toBe(c1.minted)

        // only the governor clears it; then all of it resumes
        const notGovernor = await env.jackpot.sendClearFalling(mallory.getSender(), { value: toNano('0.05') })
        expect(notGovernor.transactions).toHaveTransaction({ success: false, exitCode: JackpotError.accessDenied })
        await env.jackpot.sendClearFalling(env.governor.getSender(), { value: toNano('0.05') })
        const prizeBefore = await hgramOf(env, winner.address)
        expectChainSucceeded(await env.jackpot.sendClaim(winner.getSender(), { value: env.fees.claim }))
        expect((await hgramOf(env, winner.address)) - prizeBefore).toBe(draw.prizes[0])
        const c2 = await book(carol, toNano('100'), 950n)
        expect(c2.booking).toBeDefined()
        await startDraw(env)
        expect((await env.jackpot.getDrawState()).state).toBe(DrawState.quoting)
        state = await jackpotState(env)
        expect(state.falling).toBe(false)
    })
})

describe('AC 4: a range booked after a draw starts is never paid by that draw or the next one', () => {
    beforeEach(async () => {
        env = await setupJackpot()
        await players()
    })

    it('every position of every attempt lands below E; a hit from the late range is ignored; it wins nothing in either draw', async () => {
        await depositGram(env, alice, toNano('1000'))
        await depositGram(env, bob, toNano('1000'))
        await nextRound(env, toNano('30'))
        await startDraw(env) // opens the first period
        await nextRound(env, toNano('30'))
        await startDraw(env, roundTime(drawRounds[0]) - 60)
        // carol books after draw 1 started, with far more than everyone else
        const { booking: late } = await depositGram(env, carol, toNano('100000'))
        const s = await jackpotState(env)
        expect(late!.b).toBeGreaterThanOrEqual(s.kNext) // ≥ the next draw's E too

        for (const [i, round] of drawRounds.entries()) {
            if (i === 1) {
                await nextRound(env, toNano('300'))
                await startDraw(env, roundTime(round) - 60)
            }
            await submitRound(env, round)
            const draw = await env.jackpot.getDrawState()
            expect(late!.b).toBeGreaterThanOrEqual(draw.cutoff)
            // every attempt of every slot lands on a range below E, so never on the late range
            for (const slot of [0, 1, 2]) {
                for (let j = 0; j < attemptsPerSlot; j++) {
                    const at = await walkTree(env, positionOf(draw.seed, slot, j, draw.eligible))
                    expect(at!.b).toBeLessThan(draw.cutoff)
                }
            }
            const before = await hgramOf(env, carol.address)
            for (const slot of [0, 1, 2]) {
                // forced: the late range answers hit, as itself, about the current attempt; ignored, as b ≥ E
                const a = await current(slot)
                const hash = await jackpotHash()
                const forced = await deliver(
                    env.blockchain,
                    msg(
                        rangeAt(env, late!.b).address,
                        env.jackpot.address,
                        toNano('0.1'),
                        hitBody({ ...a, b: late!.b, owner: carol.address }),
                    ),
                )
                expect(failed(forced.transactions)).toEqual([])
                expect(await jackpotHash()).toBe(hash)
            }
            const logs = slotLogs(await resolveDraw(env))
            for (const l of logs) expect(l.owner?.equals(carol.address) ?? false).toBe(false)
            expect(await hgramOf(env, carol.address)).toBe(before)
        }
    })
})

describe("AC 5: check to one's own range, update or descend to a node, hit, miss or lost straight to the Jackpot, and a second hit change nothing", () => {
    beforeEach(async () => {
        env = await setupJackpot()
        await players()
        await drawReady(env, [
            [alice, toNano('1000')],
            [bob, toNano('1000')],
        ])
    })

    it('no prize is paid, no attempt advances, no sum changes; a second hit for a closed slot pays nothing', async () => {
        const draw = await env.jackpot.getDrawState()
        const hash = await jackpotHash()
        const tree = await treeHash()
        const a = await current(0)
        const owner = a.range.owner.equals(alice.address) ? alice : bob
        const own = await owner.send({
            to: rangeAt(env, a.range.b).address,
            value: toNano('1'),
            body: checkBody({ ...a, offset: 0n }),
        })
        expect(own.transactions).toHaveTransaction({
            to: rangeAt(env, a.range.b).address,
            success: false,
            exitCode: JackpotError.accessDenied,
        })
        for (let level = 1; level <= treeLevels; level++) {
            for (const body of [
                updateBody({ tag: draw.drawId, deferred: false, b: a.range.b, delta: toNano('1000000') }),
                descendBody({ ...a, offset: a.k }),
            ]) {
                const r = await owner.send({ to: nodeAt(env, level, 0n).address, value: toNano('1'), body })
                expect(r.transactions).toHaveTransaction({
                    to: nodeAt(env, level, 0n).address,
                    success: false,
                    exitCode: JackpotError.accessDenied,
                })
            }
        }
        for (const body of [
            hitBody({ ...a, b: a.range.b, owner: owner.address }),
            missBody({ ...a, b: a.range.b }),
            lostBody({ ...a, level: 1, index: 0n }),
        ]) {
            await owner.send({ to: env.jackpot.address, value: toNano('1'), body })
        }
        expect(await jackpotHash()).toBe(hash)
        expect(await treeHash()).toEqual(tree)
        expect(await env.jackpot.getDrawState()).toEqual(draw)

        // the real hit closes slot 0; replaying the hit, even from the range itself, pays nothing
        const before = await hgramOf(env, owner.address)
        const located = await deliver(
            env.blockchain,
            msg(env.keeper.address, env.jackpot.address, env.fees.locate, opBody(JackpotOp.locate, [0, 8])),
        )
        expect(logsOf<SlotLog>(located.externals, LogTopic.slot)[0].result).toBe(SlotResult.hit)
        const paid = (await hgramOf(env, owner.address)) - before
        expect(paid).toBe(draw.prizes[0])
        const hash2 = await jackpotHash()
        await deliver(
            env.blockchain,
            msg(
                rangeAt(env, a.range.b).address,
                env.jackpot.address,
                toNano('0.1'),
                hitBody({ ...a, b: a.range.b, owner: owner.address }),
            ),
        )
        expect(await jackpotHash()).toBe(hash2)
        expect(await hgramOf(env, owner.address)).toBe(before + paid)
    })
})

describe('AC 6: a range setup comes only from the Jackpot, once; a deposit below the minimum is returned and the next booking gets its index; a deposit of exactly the minimum after a rate rise is booked', () => {
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
        expect(booking!.b).toBe(0n)
        const second = await deliver(
            env.blockchain,
            // as if from the Jackpot, which never sends one; not bounceable, since a bounce would reach the
            // real Jackpot as the failure of its own setup
            msg(env.jackpot.address, range0.address, toNano('0.2'), rangeSetupBody(mallory.address, 1n), false),
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

        // nothing is left to withdraw: x = 0 on an empty range is refused
        const empty = await range0.sendWithdraw(bob.getSender(), { value: env.fees.withdraw, amount: 0n })
        expect(empty.transactions).toHaveTransaction({
            to: range0.address,
            success: false,
            exitCode: JackpotError.insufficientFunds,
        })
    })

    it('books a GRAM deposit of exactly the minimum after a rate rise', async () => {
        // an hGRAM booking stores the quote of its reply, after a rise of the rate since the deploy
        await env.hipo.raiseRate('7')
        await depositHgram(env, bob, await mintHgram(env, bob, toNano('50'))) // any booking refreshes the stored quote
        const [tc] = await env.hipo.quote()
        await env.hipo.raiseRate(tc / 2000n) // +0.05%, about a round's yield
        const { booking } = await depositGram(env, alice, toNano('10'))
        expect(booking).toBeDefined()
        expect(booking!.principal).toBeLessThan(toNano('10'))
    })

    it('refuses a GRAM deposit until the first quote is stored', async () => {
        env = await setupJackpot({ fakeTreasury: true, firstQuote: false })
        await players()
        const refused = await env.jackpot.sendDeposit(alice.getSender(), { value: toNano('100') + env.fees.deposit })
        expect(refused.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.noQuote,
        })
        await replyQuote(env, await pendingQuote(env, QuoteKind.refresh), 12n, 10n)
        await env.jackpot.sendDeposit(alice.getSender(), { value: toNano('100') + env.fees.deposit })
        const [record] = [...(await env.jackpot.getBooks()).pending.values()]
        expect(record.cap).toBe((toNano('100') * 10n) / 12n)
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
            () => env.jackpot.sendLocate(alice.getSender(), { value: short(env.fees.locate), slot: 0 }),
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

    it('runs start_draw, locate, requote and withdraw, deferred or not, to the end on exactly their fee', async () => {
        await depositGram(env, alice, toNano('1000'))
        await depositGram(env, bob, toNano('1000'))
        await nextRound(env, toNano('30'))
        expectChainSucceeded(await env.jackpot.sendStartDraw(mallory.getSender(), { value: env.fees.startDraw }))
        await nextRound(env, toNano('30'))
        env.blockchain.now = roundTime(drawRounds[0]) - 60
        expectChainSucceeded(await env.jackpot.sendStartDraw(mallory.getSender(), { value: env.fees.startDraw }))
        expect((await env.jackpot.getDrawState()).state).toBe(DrawState.waiting)
        await submitRound(env, drawRounds[0])
        // a withdrawal held back in the window, on the fee and its surcharge
        const s = await env.jackpot.getSurcharge(1n, toNano('500'))
        const deferred = await rangeAt(env, 1n).sendWithdraw(bob.getSender(), {
            value: env.fees.withdraw + s,
            amount: toNano('500'),
        })
        expectChainSucceeded(deferred)
        expect(logsOf<WithdrawnLog>(deferred.externals, LogTopic.withdrawn)[0].deferred).toBe(true)
        for (let guard = 0; guard < 60; guard++) {
            const d = await env.jackpot.getDrawState()
            if (d.openSlots === 0) break
            const slot = [0, 1, 2].find((i) => (d.openSlots >> i) & 1)!
            const res = await env.jackpot.sendLocate(mallory.getSender(), { value: env.fees.locate, slot })
            expectChainSucceeded(res)
            expect(logsOf<SlotLog>(res.externals, LogTopic.slot).length).toBeGreaterThanOrEqual(1)
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

describe('AC 7b: a withdrawal in the window from an eligible range needs its surcharge; one sent short bounces, and the range restores live', () => {
    beforeEach(async () => {
        env = await setupJackpot()
        await players()
        await depositGram(env, alice, toNano('1000'))
        await depositGram(env, bob, toNano('1000'))
        await nextRound(env, toNano('30'))
        await startDraw(env)
        await nextRound(env, toNano('30'))
        await startDraw(env, roundTime(drawRounds[0]) - 60)
        // carol books after the start: b ≥ E
        await depositGram(env, carol, toNano('1000'))
    })

    it('bounces without s, with the counters and the tree unchanged and the GRAM returned; pays and defers with s; none needed outside the window or for b ≥ E', async () => {
        const x = toNano('300')
        const s = await env.jackpot.getSurcharge(0n, x)
        const draw = await env.jackpot.getDrawState()
        // ceil(3·(A−1)·fee::attempt·x / draw_L)
        expect(s).toBe((3n * 15n * env.fees.attempt * x + draw.eligible - 1n) / draw.eligible)
        expect(await env.jackpot.getSurcharge(2n, x)).toBe(0n) // b ≥ E

        const hash = await jackpotHash()
        const tree = await treeHash()
        const balance = await alice.getBalance()
        const short = await rangeAt(env, 0n).sendWithdraw(alice.getSender(), {
            value: env.fees.withdraw + s - 1n,
            amount: x,
        })
        expect(short.transactions).toHaveTransaction({
            from: rangeAt(env, 0n).address,
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.insufficientFee,
        })
        expect(short.transactions).toHaveTransaction({ from: rangeAt(env, 0n).address, to: alice.address })
        expect((await rangeAt(env, 0n).getRangeData()).live).toBe(env.bookings[0].principal)
        expect(await jackpotHash()).toBe(hash)
        expect(await treeHash()).toEqual(tree)
        // what alice lost is gas: the range keeps a fixed part for returning the rest
        expect(balance - (await alice.getBalance())).toBeLessThan(toNano('0.1'))

        // with s: paid at once, and held back in the nodes for this draw
        const before = await hgramOf(env, alice.address)
        const ok = await rangeAt(env, 0n).sendWithdraw(alice.getSender(), { value: env.fees.withdraw + s, amount: x })
        expectChainSucceeded(ok)
        expect(logsOf<WithdrawnLog>(ok.externals, LogTopic.withdrawn)[0].deferred).toBe(true)
        expect(await hgramOf(env, alice.address)).toBeGreaterThan(before)
        const top = await nodeAt(env, 4, 0n).getNodeData()
        expect(top.held[0]).toBe(x)
        expect(top.pendingDraw).toBe(draw.drawId)
        // an overpayment above the fee and s comes back
        const over = await rangeAt(env, 0n).sendWithdraw(alice.getSender(), {
            value: env.fees.withdraw + s + toNano('5'),
            amount: x,
        })
        expect(over.transactions).toHaveTransaction({
            from: env.jackpot.address,
            to: alice.address,
            op: JackpotOp.gasExcess,
            value: (v) => v! > toNano('4.9'),
        })

        // a range booked after the start needs no surcharge
        const late = await rangeAt(env, 2n).sendWithdraw(carol.getSender(), { value: env.fees.withdraw, amount: x })
        expectChainSucceeded(late)
        expect(logsOf<WithdrawnLog>(late.externals, LogTopic.withdrawn)[0].deferred).toBe(false)

        // outside the window, none either
        await submitRound(env, drawRounds[0])
        await resolveDraw(env)
        expect(await env.jackpot.getSurcharge(0n, x)).toBe(0n)
        const after = await rangeAt(env, 0n).sendWithdraw(alice.getSender(), { value: env.fees.withdraw, amount: x })
        expectChainSucceeded(after)
        expect(logsOf<WithdrawnLog>(after.externals, LogTopic.withdrawn)[0].deferred).toBe(false)
        await expectSolvent(env)
    })
})

describe('AC 7c: positions cannot be moved after the seed', () => {
    it('a withdrawal from a low range after submit_randomness leaves every winner unchanged, but turns a win on its own withdrawn tickets into a miss', async () => {
        env = await setupJackpot()
        await players()
        // alice holds a low range and a high range, bob one in between
        await depositGram(env, alice, toNano('1000'))
        await depositGram(env, bob, toNano('1000'))
        await depositGram(env, alice, toNano('1000'))
        await nextRound(env, toNano('30'))
        await startDraw(env)
        await nextRound(env, toNano('30'))
        await startDraw(env, roundTime(drawRounds[0]) - 60)
        await submitRound(env, drawRounds[0])
        const draw = await env.jackpot.getDrawState()
        const snapshot = env.blockchain.snapshot()

        // the attempts 0 as they stand
        const first = async () => {
            const out: SlotLog[] = []
            for (const slot of [0, 1, 2]) {
                const r = await env.jackpot.sendLocate(env.keeper.getSender(), { value: env.fees.locate, slot })
                out.push(...slotLogs([r]))
            }
            return out
        }
        const plain = await first()

        // the same draw, after alice withdraws most of her low range
        await env.blockchain.loadFrom(snapshot)
        const x = toNano('600')
        const s = await env.jackpot.getSurcharge(0n, x)
        expectChainSucceeded(
            await rangeAt(env, 0n).sendWithdraw(alice.getSender(), { value: env.fees.withdraw + s, amount: x }),
        )
        const shifted = await first()

        const live0 = env.bookings[0].principal - x
        for (const slot of [0, 1, 2]) {
            const a = plain.find((l) => l.slot === slot && l.attempt === 0)!
            const b = shifted.find((l) => l.slot === slot && l.attempt === 0)!
            expect(b.position).toBe(a.position)
            expect(b.position).toBe(positionOf(draw.seed, slot, 0, draw.eligible))
            if (a.b === 0n && a.position >= live0) {
                // its own withdrawn ticket: a miss
                expect(b.result).toBe(SlotResult.miss)
            } else {
                expect([b.result, b.b, b.owner?.toString()]).toEqual([a.result, a.b, a.owner?.toString()])
            }
        }
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
        const claimable = await env.jackpot.getClaimableParts(alice.address)
        expect(claimable.other).toBeGreaterThan(0n)
        expect(claimable.prize).toBe(0n)
        expect((await env.jackpot.getBooks()).payouts.size).toBe(0)
        await expectSolvent(env)
        const claim = await env.jackpot.sendClaim(alice.getSender(), { value: env.fees.claim })
        expectChainSucceeded(claim)
        expect(await hgramOf(env, alice.address)).toBe(claimable.other)
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
            await env.jackpot.sendLocate(env.keeper.getSender(), { value: env.fees.locate, slot })
        }
        const owed = (await jackpotState(env)).burnOwed
        expect(owed).toBeGreaterThan(0n)
        const held = await walletTokens(env.blockchain, jw)
        // first hop: the Jackpot's wallet cannot pay at that moment
        const last = await deliver(
            env.blockchain,
            msg(env.keeper.address, env.jackpot.address, env.fees.locate, opBody(JackpotOp.locate, [2, 8])),
            {
                hold: (m) => isTo(m, jw, JackpotOp.sendTokens) && isBurn(m, env.burner.address),
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
        await resolveDraw(env)
        const payouts = (await env.jackpot.getBooks()).payouts
        const burn = [...payouts.entries()].find(([, p]) => p.kind === PayoutKind.burn)!
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
    it('one 3,000 GRAM booking and three 1,000 GRAM bookings by one owner cover the same positions and win the same slots', async () => {
        const outcomes: { positions: [string, bigint, bigint][]; wins: [number, string, bigint][] }[] = []
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
            const logs = slotLogs(await resolveDraw(env))
            const owners = new Map<string, string>(
                [alice, bob, carol].map((p, i) => [p.address.toString(), ['alice', 'bob', 'carol'][i]]),
            )
            // the positions each owner holds, in order of b, merged into intervals
            const positions: [string, bigint, bigint][] = []
            let at = 0n
            for (const b of [...env.bookings].sort((x, y) => (x.b < y.b ? -1 : 1))) {
                const prev = positions.length > 0 ? positions[positions.length - 1] : undefined
                const name = owners.get(b.owner.toString())!
                if (prev?.[0] === name && prev[2] === at) prev[2] = at + b.principal
                else positions.push([name, at, at + b.principal])
                at += b.principal
            }
            outcomes.push({
                positions,
                wins: logs
                    .filter((l) => l.result === SlotResult.hit)
                    .map((l) => [l.slot, owners.get(l.owner!.toString())!, l.position]),
            })
        }
        expect(outcomes[1].positions).toEqual(outcomes[0].positions)
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
        const logs = slotLogs(await resolveDraw(env))
        const hits = logs.filter((l) => l.result === SlotResult.hit)
        expect(hits.length).toBe(3)
        for (const h of hits) expect(h.owner!.equals(alice.address)).toBe(true)
        expect((await hgramOf(env, alice.address)) - before).toBe(draw.prizes[0] + draw.prizes[1] + draw.prizes[2])
    })
})

describe("AC 15: a withdrawal sent in the window before a slot's check reaches the range turns that attempt into a miss", () => {
    it('misses, and the next attempt follows', async () => {
        env = await setupJackpot()
        await players()
        await drawReady(env, [
            [alice, toNano('1000')],
            [bob, toNano('1000')],
        ])
        const a = await current(0)
        const owner = a.range.owner.equals(alice.address) ? alice : bob
        const located = await deliver(
            env.blockchain,
            msg(env.keeper.address, env.jackpot.address, env.fees.locate, opBody(JackpotOp.locate, [0, 8])),
            {
                hold: (m) => opOf(m) === JackpotOp.check,
            },
        )
        expect(located.held.length).toBe(1)
        const s = await env.jackpot.getSurcharge(a.range.b, a.range.principal)
        expectChainSucceeded(
            await rangeAt(env, a.range.b).sendWithdraw(owner.getSender(), {
                value: env.fees.withdraw + s,
                amount: 0n,
            }),
        )
        const answer = await deliver(env.blockchain, located.held)
        const logs = logsOf<SlotLog>(answer.externals, LogTopic.slot)
        expect(logs.map((l) => l.result)).toEqual([SlotResult.miss])
        const draw = await env.jackpot.getDrawState()
        expect(draw.attempts[0]).toBe(1)
        expect(draw.openSlots & 1).toBe(1)
        expect(await env.jackpot.getPosition(0)).toBe(positionOf(draw.seed, 0, 1, draw.eligible))
        const res = await env.jackpot.sendLocate(env.keeper.getSender(), { value: env.fees.locate, slot: 0 })
        expect(logsOf<SlotLog>(res.externals, LogTopic.slot).length).toBeGreaterThanOrEqual(1)
    })
})

describe('AC 16: locate for a closed slot or outside resolving changes no state; A misses roll the prize over and add it to carried, and so does expiry after one round; the next draw burns only new yield', () => {
    it('refuses such locates, rolls over after 16 misses, expires a slot after one round, and burns floor((pot − carried)·b_share/10000) next', async () => {
        // old enough that a later recorded drand round is left after the expiry's wait
        env = await setupAt(roundTime(drandRounds[0]) - 3600)
        await players()
        await depositGram(env, alice, toNano('1000'))
        await depositGram(env, bob, toNano('1000'))
        await nextRound(env, toNano('30'))
        await startDraw(env)
        // outside resolving
        const idle = await env.jackpot.sendLocate(env.keeper.getSender(), { value: env.fees.locate, slot: 0 })
        expect(idle.transactions).toHaveTransaction({ success: false, exitCode: JackpotError.notResolving })
        // carol books after the period opened: not in draw 1, but in draw 2
        await depositGram(env, carol, toNano('1000'))
        await nextRound(env, toNano('30'))
        await startDraw(env, roundTime(drandRounds[0]) - 60)
        await submitRound(env, drandRounds[0])
        const draw = await env.jackpot.getDrawState()

        // everyone eligible leaves in the window, with the surcharge: every attempt misses
        for (const b of env.bookings.filter((x) => x.b < draw.cutoff)) {
            const p = b.owner.equals(alice.address) ? alice : bob
            const s = await env.jackpot.getSurcharge(b.b, b.principal)
            await rangeAt(env, b.b).sendWithdraw(p.getSender(), { value: env.fees.withdraw + s, amount: 0n })
        }
        const before = await jackpotState(env)
        const results = []
        for (let j = 0; j < attemptsPerSlot; j++) {
            results.push(await env.jackpot.sendLocate(env.keeper.getSender(), { value: env.fees.locate, slot: 0 }))
        }
        const logs = slotLogs(results)
        expect(logs.filter((l) => l.result === SlotResult.miss).length).toBe(attemptsPerSlot - 1)
        expect(logs[logs.length - 1].result).toBe(SlotResult.rolledOver)
        let s = await jackpotState(env)
        expect(s.setAside).toBe(before.setAside - draw.prizes[0])
        expect(s.carried).toBe(before.carried + draw.prizes[0])

        // a closed slot
        const hash = await jackpotHash()
        const closed = await env.jackpot.sendLocate(env.keeper.getSender(), { value: env.fees.locate, slot: 0 })
        expect(closed.transactions).toHaveTransaction({ success: false, exitCode: JackpotError.slotClosed })
        expect(await jackpotHash()).toBe(hash)

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
        s = await jackpotState(env)
        const carried = draw.prizes[0] + draw.prizes[1] + draw.prizes[2]
        expect(s.carried).toBe(carried)
        await expectSolvent(env)

        // the next draw, carol's: its pot holds the carried prizes, and burns only the new yield
        await nextRound(env, toNano('30'))
        const later = drandRounds.find((r) => roundTime(r) - 60 > env.blockchain.now!)!
        const next = await startDraw(env, roundTime(later) - 60)
        const started = logsOf<DrawStartLog>(next.externals, LogTopic.drawStart)[0]
        expect(started.cutoff).toBeGreaterThan(0n)
        expect(started.carried).toBe(carried)
        expect(started.pot).toBeGreaterThan(carried)
        expect(started.burn).toBe(((started.pot - carried) * 1000n) / 10000n)
        expect((await jackpotState(env)).carried).toBe(0n)
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
            await resolveDraw(env)
        }
        console.log(`submit_randomness: ${accepted.toString()} rounds accepted, max gas ${maxGas.toString()}`)
        expect(accepted).toBeGreaterThanOrEqual(20)
        expect(maxGas).toBeLessThanOrEqual(200_000n)
    }, 600_000)
})

describe('AC 18: a draw cannot start twice in one validation round, nor with the rate unchanged, nor with a pot below m; it records the utime_since read when the reply arrives', () => {
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
                kNext: s.kNext,
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

    it("records the round current when the treasury's reply arrives, not when it was asked for", async () => {
        env = await setupJackpot({ fakeTreasury: true })
        await players()
        await depositHgram(env, alice, await mintHgram(env, alice, toNano('1000')))
        await replyQuote(env, await pendingQuote(env, QuoteKind.booking), 11n, 10n)
        await env.hipo.nextValidationRound()
        await startDraw(env)
        const asked = (await env.hipo.treasury.getTimes()).currentRoundSince
        await env.hipo.nextValidationRound()
        const replied = (await env.hipo.treasury.getTimes()).currentRoundSince
        expect(replied).toBeGreaterThan(asked)
        const r = await replyQuote(env, await pendingQuote(env, QuoteKind.draw), 12n, 10n)
        expect(logsOf<DrawStartLog>(r.externals, LogTopic.drawStart)[0].roundSince).toBe(replied)
        expect((await jackpotState(env)).lastRoundSince).toBe(replied)
    })
})

describe('AC 19: b_share above 2000 is refused, by the setter and at deploy, and so is min_deposit below 1; the burn reaches the burner as an hGRAM transfer carrying 0.5 GRAM', () => {
    it('refuses them, and burns with 0.5 GRAM forwarded', async () => {
        env = await setupJackpot({ config: { burnBatch: 0n } })
        await players()
        const refused = await env.jackpot.sendSetBurnShare(env.governor.getSender(), {
            value: toNano('0.05'),
            burnShare: 2001n,
        })
        expect(refused.transactions).toHaveTransaction({ success: false, exitCode: JackpotError.invalidParameters })
        const zero = await env.jackpot.sendSetMinDeposit(env.governor.getSender(), {
            value: toNano('0.05'),
            minDeposit: 0n,
        })
        expect(zero.transactions).toHaveTransaction({ success: false, exitCode: JackpotError.invalidParameters })
        const notGovernor = await env.jackpot.sendSetBurnShare(mallory.getSender(), {
            value: toNano('0.05'),
            burnShare: 2000n,
        })
        expect(notGovernor.transactions).toHaveTransaction({ success: false, exitCode: JackpotError.accessDenied })
        await drawReady(env, [[alice, toNano('1000')]])
        const owed = (await jackpotState(env)).burnOwed
        const results = await resolveDraw(env)
        const last = results[results.length - 1]
        expect(last.transactions).toHaveTransaction({
            from: await env.hipo.walletAddress(env.burner.address),
            to: env.burner.address,
            op: JackpotOp.transferNotification,
            value: (v) => v != null && v >= toNano('0.499') && v <= toNano('0.5'),
        })
        expect(await hgramOf(env, env.burner.address)).toBe(owed)
    })

    it('refuses a deploy with b_share 2001 or min_deposit 0', async () => {
        for (const config of [{ burnShare: 2001n }, { minDeposit: 0n }]) {
            await expect(setupJackpot({ config })).rejects.toThrow()
        }
    })
})

describe('AC 20: a GRAM deposit while Hipo is halted is refunded in full less gas; with instant_mint off a mint books at most cap, and a dust mint does not use up the record', () => {
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

    // Hipo mints a bill with the query_id of the message that burned the bills, not the deposit's. Under a
    // foreign query_id nothing is booked and the record waits for resolve_pending, which books at most the
    // record's cap; under the record's own query_id (anyone may choose it) the mint books at most the cap.
    it('books at most cap for a bill mint, and leaves a record whose mint came under another query_id for resolve_pending', async () => {
        env = await setupJackpot({ instantMint: false })
        await players()
        const now = BigInt(env.blockchain.now!)
        await setParticipations(env, [
            [now - 100000n, ParticipationState.ReadyToBurn],
            [now - 10n, ParticipationState.Open],
        ])
        await depositGram(env, alice, toNano('100'))
        await depositGram(env, bob, toNano('50'))
        const pending = (await env.jackpot.getBooks()).pending
        expect(pending.size).toBe(2)
        const [aliceId, aliceRecord] = [...pending.entries()].find(([, p]) => p.owner.equals(alice.address))!
        const [bobId, bobRecord] = [...pending.entries()].find(([, p]) => p.owner.equals(bob.address))!
        expect(aliceRecord.coins).toBe(toNano('100'))

        // the bills burn under bob's query_id: both mint under it; bob's record books at most its cap
        const burn = await env.hipo.treasury.sendParticipateInElection({ queryId: bobId, roundSince: now - 10n })
        expect(burn.transactions).toHaveTransaction({ to: env.jackpot.address, op: JackpotOp.transferNotification })
        const booked = logsOf<BookingLog>(burn.externals, LogTopic.booking)
        expect(booked.length).toBe(1)
        expect(booked[0].owner.equals(bob.address)).toBe(true)
        expect(booked[0].tokens).toBeLessThanOrEqual(bobRecord.cap)
        const left = (await env.jackpot.getBooks()).pending
        expect(left.has(aliceId)).toBe(true)
        expect(left.has(bobId)).toBe(false)

        // alice's waits for the governor, two rounds later, and books at most its cap
        const electedFor = getConfig(env.blockchain, 15n)!.beginParse().loadUint(32)
        env.blockchain.now! += 2 * electedFor
        const resolved = await env.jackpot.sendResolvePending(env.governor.getSender(), {
            value: env.fees.hgramDeposit,
            target: aliceId,
            tokens: aliceRecord.cap * 2n,
        })
        const aliceBooked = logsOf<BookingLog>(resolved.externals, LogTopic.booking)
        expect(aliceBooked.length).toBe(1)
        expect(aliceBooked[0].tokens).toBe(aliceRecord.cap)
        await expectSolvent(env)
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
        const logs = slotLogs(await resolveDraw(env))
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
    it('keeps every handler of a full flow within its budget, deploys ranges and nodes with their reserves, and keeps the Jackpot from growing with bookings (pins: tests/Gas.spec.ts, tests/Range.spec.ts)', async () => {
        env = await setupJackpot()
        await players()
        await drawReady(env, [
            [alice, toNano('1000')],
            [bob, toNano('1000')],
        ])
        const results = await resolveDraw(env)
        for (const r of results) {
            for (const tx of r.transactions) expect(gasOf(tx)).toBeLessThanOrEqual(60_000n)
        }
        for (const b of env.bookings) {
            expect(await rangeAt(env, b.b).getBalance()).toBeGreaterThanOrEqual(toNano('0.1'))
        }
        for (let level = 1; level <= treeLevels; level++) {
            expect(await nodeAt(env, level, 0n).getBalance()).toBeGreaterThanOrEqual(toNano('0.29'))
        }

        // the Jackpot's cells: the same after 20 more bookings and their withdrawals
        const cells = async () => {
            const state = (await env.blockchain.getContract(env.jackpot.address)).accountState
            if (state?.type !== 'active') throw new Error('not active')
            const seen = new Set<string>()
            const walk = (c: typeof state.state.data) => {
                if (c == null || seen.has(c.hash().toString('hex'))) return
                seen.add(c.hash().toString('hex'))
                c.refs.forEach(walk)
            }
            walk(state.state.data)
            return seen.size
        }
        const before = await cells()
        for (let i = 0; i < 20; i++) {
            const { booking } = await depositGram(env, carol, toNano('10'))
            await rangeAt(env, booking!.b).sendWithdraw(carol.getSender(), { value: env.fees.withdraw, amount: 0n })
        }
        expect(await cells()).toBe(before)
    })
})

describe('Upgrades: the migrate step runs in the same transaction; an upgrade the new code cannot read reverts', () => {
    it('reverts an upgrade to code that cannot read the layout, migrates a good one, and keeps the draw', async () => {
        env = await setupJackpot()
        await players()
        await drawReady(env, [[alice, toNano('1000')]])
        expect(await env.jackpot.getStorageVersion()).toBe(1)
        const draw = await env.jackpot.getDrawState()
        const before = await jackpotHash()
        const account = async () => (await env.blockchain.getContract(env.jackpot.address)).accountState

        // the range code has no migrate step; a cell that is not code at all fails too
        for (const code of [env.rangeCode, beginCell().storeUint(0xdeadbeef, 32).endCell()]) {
            const r = await env.jackpot.sendUpgradeCode(env.governor.getSender(), { value: toNano('0.1'), code })
            expect(r.transactions).toHaveTransaction({ to: env.jackpot.address, success: false })
            expect(await jackpotHash()).toBe(before)
            const state = await account()
            expect(state?.type === 'active' && state.state.code!.equals(env.jackpot.init!.code)).toBe(true)
        }
        // only the governor
        const stranger = await env.jackpot.sendUpgradeCode(mallory.getSender(), {
            value: toNano('0.1'),
            code: env.jackpot.init!.code,
        })
        expect(stranger.transactions).toHaveTransaction({ success: false, exitCode: JackpotError.accessDenied })

        // the same code: the migrate step reads version 1 and keeps everything, the running draw included
        const same = await env.jackpot.sendUpgradeCode(env.governor.getSender(), {
            value: toNano('0.1'),
            code: env.jackpot.init!.code,
        })
        expectChainSucceeded(same)
        expect(await jackpotHash()).toBe(before)
        expect(await env.jackpot.getDrawState()).toEqual(draw)
        const logs = slotLogs(await resolveDraw(env))
        expect(logs.filter((l) => l.result === SlotResult.hit).length).toBe(3)

        // a later version migrates in the upgrade's own transaction: version 2 at once
        const probe = await compile('UpgradeProbe')
        const next = await env.jackpot.sendUpgradeCode(env.governor.getSender(), { value: toNano('0.1'), code: probe })
        expectChainSucceeded(next)
        expect(
            next.transactions.filter((tx) => tx.inMessage?.info.dest?.toString() === env.jackpot.address.toString())
                .length,
        ).toBe(1)
        expect(await env.jackpot.getStorageVersion()).toBe(2)
    })
})

describe('AC 23: two money audits and a code review pass', () => {
    it.todo('is not a test: the audits and the review are separate work')
})

// A send_tokens from the Jackpot to its wallet whose recipient is the burner.
function isBurn(m: Message, burner: Player['address']): boolean {
    const s = m.body.beginParse()
    s.skip(32 + 64)
    s.loadCoins()
    return s.loadAddress().equals(burner)
}
