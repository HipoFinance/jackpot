/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests read state they just made */
// The attacks the spec's rules exist to stop ("Rules every message follows" and its audit history), each
// run the way an attacker would run it, against the real Hipo contracts.
import { Message, beginCell, toNano } from '@ton/core'
import { createShardAccount } from '@ton/sandbox'
import '@ton/test-utils'
import {
    BookingLog,
    DrawState,
    JackpotError,
    JackpotOp,
    LogTopic,
    SetupFailedLog,
    SlotLog,
    SlotResult,
    logsOf,
} from '../wrappers/Jackpot'
import { roundTime } from '../wrappers/drand'
import { ParticipationState } from './hipo/Treasury'
import {
    Env,
    depositGram,
    depositHgram,
    drawRounds,
    expectChainSucceeded,
    expectSolvent,
    hgramOf,
    jackpotState,
    mintHgram,
    nextRound,
    nodeAt,
    rangeAt,
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
    depositCoinsBody,
    drawReady,
    failed,
    gasExcessBody,
    hitBody,
    isFrom,
    isTo,
    jackpotWallet,
    lostBody,
    missBody,
    msg,
    notificationBody,
    opBody,
    queryIdOfMessage,
    quoteBody,
    rangeOf,
    rangeSetupBody,
    sendTokensBody,
    setParticipations,
    setWalletTokens,
    walletTokens,
    withdrawnBody,
} from './jackpot/adversary'

let env: Env
let alice: Player
let bob: Player
let mallory: Player

async function setup(opts: Parameters<typeof setupJackpot>[0] = {}) {
    env = await setupJackpot(opts)
    alice = await env.blockchain.treasury('alice')
    bob = await env.blockchain.treasury('bob')
    mallory = await env.blockchain.treasury('mallory')
}

const jackpotHash = () => dataHash(env.blockchain, env.jackpot.address)

// The current attempt of a slot: its position, and the range and offset the tree puts it at.
async function current(slot: number) {
    const draw = await env.jackpot.getDrawState()
    const k = await env.jackpot.getPosition(slot)
    const range = (await rangeOf(env, k))!
    return { draw: draw.drawId, slot, j: draw.attempts[slot], k, range }
}

describe('Attacks on the draw', () => {
    beforeEach(async () => {
        await setup()
        await drawReady(env, [
            [alice, toNano('1000')],
            [bob, toNano('1000')],
        ])
        expect((await env.jackpot.getDrawState()).state).toBe(DrawState.resolving)
    })

    it('a player who sends check to their own range gets no answer and changes nothing', async () => {
        const a = await current(0)
        const owner = a.range.owner.equals(alice.address) ? alice : bob
        const before = {
            jackpot: await jackpotHash(),
            range: await dataHash(env.blockchain, rangeAt(env, a.range.b).address),
        }
        const balance = await hgramOf(env, owner.address)

        const result = await owner.send({
            to: rangeAt(env, a.range.b).address,
            value: toNano('1'),
            body: checkBody({ ...a, offset: 0n }),
        })
        expect(result.transactions).toHaveTransaction({
            to: rangeAt(env, a.range.b).address,
            success: false,
            exitCode: JackpotError.accessDenied,
        })
        expect(result.transactions).not.toHaveTransaction({ to: env.jackpot.address, op: JackpotOp.hit })
        expect(await jackpotHash()).toBe(before.jackpot)
        expect(await dataHash(env.blockchain, rangeAt(env, a.range.b).address)).toBe(before.range)
        expect(await hgramOf(env, owner.address)).toBe(balance)
    })

    it('a forged hit, miss or lost sent straight to the Jackpot pays nothing and advances no attempt', async () => {
        const before = await jackpotHash()
        const draw = await env.jackpot.getDrawState()
        for (const slot of [0, 1, 2]) {
            const a = await current(slot)
            // the exact replies a range or a node would send, but from the player
            for (const body of [
                hitBody({ ...a, b: a.range.b, owner: mallory.address }),
                missBody({ ...a, b: a.range.b }),
                lostBody({ ...a, level: 1, index: 0n }),
            ]) {
                const r = await mallory.send({ to: env.jackpot.address, value: toNano('1'), body })
                expectChainSucceeded(r) // never throws, ignores
                expect(r.transactions).not.toHaveTransaction({ from: env.jackpot.address, op: JackpotOp.sendTokens })
            }
        }
        expect(await jackpotHash()).toBe(before)
        expect(await env.jackpot.getDrawState()).toEqual(draw)
        expect(await hgramOf(env, mallory.address)).toBe(0n)
    })

    it('a duplicate hit for a slot already closed pays nothing', async () => {
        const a = await current(0)
        const winner = a.range.owner
        const [p0] = (await env.jackpot.getDrawState()).prizes
        const before = await hgramOf(env, winner)
        const locate = () =>
            msg(env.keeper.address, env.jackpot.address, env.fees.locate, opBody(JackpotOp.locate, [0, 8]))
        // two locates for the same attempt: both checks are in flight before either answer comes back
        const holdChecks = (m: Message) => opBodyOf(m) === JackpotOp.check
        const first = await deliver(env.blockchain, locate(), { hold: holdChecks })
        const second = await deliver(env.blockchain, locate(), { hold: holdChecks })
        expect(first.held.length + second.held.length).toBe(2)
        const replies = await deliver(env.blockchain, [...first.held, ...second.held])
        const hits = replies.transactions.filter(
            (tx) => tx.inMessage != null && isTo(tx.inMessage, env.jackpot.address, JackpotOp.hit),
        )
        expect(hits.length).toBe(2) // both checks answered
        const slotLogs = logsOf<SlotLog>(replies.externals, LogTopic.slot)
        expect(slotLogs.map((l) => l.result)).toEqual([SlotResult.hit])
        expect(await hgramOf(env, winner)).toBe(before + p0)
        expect(failed(replies.transactions)).toEqual([])
        expect((await env.jackpot.getDrawState()).openSlots & 1).toBe(0)
    })

    it("a late joiner's range, even answering as itself about the current attempt, is ignored and wins nothing", async () => {
        const late = await env.blockchain.treasury('late')
        const { booking } = await depositGram(env, late, toNano('100000'))
        const draw = await env.jackpot.getDrawState()
        expect(booking!.b).toBeGreaterThanOrEqual(draw.cutoff)
        const before = await jackpotHash()
        for (const slot of [0, 1, 2]) {
            const a = await current(slot)
            const forged = await deliver(
                env.blockchain,
                msg(
                    rangeAt(env, booking!.b).address,
                    env.jackpot.address,
                    toNano('0.1'),
                    hitBody({ ...a, b: booking!.b, owner: late.address }),
                ),
            )
            expect(failed(forged.transactions)).toEqual([])
        }
        expect(await jackpotHash()).toBe(before)
        const logs = (await resolveDraw(env)).flatMap((r) => logsOf<SlotLog>(r.externals, LogTopic.slot))
        expect(logs.filter((l) => l.result === SlotResult.hit).length).toBe(3)
        for (const l of logs) expect(l.owner?.equals(late.address) ?? false).toBe(false)
        expect(await hgramOf(env, late.address)).toBe(0n)
    })
})

describe('Attacks on the ranges and the replies', () => {
    beforeEach(async () => {
        await setup()
        await depositGram(env, alice, toNano('100'))
    })

    it('a range setup by a stranger, or a second setup even from the Jackpot, is refused', async () => {
        const range = rangeAt(env, 0n)
        const before = await dataHash(env.blockchain, range.address)
        const stranger = await mallory.send({
            to: range.address,
            value: toNano('0.2'),
            body: rangeSetupBody(mallory.address, toNano('1000000')),
        })
        expect(stranger.transactions).toHaveTransaction({
            to: range.address,
            success: false,
            exitCode: JackpotError.accessDenied,
        })
        // the same message as the Jackpot would send it (not bounceable: a bounce would reach the real
        // Jackpot as the failure of its own setup, which only the Jackpot's own message can cause)
        const second = await deliver(
            env.blockchain,
            msg(
                env.jackpot.address,
                range.address,
                toNano('0.2'),
                rangeSetupBody(mallory.address, toNano('1000000')),
                false,
            ),
        )
        expect(second.transactions).toHaveTransaction({
            to: range.address,
            success: false,
            exitCode: JackpotError.alreadySetUp,
        })
        expect(await dataHash(env.blockchain, range.address)).toBe(before)

        // a squatter at the next booking's address cannot set it up either
        const next = rangeAt(env, (await jackpotState(env)).nextBooking)
        const squat = await mallory.send({
            to: next.address,
            value: toNano('0.2'),
            init: next.init,
            body: rangeSetupBody(mallory.address, 1n),
        })
        expect(squat.transactions).toHaveTransaction({
            to: next.address,
            success: false,
            exitCode: JackpotError.accessDenied,
        })
        const { booking } = await depositGram(env, bob, toNano('50'))
        expect((await rangeAt(env, booking!.b).getRangeData()).owner!.equals(bob.address)).toBe(true)
    })

    it('a forged withdrawn, quote or mint notification from a stranger changes nothing', async () => {
        const before = await jackpotHash()
        const withdrawn = await mallory.send({
            to: env.jackpot.address,
            value: toNano('1'),
            body: withdrawnBody(toNano('100'), 0n, mallory.address),
        })
        expect(withdrawn.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.accessDenied,
        })

        // a live quote record, then a reply from the attacker at a rate of their choosing
        const tokens = await mintHgram(env, bob, toNano('50'))
        const transfer = await deliver(
            env.blockchain,
            msg(
                bob.address,
                await env.hipo.walletAddress(bob.address),
                toNano('0.5'),
                sendTokensBody({
                    amount: tokens,
                    recipient: env.jackpot.address,
                    returnExcess: bob.address,
                    forward: env.fees.hgramDeposit,
                }),
            ),
            { hold: (m) => isTo(m, env.jackpot.address, JackpotOp.takeCurrentQuote) },
        )
        expect(transfer.held.length).toBe(1)
        const id = queryIdOfMessage(transfer.held[0])
        const mid = await jackpotHash()
        expect(mid).not.toBe(before)
        await mallory.send({ to: env.jackpot.address, value: toNano('1'), body: quoteBody(id, 1000n, 1n) })
        await mallory.send({
            to: env.jackpot.address,
            value: toNano('1'),
            body: notificationBody(id, toNano('1000000'), mallory.address),
        })
        await mallory.send({
            to: env.jackpot.address,
            value: toNano('1'),
            body: notificationBody(id, toNano('1000000'), env.jackpot.address),
        })
        expect(await jackpotHash()).toBe(mid)
        // the real reply still books, at the real rate
        const reply = await deliver(env.blockchain, transfer.held)
        const booked = logsOf<BookingLog>(reply.externals, LogTopic.booking)
        expect(booked.length).toBe(1)
        expect(booked[0].owner.equals(bob.address)).toBe(true)
        await expectSolvent(env)
    })
})

describe('Attacks on deposits', () => {
    beforeEach(async () => {
        await setup()
    })

    it('a zero hGRAM deposit books nothing, and one below the minimum is returned; the next booking gets range 0', async () => {
        const tokens = await mintHgram(env, alice, toNano('50'))
        const before = await counters(env)
        const zero = await depositHgram(env, alice, 0n)
        expect(zero.booking).toBeUndefined()
        expect(await counters(env)).toEqual(before)

        const small = await depositHgram(env, alice, toNano('5'))
        expectChainSucceeded(small.result)
        expect(small.booking).toBeUndefined()
        expect(await hgramOf(env, alice.address)).toBe(tokens)
        expect(await counters(env)).toMatchObject({ T: 0n, I: 0n, O: 0n, P: 0n, N: 0n })

        const gram = await env.jackpot.sendDeposit(alice.getSender(), { value: toNano('9.99') + env.fees.deposit })
        expect(gram.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.depositTooSmall,
        })

        const ok = await depositHgram(env, alice, tokens)
        expect(ok.booking!.b).toBe(0n)
        const w = await rangeAt(env, 0n).sendWithdraw(alice.getSender(), { value: env.fees.withdraw, amount: 0n })
        expectChainSucceeded(w)
        expect(await hgramOf(env, alice.address)).toBe(tokens)
    })

    it('a GRAM deposit from the masterchain is refunded and never reaches Hipo', async () => {
        const mc = await env.blockchain.treasury('mc', { workchain: -1 })
        const before = await jackpotHash()
        const balance = await mc.getBalance()
        const result = await env.jackpot.sendDeposit(mc.getSender(), { value: toNano('100') + env.fees.deposit })
        expectChainSucceeded(result)
        expect(result.transactions).not.toHaveTransaction({ to: env.hipo.treasury.address })
        expect(result.transactions).toHaveTransaction({ from: env.jackpot.address, to: mc.address })
        expect(await jackpotHash()).toBe(before)
        // what it lost is gas and the masterchain's forwarding fees
        expect(balance - (await mc.getBalance())).toBeLessThan(toNano('0.1'))
    })

    // Anyone can mint hGRAM to the Jackpot with deposit_coins(owner = Jackpot, query_id = X), and the
    // notification looks exactly like the Jackpot's own mint. X is public once the Jackpot sends its
    // deposit_coins: the test holds the Jackpot's message back to stand for a delay between shards. A mint
    // below 99% of the record's cap does not use the record up, so the real mint still books in full.
    it("a dust mint under a pending deposit's public query_id leaves the record for the real mint", async () => {
        const run = await deliver(
            env.blockchain,
            msg(alice.address, env.jackpot.address, toNano('100') + env.fees.deposit, opBody(JackpotOp.deposit)),
            {
                hold: (m) => isTo(m, env.hipo.treasury.address, JackpotOp.depositCoins),
            },
        )
        const x = queryIdOfMessage(run.held[0])
        // the attacker mints 1 GRAM worth to the Jackpot under X
        const attack = await deliver(
            env.blockchain,
            msg(
                mallory.address,
                env.hipo.treasury.address,
                toNano('1.1'),
                depositCoinsBody(x, env.jackpot.address, toNano('1')),
            ),
        )
        expect(logsOf<BookingLog>(attack.externals, LogTopic.booking)).toEqual([])
        expect((await env.jackpot.getBooks()).pending.has(x)).toBe(true)
        // the real mint arrives and books alice's deposit; the dust stays outside T, for the governor
        await deliver(env.blockchain, run.held)
        const c = await counters(env)
        const real = await walletTokens(env.blockchain, await jackpotWallet(env))
        expect(c.P).toBeGreaterThanOrEqual(toNano('99'))
        expect(real - c.T).toBeGreaterThanOrEqual(toNano('0.9'))
        await expectSolvent(env)
    })
})

describe('Attacks with instant_mint off', () => {
    // A round that has settled but still holds its bills (ready_to_burn: it waits behind Hipo's reward
    // barrier), and an empty next round that anyone may push into the election. Deposits made now become
    // bills of the first round and mint when its bills burn.
    beforeEach(async () => {
        await setup({ instantMint: false })
        const now = BigInt(env.blockchain.now!)
        await setParticipations(env, [
            [now - 100000n, ParticipationState.ReadyToBurn],
            [now - 10n, ParticipationState.Open],
        ])
    })

    // Hipo's bill mints carry the query_id of the message that started the burn, not the deposit's. That
    // message is the treasury's external participate_in_election (or finish_participation), which anyone
    // may send with any query_id. The attacker deposits a little after the victim, reads their own
    // pending query_id, and starts the burn under it. The mint books at most the attacker's own cap; the
    // rest stays outside T, and the victim's record waits for resolve_pending.
    it("an attacker who starts Hipo's bill burn under their own pending query_id is booked no more than their own deposit", async () => {
        await depositGram(env, alice, toNano('1000'))
        const run = await deliver(
            env.blockchain,
            msg(mallory.address, env.jackpot.address, toNano('10') + env.fees.deposit, opBody(JackpotOp.deposit)),
        )
        const out = run.transactions
            .flatMap((t) => [...t.outMessages.values()])
            .find((m) => isFrom(m, env.jackpot.address, JackpotOp.depositCoins))!
        const x = queryIdOfMessage(out)
        const pending = (await env.jackpot.getBooks()).pending
        expect(pending.size).toBe(2)
        const aliceRecord = [...pending.keys()].find((k) => k !== x)!

        const now = BigInt(env.blockchain.now!)
        const burn = await env.hipo.treasury.sendParticipateInElection({ queryId: x, roundSince: now - 10n })
        const booked = logsOf<BookingLog>(burn.externals, LogTopic.booking)
        const malloryPrincipal = booked
            .filter((b) => b.owner.equals(mallory.address))
            .reduce((a, b) => a + b.principal, 0n)
        expect(booked.filter((b) => b.owner.equals(alice.address))).toEqual([])
        expect(malloryPrincipal).toBeLessThanOrEqual(toNano('10'))
        expect(malloryPrincipal).toBeGreaterThanOrEqual(toNano('9.9'))
        // alice's record is still there, for the governor
        expect((await env.jackpot.getBooks()).pending.has(aliceRecord)).toBe(true)
        await expectSolvent(env)
    })
})

describe('Attacks on fees', () => {
    beforeEach(async () => {
        await setup()
    })

    it('underfunded locate, start_draw, requote and withdraw are refused with no state change; the bare fee runs to the end', async () => {
        await drawReady(env, [
            [alice, toNano('1000')],
            [bob, toNano('1000')],
        ])
        const short = (fee: bigint) => fee - 1n
        let before = await jackpotHash()

        // locate
        let res = await env.jackpot.sendLocate(mallory.getSender(), { value: short(env.fees.locate), slot: 0 })
        expect(res.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.insufficientFee,
        })
        expect(await jackpotHash()).toBe(before)
        res = await env.jackpot.sendLocate(mallory.getSender(), { value: env.fees.locate, slot: 0 })
        expectChainSucceeded(res)
        expect(logsOf<SlotLog>(res.externals, LogTopic.slot).length).toBe(1)

        // withdraw, at the range: in the draw's window, from an eligible range, so the fee and the surcharge
        const rangeOfAlice = rangeAt(env, 0n)
        const surcharge = await env.jackpot.getSurcharge(0n, toNano('10'))
        expect(surcharge).toBeGreaterThan(0n)
        const rangeBefore = await dataHash(env.blockchain, rangeOfAlice.address)
        before = await jackpotHash()
        res = await rangeOfAlice.sendWithdraw(alice.getSender(), {
            value: short(env.fees.withdraw),
            amount: toNano('10'),
        })
        expect(res.transactions).toHaveTransaction({
            to: rangeOfAlice.address,
            success: false,
            exitCode: JackpotError.insufficientFee,
        })
        expect(await dataHash(env.blockchain, rangeOfAlice.address)).toBe(rangeBefore)
        expect(await jackpotHash()).toBe(before)
        const held = await hgramOf(env, alice.address)
        res = await rangeOfAlice.sendWithdraw(alice.getSender(), {
            value: env.fees.withdraw + surcharge,
            amount: toNano('10'),
        })
        expectChainSucceeded(res)
        expect(await hgramOf(env, alice.address)).toBeGreaterThan(held)

        // requote: a booking whose reply is dropped
        const tokens = await mintHgram(env, bob, toNano('100'))
        await deliver(
            env.blockchain,
            msg(
                bob.address,
                await env.hipo.walletAddress(bob.address),
                toNano('0.5'),
                sendTokensBody({
                    amount: tokens,
                    recipient: env.jackpot.address,
                    returnExcess: bob.address,
                    forward: env.fees.hgramDeposit,
                }),
            ),
            { hold: (m) => isTo(m, env.jackpot.address, JackpotOp.takeCurrentQuote) },
        )
        const [lost] = [...(await env.jackpot.getBooks()).quotes.keys()]
        env.blockchain.now! += 600
        before = await jackpotHash()
        res = await env.jackpot.sendRequote(mallory.getSender(), { value: short(env.fees.requote), target: lost })
        expect(res.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.insufficientFee,
        })
        expect(await jackpotHash()).toBe(before)
        res = await env.jackpot.sendRequote(mallory.getSender(), { value: env.fees.requote, target: lost })
        expectChainSucceeded(res)
        expect(logsOf<BookingLog>(res.externals, LogTopic.booking).length).toBe(1)

        // start_draw: finish the running draw, then a new round
        for (let guard = 0; guard < 200; guard++) {
            const d = await env.jackpot.getDrawState()
            if (d.openSlots === 0) break
            const slot = [0, 1, 2].find((i) => (d.openSlots >> i) & 1)!
            await env.jackpot.sendLocate(env.keeper.getSender(), { value: env.fees.locate, slot })
        }
        await nextRound(env, toNano('30'))
        env.blockchain.now = roundTime(drawRounds[1]) - 60
        before = await jackpotHash()
        res = await env.jackpot.sendStartDraw(mallory.getSender(), { value: short(env.fees.startDraw) })
        expect(res.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.insufficientFee,
        })
        expect(await jackpotHash()).toBe(before)
        res = await env.jackpot.sendStartDraw(mallory.getSender(), { value: env.fees.startDraw })
        expectChainSucceeded(res)
        expect((await env.jackpot.getDrawState()).state).toBe(DrawState.waiting)
    })

    it('requote spam and late replies to voided query_ids book and pay each record exactly once', async () => {
        await depositGram(env, alice, toNano('500'))
        const tokens = await mintHgram(env, bob, toNano('100'))
        const holdQuotes = (m: Message) => isTo(m, env.jackpot.address, JackpotOp.takeCurrentQuote)
        const first = await deliver(
            env.blockchain,
            msg(
                bob.address,
                await env.hipo.walletAddress(bob.address),
                toNano('0.5'),
                sendTokensBody({
                    amount: tokens,
                    recipient: env.jackpot.address,
                    returnExcess: bob.address,
                    forward: env.fees.hgramDeposit,
                }),
            ),
            { hold: holdQuotes },
        )
        const replies = [...first.held]
        let target = queryIdOfMessage(replies[0])
        for (let i = 0; i < 3; i++) {
            // too soon: refused
            const early = await env.jackpot.sendRequote(mallory.getSender(), { value: env.fees.requote, target })
            expect(early.transactions).toHaveTransaction({
                to: env.jackpot.address,
                success: false,
                exitCode: JackpotError.tooSoon,
            })
            env.blockchain.now! += 600
            const again = await deliver(
                env.blockchain,
                msg(mallory.address, env.jackpot.address, env.fees.requote, opBody(JackpotOp.requote, [target, 64])),
                { hold: holdQuotes },
            )
            expect(again.held.length).toBe(1)
            replies.push(...again.held)
            target = queryIdOfMessage(again.held[0])
            // a voided id cannot be requoted
            const voided = await env.jackpot.sendRequote(mallory.getSender(), {
                value: env.fees.requote,
                target: queryIdOfMessage(replies[i]),
            })
            expect(voided.transactions).toHaveTransaction({
                to: env.jackpot.address,
                success: false,
                exitCode: JackpotError.unknownQuery,
            })
        }
        // every reply arrives, the live one last, and each one twice
        const order = [replies[2], replies[0], replies[1], replies[0], replies[3], replies[3], replies[1]]
        const late = await deliver(env.blockchain, order)
        expect(failed(late.transactions)).toEqual([])
        const booked = logsOf<BookingLog>(late.externals, LogTopic.booking)
        expect(booked.length).toBe(1)
        expect(booked[0].owner.equals(bob.address)).toBe(true)
        expect((await env.jackpot.getBooks()).quotes.size).toBe(0)
        await expectSolvent(env)

        // the same for a withdrawal: three late replies pay once
        const w = await deliver(
            env.blockchain,
            msg(
                bob.address,
                rangeAt(env, booked[0].b).address,
                env.fees.withdraw,
                opBody(JackpotOp.withdraw).asBuilder().storeCoins(0).endCell(),
            ),
            { hold: holdQuotes },
        )
        expect(w.held.length).toBe(1)
        env.blockchain.now! += 600
        const rq = await deliver(
            env.blockchain,
            msg(
                mallory.address,
                env.jackpot.address,
                env.fees.requote,
                opBody(JackpotOp.requote, [queryIdOfMessage(w.held[0]), 64]),
            ),
            { hold: holdQuotes },
        )
        const before = await hgramOf(env, bob.address)
        await deliver(env.blockchain, [w.held[0], rq.held[0], w.held[0], rq.held[0]])
        const paid = (await hgramOf(env, bob.address)) - before
        expect(paid).toBeGreaterThan(0n)
        expect(paid).toBeLessThanOrEqual(tokens)
        expect((await env.jackpot.getBooks()).quotes.size).toBe(0)
        await expectSolvent(env)
    })
})

describe('Attacks on payouts', () => {
    let held: bigint // hGRAM alice holds outside the Jackpot, so that her wallet exists

    beforeEach(async () => {
        await setup()
        await depositGram(env, alice, toNano('100'))
        held = await mintHgram(env, alice, toNano('1'))
    })

    async function failedSecondHop() {
        const repair = await breakWalletOf(env, alice.address)
        const res = await rangeAt(env, 0n).sendWithdraw(alice.getSender(), {
            value: env.fees.withdraw,
            amount: toNano('40'),
        })
        const { payouts } = await env.jackpot.getBooks()
        expect(payouts.size).toBe(1)
        const [[id, record]] = [...payouts.entries()]
        expect(record.recipient.equals(alice.address)).toBe(true)
        return { repair, res, id, amount: record.amount }
    }

    it('a payout whose second hop fails stays open through forged confirmations, until the governor settles it; two claims pay once', async () => {
        const { repair, id, amount } = await failedSecondHop()
        const jw = await jackpotWallet(env)
        let c = await counters(env)
        expect(await walletTokens(env.blockchain, jw)).toBe(c.T + amount) // the tokens came back, outside T

        // a gas_excess from a stranger
        await mallory.send({ to: env.jackpot.address, value: toNano('0.1'), body: gasExcessBody(id) })
        // one made through the Jackpot's own wallet: 0 hGRAM to the Jackpot, return_excess = Jackpot
        await mintHgram(env, mallory, toNano('20'))
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
        expect(forged.transactions).toHaveTransaction({ from: jw, to: env.jackpot.address, op: JackpotOp.gasExcess })
        // and again with a notification
        await deliver(
            env.blockchain,
            msg(
                mallory.address,
                await env.hipo.walletAddress(mallory.address),
                toNano('0.5'),
                sendTokensBody({
                    queryId: id,
                    amount: 0n,
                    recipient: env.jackpot.address,
                    returnExcess: env.jackpot.address,
                    forward: env.fees.hgramDeposit,
                }),
            ),
        )
        expect((await env.jackpot.getBooks()).payouts.get(id)).toBeDefined()
        expect(await env.jackpot.getClaimable(alice.address)).toBe(0n)
        expect(await counters(env)).toEqual(c)

        // only the governor settles
        const notGovernor = await env.jackpot.sendSettleFailedPayout(mallory.getSender(), {
            value: toNano('0.1'),
            target: id,
        })
        expect(notGovernor.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.accessDenied,
        })
        const settled = await env.jackpot.sendSettleFailedPayout(env.governor.getSender(), {
            value: toNano('0.1'),
            target: id,
        })
        expectChainSucceeded(settled)
        expect(await env.jackpot.getClaimable(alice.address)).toBe(amount)
        c = await counters(env)
        expect(await walletTokens(env.blockchain, jw)).toBe(c.T)
        const twice = await env.jackpot.sendSettleFailedPayout(env.governor.getSender(), {
            value: toNano('0.1'),
            target: id,
        })
        expect(twice.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.unknownQuery,
        })
        await expectSolvent(env)

        // alice's wallet works again; two claims in flight together pay once
        await repair()
        const claim = () => msg(alice.address, env.jackpot.address, env.fees.claim, opBody(JackpotOp.claim))
        const claims = await deliver(env.blockchain, [claim(), claim()])
        expect(claims.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.nothingToClaim,
        })
        expect(await walletTokens(env.blockchain, await env.hipo.walletAddress(alice.address))).toBe(held + amount)
        expect((await env.jackpot.getBooks()).payouts.size).toBe(0)
        await expectSolvent(env)
    })

    // Hipo's wallet sends gas_excess to whatever return_excess a transfer names, so anyone can make the
    // RECIPIENT's own wallet send one with any query_id: 0 hGRAM to the recipient, return_excess = Jackpot.
    // That is the one source the Jackpot trusts, and it deletes the record and credits nothing (spec,
    // amendment 6). A payout whose second hop failed can then no longer be settled; its tokens are outside T
    // and the governor returns them with return_tokens.
    it("a confirmation forged through the recipient's own wallet deletes the record and credits nothing; return_tokens recovers the tokens", async () => {
        const { repair, id, amount } = await failedSecondHop()
        await repair()
        const before = await counters(env)
        await mintHgram(env, mallory, toNano('20'))
        await deliver(
            env.blockchain,
            msg(
                mallory.address,
                await env.hipo.walletAddress(mallory.address),
                toNano('0.2'),
                sendTokensBody({
                    queryId: id,
                    amount: 0n,
                    recipient: alice.address,
                    returnExcess: env.jackpot.address,
                }),
            ),
        )
        expect((await env.jackpot.getBooks()).payouts.has(id)).toBe(false)
        expect(await counters(env)).toEqual(before)
        expect(await env.jackpot.getClaimable(alice.address)).toBe(0n)
        const settled = await env.jackpot.sendSettleFailedPayout(env.governor.getSender(), {
            value: toNano('0.1'),
            target: id,
        })
        expect(settled.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.unknownQuery,
        })
        // the tokens are in the Jackpot's wallet outside T; the governor returns them
        const jw = await jackpotWallet(env)
        expect(await walletTokens(env.blockchain, jw)).toBe(before.T + amount)
        const aliceBefore = await hgramOf(env, alice.address)
        expectChainSucceeded(
            await env.jackpot.sendReturnTokens(env.governor.getSender(), {
                value: env.fees.claim,
                owner: alice.address,
                amount,
            }),
        )
        expect(await hgramOf(env, alice.address)).toBe(aliceBefore + amount)
        expect(await walletTokens(env.blockchain, jw)).toBe(before.T)
        await expectSolvent(env)
    })
})

function opBodyOf(m: Message): number | undefined {
    const s = m.body.beginParse()
    return s.remainingBits >= 32 ? s.loadUint(32) : undefined
}

describe('Governor recovery paths: resolve_pending, return_tokens, set_hipo_wallet', () => {
    beforeEach(async () => {
        await setup()
    })

    it('resolve_pending books a deposit whose mint notification was lost, once, and only for the governor after two rounds', async () => {
        const jw = await jackpotWallet(env)
        const lost = await deliver(
            env.blockchain,
            msg(alice.address, env.jackpot.address, toNano('100') + env.fees.deposit, opBody(JackpotOp.deposit)),
            { hold: (m) => isFrom(m, jw, JackpotOp.transferNotification) },
        )
        expect(lost.held.length).toBe(1)
        const [target] = [...(await env.jackpot.getBooks()).pending.keys()]
        const body = lost.held[0].body.beginParse()
        body.skip(32 + 64)
        const minted = body.loadCoins()
        expect(await walletTokens(env.blockchain, jw)).toBe(minted)
        expect((await counters(env)).T).toBe(0n)

        const resolve = (from: Player, value: bigint, t = target, tokens = minted) =>
            env.jackpot.sendResolvePending(from.getSender(), { value, target: t, tokens })
        let res = await resolve(mallory, env.fees.hgramDeposit)
        expect(res.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.accessDenied,
        })
        res = await resolve(env.governor, env.fees.hgramDeposit)
        expect(res.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.tooSoon,
        })
        const times = await env.hipo.treasury.getTimes()
        const electedFor = times.nextRoundSince - times.currentRoundSince
        env.blockchain.now! += Number(2n * electedFor)
        res = await resolve(env.governor, env.fees.hgramDeposit - 1n)
        expect(res.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.insufficientFee,
        })
        res = await resolve(env.governor, env.fees.hgramDeposit, target + 1n)
        expect(res.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.unknownQuery,
        })
        res = await resolve(env.governor, env.fees.hgramDeposit, target, 0n)
        expect(res.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.invalidParameters,
        })

        res = await resolve(env.governor, env.fees.hgramDeposit)
        expectChainSucceeded(res)
        const booked = logsOf<BookingLog>(res.externals, LogTopic.booking)
        expect(booked.length).toBe(1)
        expect(booked[0].owner.equals(alice.address)).toBe(true)
        expect(booked[0].tokens).toBe(minted)
        // the late notification finds no record
        const late = await deliver(env.blockchain, lost.held)
        expect(logsOf<BookingLog>(late.externals, LogTopic.booking)).toEqual([])
        expect((await counters(env)).T).toBe(minted)
        await expectSolvent(env)
        expect(await walletTokens(env.blockchain, jw)).toBe(minted)
    })

    it("return_tokens gives back hGRAM that arrived without a notification, only on the governor's word", async () => {
        const tokens = await mintHgram(env, alice, toNano('50'))
        // a transfer with no forward: the Jackpot never hears of it
        await deliver(
            env.blockchain,
            msg(
                alice.address,
                await env.hipo.walletAddress(alice.address),
                toNano('0.2'),
                sendTokensBody({ amount: tokens, recipient: env.jackpot.address, returnExcess: alice.address }),
            ),
        )
        const jw = await jackpotWallet(env)
        expect(await walletTokens(env.blockchain, jw)).toBe(tokens)
        expect((await counters(env)).T).toBe(0n)
        const value = env.fees.claim - toNano('0.05') // return_tokens: fee::handler + fee::payout
        let res = await env.jackpot.sendReturnTokens(mallory.getSender(), {
            value,
            owner: mallory.address,
            amount: tokens,
        })
        expect(res.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.accessDenied,
        })
        res = await env.jackpot.sendReturnTokens(env.governor.getSender(), { value, owner: alice.address, amount: 0n })
        expect(res.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.invalidParameters,
        })
        res = await env.jackpot.sendReturnTokens(env.governor.getSender(), {
            value: value - 1n,
            owner: alice.address,
            amount: tokens,
        })
        expect(res.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.insufficientFee,
        })
        res = await env.jackpot.sendReturnTokens(env.governor.getSender(), {
            value,
            owner: alice.address,
            amount: tokens,
        })
        expectChainSucceeded(res)
        expect(await hgramOf(env, alice.address)).toBe(tokens)
        expect((await counters(env)).T).toBe(0n)
        expect((await env.jackpot.getBooks()).payouts.size).toBe(0)
        await expectSolvent(env)
    })

    it("set_hipo_wallet is the governor's alone, and moves which wallet the Jackpot trusts and pays from", async () => {
        await depositGram(env, alice, toNano('100'))
        const [, , , , walletCode] = await env.hipo.parent.getJettonData()
        const oldWallet = await jackpotWallet(env)
        const newWallet = await env.blockchain.treasury('new-wallet')
        const set = (from: Player, wallet: Player['address']) =>
            env.jackpot.sendSetHipoWallet(from.getSender(), {
                value: toNano('0.05'),
                parent: env.hipo.parent.address,
                wallet,
                walletCode,
            })
        const refused = await set(mallory, mallory.address)
        expect(refused.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.accessDenied,
        })
        expect((await env.jackpot.getAddresses()).wallet.equals(oldWallet)).toBe(true)

        expectChainSucceeded(await set(env.governor, newWallet.address))
        expect((await env.jackpot.getAddresses()).wallet.equals(newWallet.address)).toBe(true)
        // the old wallet is no longer heard
        const before = await counters(env)
        const tokens = await mintHgram(env, bob, toNano('50'))
        const old = await depositHgram(env, bob, tokens)
        expect(old.booking).toBeUndefined()
        expect(await counters(env)).toEqual(before)
        // payouts now go through the new wallet
        const w = await rangeAt(env, 0n).sendWithdraw(alice.getSender(), {
            value: env.fees.withdraw,
            amount: toNano('10'),
        })
        expect(w.transactions).toHaveTransaction({
            from: env.jackpot.address,
            to: newWallet.address,
            op: JackpotOp.sendTokens,
        })
        expect(w.transactions).not.toHaveTransaction({ from: env.jackpot.address, to: oldWallet })

        // and back: the old wallet is heard again
        expectChainSucceeded(await set(env.governor, oldWallet))
        const more = await mintHgram(env, bob, toNano('50'))
        const again = await depositHgram(env, bob, more)
        expect(again.booking!.owner.equals(bob.address)).toBe(true)
    })

    it('a GRAM deposit of exactly the minimum, made after the rate has risen, is booked', async () => {
        // the stored quote is refreshed by any booking; then the rate rises a little, as in a round
        // an hGRAM booking stores the quote of its reply, after a rise of the rate since the deploy
        await env.hipo.raiseRate('7')
        await depositHgram(env, bob, await mintHgram(env, bob, toNano('50')))
        const [tc] = await env.hipo.quote()
        await env.hipo.raiseRate(tc / 2000n) // +0.05%
        const { booking, result } = await depositGram(env, alice, toNano('10'))
        expectChainSucceeded(result)
        // the mint rounds down and the rate rose: c is a little under 10 GRAM, within the 1% margin
        expect(booking).toBeDefined()
        expect(booking!.principal).toBeLessThan(toNano('10'))
        expect(booking!.principal).toBeGreaterThanOrEqual(toNano('9.9'))
        expect(await hgramOf(env, alice.address)).toBe(0n)
    })
})

describe('Economic attacks', () => {
    beforeEach(async () => {
        await setup()
    })

    // A whale deposits before the period opens and withdraws right after, outside any draw's window: the
    // tree's sums drop at once, so draw 1's positions are the honest players' tickets only. Nothing rolls
    // over, and the yield their capital earned goes to them.
    it('a whale cannot win yield earned while its capital was out, by leaving a gap that rolls the draw over', async () => {
        const whale = await env.blockchain.treasury('whale', { balance: toNano('3000000') })
        await depositGram(env, alice, toNano('100'))
        await depositGram(env, bob, toNano('100'))
        // the first period opens on yield earned by alice and bob; the whale books just before, at the new
        // rate, so that it is eligible for draw 1 and has earned nothing
        await nextRound(env, toNano('5'))
        // in hGRAM: a GRAM deposit right after a 2.5% rise in one round would wait for resolve_pending
        const { booking: big } = await depositHgram(env, whale, await mintHgram(env, whale, toNano('2000000')))
        await startDraw(env)
        expect((await jackpotState(env)).kNext).toBeGreaterThan(big!.b)
        await rangeAt(env, big!.b).sendWithdraw(whale.getSender(), { value: env.fees.withdraw, amount: 0n })

        // the next period's yield, earned by alice's and bob's capital only (the gift is sized to Hipo's
        // total, which the whale's 2M hGRAM, now in its own wallet, dominates)
        await nextRound(env, toNano('20000'))
        const back = await hgramOf(env, whale.address)
        await depositHgram(env, whale, back) // booked before draw 1 starts: eligible for draw 2
        await startDraw(env, roundTime(drawRounds[0]) - 60)
        const draw1 = await env.jackpot.getDrawState()
        expect(draw1.state).toBe(DrawState.waiting)
        const honestPrizes1 = draw1.prizes[0] + draw1.prizes[1] + draw1.prizes[2]
        await submitRound(env, Number(draw1.round))
        const logs1 = (await resolveDraw(env)).flatMap((r) => logsOf<SlotLog>(r.externals, LogTopic.slot))
        expect(logs1.filter((l) => l.result === SlotResult.rolledOver).length).toBe(0)
        expect(logs1.filter((l) => l.result === SlotResult.miss).length).toBe(0)

        await nextRound(env, toNano('1000'))
        await startDraw(env, roundTime(drawRounds[1]) - 60)
        const draw2 = await env.jackpot.getDrawState()
        expect(draw2.state).toBe(DrawState.waiting)
        await submitRound(env, Number(draw2.round))
        const logs2 = (await resolveDraw(env)).flatMap((r) => logsOf<SlotLog>(r.externals, LogTopic.slot))
        const won = (who: Player, logs: SlotLog[]) =>
            logs
                .filter((l) => l.result === SlotResult.hit && l.owner!.equals(who.address))
                .reduce((a, l) => a + l.amount, 0n)
        const honest1 = won(alice, logs1) + won(bob, logs1)
        console.log(
            `draw 1: honest players won ${honest1.toString()} of ${honestPrizes1.toString()}; ` +
                `draw 2: the whale won ${won(whale, logs2).toString()}`,
        )
        expect(honest1).toBeGreaterThanOrEqual((honestPrizes1 * 9n) / 10n)
    })

    // The first version left a withdrawn ticket below every later cutoff. Now a withdrawal outside a draw's
    // window leaves the sums exact at once, and every later draw lands on live tickets only.
    it('a whale who books and leaves 10,000 times the honest total leaves no gap: every later draw hits 3 times and misses 0', async () => {
        const whale = await env.blockchain.treasury('whale', { balance: toNano('3000000') })
        await depositGram(env, alice, toNano('100'))
        await depositGram(env, bob, toNano('100'))
        const { booking: big } = await depositGram(env, whale, toNano('2000000'))
        await rangeAt(env, big!.b).sendWithdraw(whale.getSender(), { value: env.fees.withdraw, amount: 0n })
        // the gifts are sized to Hipo's total, which the whale's 2M hGRAM, now in its own wallet, dominates
        await nextRound(env, toNano('20000'))
        await startDraw(env)
        for (const round of drawRounds) {
            await nextRound(env, toNano('20000'))
            await startDraw(env, roundTime(round) - 60)
            expect((await env.jackpot.getDrawState()).state).toBe(DrawState.waiting)
            await submitRound(env, round)
            const logs = (await resolveDraw(env)).flatMap((r) => logsOf<SlotLog>(r.externals, LogTopic.slot))
            expect(logs.filter((l) => l.result === SlotResult.hit).length).toBe(3)
            expect(logs.filter((l) => l.result !== SlotResult.hit).length).toBe(0)
        }
    })
})

describe('A range setup that fails', () => {
    beforeEach(async () => {
        await setup()
    })

    // Cannot happen with the setup's fixed value at a fresh address. The test makes the range refuse it (an
    // account already set up at that address), to show the booking is undone rather than left half made.
    it('is undone: the tickets leave the tree and P, and the tokens wait outside T for return_tokens', async () => {
        await depositGram(env, bob, toNano('100'))
        const before = await counters(env)
        const run = await deliver(
            env.blockchain,
            msg(alice.address, env.jackpot.address, toNano('100') + env.fees.deposit, opBody(JackpotOp.deposit)),
            { hold: (m) => isFrom(m, env.jackpot.address, JackpotOp.rangeSetup) },
        )
        expect(run.held.length).toBe(1)
        const booked = logsOf<BookingLog>(run.externals, LogTopic.booking)[0]
        expect(booked.b).toBe(1n)
        // a range already set up sits at that address, so the setup throws and bounces
        const range = rangeAt(env, 1n)
        const data = beginCell()
            .storeAddress(env.jackpot.address)
            .storeUint(1, 32)
            .storeUint(0, 256)
            .storeRef(beginCell().storeAddress(mallory.address).storeCoins(1).storeCoins(1).endCell())
            .endCell()
        await env.blockchain.setShardAccount(
            range.address,
            createShardAccount({ address: range.address, code: env.rangeCode, data, balance: toNano('0.1') }),
        )
        const again = await deliver(env.blockchain, run.held[0])
        expect(again.transactions).toHaveTransaction({
            to: range.address,
            success: false,
            exitCode: JackpotError.alreadySetUp,
        })
        const undone = logsOf<SetupFailedLog>(again.externals, LogTopic.setupFailed)
        expect(undone.length).toBe(1)
        expect(undone[0].b).toBe(1n)
        expect(undone[0].principal).toBe(booked.principal)
        const after = await counters(env)
        expect(after.P).toBe(before.P)
        expect(after.lLo + after.lHi).toBe(before.lLo + before.lHi)
        expect(after.N).toBe(2n) // the index stays used
        expect((await nodeAt(env, 1, 0n).getNodeData()).committed[1]).toBe(0n)
        const jw = await jackpotWallet(env)
        expect(await walletTokens(env.blockchain, jw)).toBe(after.T + undone[0].tokens)
        await expectSolvent(env)
        // the governor returns the tokens to the owner named in the booking log
        expectChainSucceeded(
            await env.jackpot.sendReturnTokens(env.governor.getSender(), {
                value: env.fees.claim,
                owner: booked.owner,
                amount: undone[0].tokens,
            }),
        )
        expect(await hgramOf(env, alice.address)).toBe(undone[0].tokens)
    })
})

describe('A locate that reaches a range that is not set up', () => {
    it('answers miss instead of throwing, and the slot moves on', async () => {
        await setup()
        await depositGram(env, alice, toNano('1000'))
        const { booking } = await depositGram(env, bob, toNano('1000'))
        expect(booking!.b).toBe(1n)
        // the setup of range 1 bounced inside the window: the range exists with its init data only
        const range = rangeAt(env, 1n)
        const data = beginCell()
            .storeAddress(env.jackpot.address)
            .storeUint(1, 32)
            .storeUint(BigInt('0x' + nodeAt(env, 1, 0n).address.hash.toString('hex')), 256)
            .endCell()
        await env.blockchain.setShardAccount(
            range.address,
            createShardAccount({ address: range.address, code: env.rangeCode, data, balance: toNano('0.1') }),
        )
        await nextRound(env, toNano('30'))
        await startDraw(env)
        await nextRound(env, toNano('30'))
        await startDraw(env, roundTime(drawRounds[0]) - 60)
        await submitRound(env, drawRounds[0])

        // a stranger's check to the unset range throws, and no attempt advances
        const draw = await env.jackpot.getDrawState()
        const forged = await deliver(
            env.blockchain,
            msg(
                mallory.address,
                range.address,
                toNano('0.1'),
                checkBody({ draw: draw.drawId, slot: 0, j: 0, k: await env.jackpot.getPosition(0), offset: 0n }),
            ),
        )
        expect(forged.transactions).toHaveTransaction({
            to: range.address,
            success: false,
            exitCode: JackpotError.accessDenied,
        })
        expect(forged.transactions).not.toHaveTransaction({ to: env.jackpot.address, op: JackpotOp.miss })
        expect((await env.jackpot.getDrawState()).attempts).toEqual(draw.attempts)

        const results = await resolveDraw(env)
        const logs = results.flatMap((r) => logsOf<SlotLog>(r.externals, LogTopic.slot))
        const missesAtRange1 = logs.filter((l) => l.result === SlotResult.miss && l.b === 1n)
        expect(missesAtRange1.length).toBeGreaterThan(0)
        expect(logs.filter((l) => l.result === SlotResult.hit).length).toBeGreaterThan(0)
        for (const r of results) {
            expect(
                failed(r.transactions).filter((tx) => tx.address === BigInt('0x' + range.address.hash.toString('hex'))),
            ).toEqual([])
        }
        expect((await env.jackpot.getDrawState()).openSlots).toBe(0)
    })
})

describe('A claim of a prize and another amount', () => {
    it('sends each as its own payout, and a bounce returns each to its own kind', async () => {
        await setup()
        await drawReady(env, [[alice, toNano('1000')]])
        const jw = await jackpotWallet(env)
        const held = await walletTokens(env.blockchain, jw)
        // the Jackpot's wallet cannot pay: every payout bounces into claimable
        await setWalletTokens(env.blockchain, jw, 0n)
        await resolveDraw(env)
        await rangeAt(env, 0n).sendWithdraw(alice.getSender(), { value: env.fees.withdraw, amount: toNano('40') })
        const before = await env.jackpot.getClaimableParts(alice.address)
        expect(before.prize).toBeGreaterThan(0n)
        expect(before.other).toBeGreaterThan(0n)

        // the claim bounces too: each amount returns to its own kind
        const bounced = await env.jackpot.sendClaim(alice.getSender(), { value: env.fees.claim })
        expect(bounced.transactions).toHaveTransaction({ from: env.jackpot.address, to: jw, success: false })
        expect(await env.jackpot.getClaimableParts(alice.address)).toEqual(before)
        expect((await env.jackpot.getBooks()).payouts.size).toBe(0)

        // with the wallet back it pays both, as two payouts
        await setWalletTokens(env.blockchain, jw, held)
        const paid = await env.jackpot.sendClaim(alice.getSender(), { value: env.fees.claim })
        expectChainSucceeded(paid)
        expect(paid.transactions.filter((tx) => tx.inMessage?.info.dest?.toString() === jw.toString()).length).toBe(2)
        expect(await env.jackpot.getClaimable(alice.address)).toBe(0n)
        await expectSolvent(env)
    })
})

describe('The node float', () => {
    it('stays enough for the next node openings after a sweep', async () => {
        await setup()
        const carol = await env.blockchain.treasury('carol', { balance: toNano('1000000') })
        const sweep = async () => {
            const { nodeFloat } = await env.jackpot.getJackpotState()
            await env.jackpot.sendWithdrawSurplus(env.governor.getSender(), { value: toNano('0.1') })
            return nodeFloat
        }
        for (let i = 0; i < 64; i++) await depositGram(env, carol, toNano('10'))
        expect((await env.jackpot.getJackpotState()).nextBooking).toBe(64n)
        const float = await sweep()
        const storage = toNano('10') // fee::jackpot_storage
        expect(float).toBeGreaterThan(0n)
        expect(await env.jackpot.getBalance()).toBeGreaterThanOrEqual(storage + float)
        // the 65th booking opens a second level-1 node, paid from the float
        const { result } = await depositGram(env, carol, toNano('10'))
        expectChainSucceeded(result)
        expect(await nodeAt(env, 1, 1n).getBalance()).toBeGreaterThanOrEqual(toNano('0.29'))
        expect(await env.jackpot.getBalance()).toBeGreaterThanOrEqual(storage)
    })
})
