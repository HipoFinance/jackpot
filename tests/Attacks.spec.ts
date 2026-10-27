/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests read state they just made */
// The attacks the spec's rules exist to stop ("Rules every message follows" and its audit history), each
// run the way an attacker would run it, against the real Hipo contracts. A test marked `it.failing` shows
// a bug that is still open: it asserts the safe outcome, and fails today. See the report that came with
// this file for the loss scenario of each.
import { Message } from '@ton/core'
import '@ton/test-utils'
import { toNano } from '@ton/core'
import {
    BookingLog,
    DrawState,
    JackpotError,
    JackpotOp,
    LogTopic,
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
    walletTokens,
    withdrawnBody,
} from './jackpot/adversary'

// An open bug: the test asserts the safe outcome and fails today. SHOW_BUGS=1 runs these as plain tests,
// so that their failures print.
const openBug = process.env.SHOW_BUGS != null ? it : it.failing

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
        const r = await env.jackpot.getTicket(0)
        const winner = rangeOf(env, r)!
        const owner = winner.owner.equals(alice.address) ? alice : bob
        const before = {
            jackpot: await jackpotHash(),
            range: await dataHash(env.blockchain, rangeAt(env, winner.start).address),
        }
        const balance = await hgramOf(env, owner.address)

        const result = await owner.send({
            to: rangeAt(env, winner.start).address,
            value: toNano('1'),
            body: checkBody({ draw: 1n, slot: 0, j: 0, r, start: winner.start }),
        })
        expect(result.transactions).toHaveTransaction({
            to: rangeAt(env, winner.start).address,
            success: false,
            exitCode: JackpotError.accessDenied,
        })
        expect(result.transactions).not.toHaveTransaction({ to: env.jackpot.address, op: JackpotOp.hit })
        expect(await jackpotHash()).toBe(before.jackpot)
        expect(await dataHash(env.blockchain, rangeAt(env, winner.start).address)).toBe(before.range)
        expect(await hgramOf(env, owner.address)).toBe(balance)
    })

    it('a forged hit or miss sent straight to the Jackpot pays nothing and advances no attempt', async () => {
        const before = await jackpotHash()
        const draw = await env.jackpot.getDrawState()
        for (const slot of [0, 1, 2]) {
            const r = await env.jackpot.getTicket(slot)
            const range = rangeOf(env, r)!
            // the exact reply the range would send, but from the player
            const hit = await mallory.send({
                to: env.jackpot.address,
                value: toNano('1'),
                body: hitBody({ draw: 1n, slot, j: 0, r, start: range.start, owner: mallory.address }),
            })
            expectChainSucceeded(hit) // never throws, ignores
            expect(hit.transactions).not.toHaveTransaction({ from: env.jackpot.address, op: JackpotOp.sendTokens })
            const miss = await mallory.send({
                to: env.jackpot.address,
                value: toNano('1'),
                body: missBody({ draw: 1n, slot, j: 0, r, start: range.start }),
            })
            expectChainSucceeded(miss)
        }
        expect(await jackpotHash()).toBe(before)
        expect(await env.jackpot.getDrawState()).toEqual(draw)
        expect(await hgramOf(env, mallory.address)).toBe(0n)
    })

    it('a duplicate hit for a slot already closed pays nothing', async () => {
        const r = await env.jackpot.getTicket(0)
        const range = rangeOf(env, r)!
        const winner = range.owner
        const [p0] = (await env.jackpot.getDrawState()).prizes
        const before = await hgramOf(env, winner)
        const locate = () =>
            msg(
                env.keeper.address,
                env.jackpot.address,
                env.fees.locate,
                opBody(JackpotOp.locate, [0, 8], [range.start, 128]),
            )
        // two locates for the same attempt: both checks are in flight before either answer comes back
        const holdChecks = (m: Message) => opBodyOf(m) === JackpotOp.check
        const first = await deliver(env.blockchain, locate(), { hold: holdChecks })
        const second = await deliver(env.blockchain, locate(), { hold: holdChecks })
        expect(first.held.length + second.held.length).toBe(2)
        const replies = await deliver(env.blockchain, [...first.held, ...second.held])
        const hits = replies.transactions.filter(
            (tx) => tx.inMessage != null && isTo(tx.inMessage, env.jackpot.address, JackpotOp.hit),
        )
        expect(hits.length).toBe(2) // both ranges answered
        const slotLogs = logsOf<SlotLog>(replies.externals, LogTopic.slot)
        expect(slotLogs.map((l) => l.result)).toEqual([SlotResult.hit])
        expect(await hgramOf(env, winner)).toBe(before + p0)
        expect(failed(replies.transactions)).toEqual([])
        expect((await env.jackpot.getDrawState()).openSlots & 1).toBe(0)
    })

    it('a late joiner who names their own range in locate is refused, and wins nothing', async () => {
        const late = await env.blockchain.treasury('late')
        const { booking } = await depositGram(env, late, toNano('100000'))
        const draw = await env.jackpot.getDrawState()
        expect(booking!.start).toBeGreaterThanOrEqual(draw.cutoff)
        const before = await jackpotHash()
        for (const slot of [0, 1, 2]) {
            const result = await env.jackpot.sendLocate(late.getSender(), {
                value: env.fees.locate,
                slot,
                start: booking!.start,
            })
            expect(result.transactions).toHaveTransaction({
                to: env.jackpot.address,
                success: false,
                exitCode: JackpotError.ticketOutOfRange,
            })
        }
        expect(await jackpotHash()).toBe(before)
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
        // the same message as the Jackpot would send it
        const second = await deliver(
            env.blockchain,
            msg(env.jackpot.address, range.address, toNano('0.2'), rangeSetupBody(mallory.address, toNano('1000000'))),
        )
        expect(second.transactions).toHaveTransaction({
            to: range.address,
            success: false,
            exitCode: JackpotError.alreadySetUp,
        })
        expect(await dataHash(env.blockchain, range.address)).toBe(before)

        // a squatter at the next booking's address cannot set it up either
        const next = rangeAt(env, (await jackpotState(env)).nextTicket)
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
        expect((await rangeAt(env, booking!.start).getRangeData()).owner!.equals(bob.address)).toBe(true)
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
        expect(ok.booking!.start).toBe(0n)
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

    // The implementer's own concern. Anyone can mint hGRAM to the Jackpot with deposit_coins(owner =
    // Jackpot, query_id = X), and the notification looks exactly like the Jackpot's own mint. X is public
    // once the Jackpot sends its deposit_coins. With instant_mint on, an attacker's mint reaches the
    // Jackpot first only if the attacker's deposit_coins reaches the treasury before the Jackpot's own,
    // which the attacker can learn of only after it was sent: the test holds the Jackpot's message back
    // to stand for a delay between shards. The safe outcome is that the player is still booked in full.
    openBug(
        "a dust mint under a pending deposit's public query_id strands the player's real mint (instant mint on)",
        async () => {
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
            expect(logsOf<BookingLog>(attack.externals, LogTopic.booking)).toEqual([]) // below the minimum: returned
            expect(await hgramOf(env, alice.address)).toBe(toNano('1')) // alice got the dust
            // the real mint arrives and finds no record
            await deliver(env.blockchain, run.held)
            const c = await counters(env)
            const real = await walletTokens(env.blockchain, await jackpotWallet(env))
            console.log(`stranded outside T: ${(real - c.T).toString()} nano-hGRAM; alice booked: ${c.P.toString()}`)
            expect(c.P).toBeGreaterThanOrEqual(toNano('99')) // fails: P = 0, alice's 100 hGRAM sit outside T
        },
    )
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
    // pending query_id, and starts the burn under it: the victim's bill, burned first, is booked to the
    // attacker.
    openBug(
        "an attacker who starts Hipo's bill burn under their own pending query_id is booked the victim's deposit",
        async () => {
            await depositGram(env, alice, toNano('1000'))
            const run = await deliver(
                env.blockchain,
                msg(mallory.address, env.jackpot.address, toNano('10') + env.fees.deposit, opBody(JackpotOp.deposit)),
            )
            const out = run.transactions
                .flatMap((t) => [...t.outMessages.values()])
                .find((m) => isFrom(m, env.jackpot.address, JackpotOp.depositCoins))!
            const x = queryIdOfMessage(out)
            expect((await env.jackpot.getBooks()).pending.size).toBe(2)

            const now = BigInt(env.blockchain.now!)
            const burn = await env.hipo.treasury.sendParticipateInElection({ queryId: x, roundSince: now - 10n })
            const booked = logsOf<BookingLog>(burn.externals, LogTopic.booking)
            console.log(
                booked
                    .map(
                        (b) =>
                            `${b.owner.equals(mallory.address) ? 'mallory' : 'alice'} booked ${b.principal.toString()}`,
                    )
                    .join('; '),
            )
            const malloryPrincipal = booked
                .filter((b) => b.owner.equals(mallory.address))
                .reduce((a, b) => a + b.principal, 0n)
            // she leaves at once with it
            const mine = booked.find((b) => b.owner.equals(mallory.address))
            if (mine != null) {
                await rangeAt(env, mine.start).sendWithdraw(mallory.getSender(), {
                    value: env.fees.withdraw,
                    amount: 0n,
                })
                console.log(
                    `mallory withdrew ${(await hgramOf(env, mallory.address)).toString()} nano-hGRAM for a 10 GRAM deposit; ` +
                        `alice's deposit is still pending: ${(await env.jackpot.getBooks()).pending.size.toString()} record(s)`,
                )
            }
            expect(malloryPrincipal).toBeLessThanOrEqual(toNano('10')) // fails: mallory is booked alice's 1000 GRAM
        },
    )
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
        const r = await env.jackpot.getTicket(0)
        const range = rangeOf(env, r)!
        let res = await env.jackpot.sendLocate(mallory.getSender(), {
            value: short(env.fees.locate),
            slot: 0,
            start: range.start,
        })
        expect(res.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.insufficientFee,
        })
        expect(await jackpotHash()).toBe(before)
        res = await env.jackpot.sendLocate(mallory.getSender(), { value: env.fees.locate, slot: 0, start: range.start })
        expectChainSucceeded(res)
        expect(logsOf<SlotLog>(res.externals, LogTopic.slot).length).toBe(1)

        // withdraw, at the range
        const rangeOfAlice = rangeAt(env, 0n)
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
        res = await rangeOfAlice.sendWithdraw(alice.getSender(), { value: env.fees.withdraw, amount: toNano('10') })
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
            const t = await env.jackpot.getTicket(slot)
            await env.jackpot.sendLocate(env.keeper.getSender(), {
                value: env.fees.locate,
                slot,
                start: rangeOf(env, t)!.start,
            })
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
                rangeAt(env, booked[0].start).address,
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
    // RECIPIENT's own wallet send one with any query_id: 0 hGRAM to the recipient, return_excess =
    // Jackpot. That is the one source the Jackpot trusts, and it deletes the record. A payout whose second
    // hop failed (here: the wallet was unusable, then usable again) can then no longer be settled; its
    // tokens stay outside T and the owner is paid only if the governor notices and uses return_tokens.
    openBug(
        "a confirmation forged through the recipient's own wallet closes a failed payout before it can be settled",
        async () => {
            const { repair, id, amount } = await failedSecondHop()
            await repair()
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
            const settled = await env.jackpot.sendSettleFailedPayout(env.governor.getSender(), {
                value: toNano('0.1'),
                target: id,
            })
            expectChainSucceeded(settled) // fails: unknown_query, the record is gone
            expect(await env.jackpot.getClaimable(alice.address)).toBe(amount)
        },
    )
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
        const value = env.fees.claim // fee::handler + fee::payout
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

    it('a GRAM deposit of exactly the minimum, made after the rate has risen, is returned as hGRAM instead of booked', async () => {
        await env.hipo.raiseRate('7')
        const { booking, result } = await depositGram(env, alice, toNano('10'))
        expectChainSucceeded(result)
        // documents the behaviour: the mint rounds down, so c = 10 GRAM − 1 nano < the 10 GRAM minimum
        console.log(
            `exact-minimum deposit after a rate rise: ${booking == null ? 'returned as hGRAM ' + (await hgramOf(env, alice.address)).toString() : 'booked ' + booking.principal.toString()}`,
        )
        expect(booking).toBeUndefined()
        expect(await hgramOf(env, alice.address)).toBeGreaterThan(0n)
    })
})

describe('Economic attacks', () => {
    beforeEach(async () => {
        await setup()
    })

    // Withdrawn tickets stay below the cutoff as gaps, and a slot whose 64 attempts all land in gaps rolls
    // its prize over to the next draw. A whale can make most of a draw's tickets gaps for the price of two
    // fees: deposit before the period opens, withdraw right after. The prize that rolls over was earned by
    // the other players' capital alone; the whale re-deposits in time for the next draw and wins it there.
    openBug(
        'a whale cannot win yield earned while its capital was out, by leaving a gap that rolls the draw over',
        async () => {
            const whale = await env.blockchain.treasury('whale', { balance: toNano('3000000') })
            await depositGram(env, alice, toNano('100'))
            await depositGram(env, bob, toNano('100'))
            // the first period opens on yield earned by alice and bob; the whale books just before, at the new
            // rate, so that it is eligible for draw 1 and has earned nothing
            await nextRound(env, toNano('5'))
            const { booking: big } = await depositGram(env, whale, toNano('2000000'))
            await startDraw(env)
            expect((await jackpotState(env)).cutoff).toBeGreaterThan(big!.start)
            await rangeAt(env, big!.start).sendWithdraw(whale.getSender(), { value: env.fees.withdraw, amount: 0n })

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
            const rolled = logs1.filter((l) => l.result === SlotResult.rolledOver).length
            console.log(`draw 1: ${rolled.toString()} of 3 slots rolled over (prizes ${honestPrizes1.toString()})`)

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
            const honest = won(alice, [...logs1, ...logs2]) + won(bob, [...logs1, ...logs2])
            console.log(
                `honest players won ${honest.toString()} over both draws; the whale won ${won(whale, logs2).toString()}; ` +
                    `draw 1's prizes, earned by honest capital alone: ${honestPrizes1.toString()}`,
            )
            expect(honest).toBeGreaterThanOrEqual((honestPrizes1 * 9n) / 10n) // fails: the whale takes it
        },
    )
})
