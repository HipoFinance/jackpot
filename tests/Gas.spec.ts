/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests read state they just made */
// Gas and fees. Every entry message is sent with exactly its minimum fee and must run its whole chain to
// the end, and no chain may spend the Jackpot's own GRAM. The gas each handler burns is measured and
// pinned, as Hipo's MaxGas.spec.ts does.
import { BlockchainTransaction, SandboxContract, SendMessageResult, TreasuryContract } from '@ton/sandbox'
import '@ton/test-utils'
import { Address, toNano } from '@ton/core'
import { DrawState, JackpotOp, LogTopic, QuoteKind, SlotLog, SlotResult, logsOf } from '../wrappers/Jackpot'
import { roundTime } from '../wrappers/drand'
import { getConfig } from './hipo/chain'
import {
    Env,
    bookingOf,
    depositGram,
    depositHgram,
    drawRounds,
    expectChainSucceeded,
    expectSolvent,
    mintHgram,
    nextRound,
    opOf,
    pendingQuote,
    rangeAt,
    replyQuote,
    setupJackpot,
    startDraw,
    submitRound,
} from './jackpot/setup'

const opNames = new Map<number, string>(Object.entries(JackpotOp).map(([k, v]) => [v, k]))

// Highest gas seen per "contract:op", over every test in this file.
const measured = new Map<string, bigint>()

// Pinned maxima. A handler that outgrows its pin fails here, and the fee that pays for it must be
// re-checked before the pin is raised.
const maxGas: Record<string, bigint> = {
    'jackpot:deposit': 17000n,
    'jackpot:transferNotification': 17000n,
    'jackpot:takeCurrentQuote': 22000n,
    'jackpot:gasExcess': 15000n,
    'jackpot:withdrawn': 19000n,
    'jackpot:startDraw': 19000n,
    'jackpot:submitRandomness': 90000n,
    'jackpot:locate': 20000n,
    'jackpot:hit': 25000n,
    'jackpot:miss': 20000n,
    'jackpot:requote': 18000n,
    'jackpot:expire': 25000n,
    'jackpot:claim': 20000n,
    'jackpot:bounce:sendTokens': 20000n,
    'range:rangeSetup': 3500n,
    'range:withdraw': 7600n,
    'range:check': 6600n,
}

function record(env: Env, result: SendMessageResult) {
    const ranges = new Set(env.bookings.map((b) => rangeAt(env, b.start).address.toString()))
    for (const tx of result.transactions) {
        if (tx.description.type !== 'generic' || tx.description.computePhase.type !== 'vm') continue
        const addr = new Address(0, Buffer.from(tx.address.toString(16).padStart(64, '0'), 'hex'))
        const name = addr.equals(env.jackpot.address) ? 'jackpot' : ranges.has(addr.toString()) ? 'range' : undefined
        if (name == null) continue
        const op = opOf(tx)
        const bounced = tx.inMessage?.info.type === 'internal' && tx.inMessage.info.bounced
        let key: string
        if (bounced) {
            const s = tx.inMessage!.body.beginParse()
            s.skip(32)
            key = `${name}:bounce:${opNames.get(s.loadUint(32)) ?? 'other'}`
        } else {
            key = `${name}:${op == null ? 'empty' : (opNames.get(op) ?? op.toString(16))}`
        }
        const gas = tx.description.computePhase.gasUsed
        if (gas > (measured.get(key) ?? 0n)) measured.set(key, gas)
    }
}

function storageCollected(tx: BlockchainTransaction): bigint {
    return tx.description.type === 'generic' ? (tx.description.storagePhase?.storageFeesCollected ?? 0n) : 0n
}

// Runs one entry message and returns what the chain left in the Jackpot's balance (storage fees added
// back, since they are owed whatever happens).
async function run(env: Env, send: () => Promise<SendMessageResult>) {
    const before = await env.jackpot.getBalance()
    const result = await send()
    record(env, result)
    const after = await env.jackpot.getBalance()
    const storage = result.transactions
        .filter((tx) => tx.address === BigInt('0x' + env.jackpot.address.hash.toString('hex')))
        .reduce((a, tx) => a + storageCollected(tx), 0n)
    return { result, kept: after - before + storage }
}

describe('Gas and fees', () => {
    afterAll(() => {
        const rows = [...measured.entries()].sort()
        console.log(rows.map(([k, v]) => `${k.padEnd(36)} ${v.toString()}`).join('\n'))
        for (const [k, v] of rows) {
            if (k in maxGas) expect(v).toBeLessThanOrEqual(maxGas[k])
        }
    })

    it('runs every chain to the end on its bare minimum fee, without the Jackpot paying', async () => {
        const env = await setupJackpot()
        const alice = await env.blockchain.treasury('alice')
        const bob = await env.blockchain.treasury('bob')
        const kept: Record<string, bigint> = {}

        // deposit: the minimum fee and the minimum deposit
        let r = await run(env, () =>
            env.jackpot.sendDeposit(alice.getSender(), { value: env.fees.deposit + toNano('10') }),
        )
        expectChainSucceeded(r.result)
        expect(logsOf(r.result.externals, LogTopic.booking).length).toBe(1)
        env.bookings.push(...logsOf<never>(r.result.externals, LogTopic.booking))
        kept.deposit = r.kept

        // a big depositor, who will leave and so leave gaps
        await depositGram(env, alice, toNano('9000'))

        // hGRAM deposit with exactly the forward the fee asks for
        const tokens = await mintHgram(env, bob, toNano('1000'))
        r = await run(env, async () => (await depositHgram(env, bob, tokens, env.fees.hgramDeposit)).result)
        expectChainSucceeded(r.result)
        kept.hgramDeposit = r.kept
        expect(env.bookings.length).toBe(3)

        // withdraw at the range, partial
        r = await run(env, () =>
            rangeAt(env, 0n).sendWithdraw(alice.getSender(), { value: env.fees.withdraw, amount: toNano('5') }),
        )
        expectChainSucceeded(r.result)
        expect(logsOf(r.result.externals, LogTopic.withdrawal).length).toBe(1)
        kept.withdraw = r.kept

        // start_draw, the empty first period
        await nextRound(env, toNano('100'))
        r = await run(env, () => startDraw(env))
        expectChainSucceeded(r.result)
        kept.startDrawEmpty = r.kept

        // a draw with the burn sent at its end, so the prepaid burn is spent in this lifecycle
        await env.jackpot.sendSetBurnBatch(env.governor.getSender(), { value: toNano('0.05'), burnBatch: 0n })
        await nextRound(env, toNano('100'))
        let lifecycle = 0n
        r = await run(env, () => startDraw(env, roundTime(drawRounds[0]) - 60))
        expectChainSucceeded(r.result)
        expect((await env.jackpot.getDrawState()).state).toBe(DrawState.waiting)
        lifecycle += r.kept
        kept.startDraw = r.kept

        r = await run(env, () => submitRound(env, drawRounds[0]))
        expectChainSucceeded(r.result)
        lifecycle += r.kept
        kept.submitRandomness = r.kept

        // the big depositor leaves: most tickets below the cutoff are now gaps, and attempts miss
        await rangeAt(env, env.bookings[1].start).sendWithdraw(alice.getSender(), {
            value: env.fees.withdraw,
            amount: 0n,
        })

        // locate slots 0 and 1 until each settles, every call on the bare fee
        const slotLogs: SlotLog[] = []
        for (const slot of [0, 1]) {
            for (;;) {
                const draw = await env.jackpot.getDrawState()
                if (((draw.openSlots >> slot) & 1) === 0) break
                const t = await env.jackpot.getTicket(slot)
                r = await run(env, () =>
                    env.jackpot.sendLocate(env.keeper.getSender(), {
                        value: env.fees.locate,
                        slot,
                        start: bookingOf(env, t).start,
                    }),
                )
                expectChainSucceeded(r.result)
                lifecycle += r.kept
                kept.locate = 'locate' in kept && kept.locate < r.kept ? kept.locate : r.kept
                slotLogs.push(...logsOf<SlotLog>(r.result.externals, LogTopic.slot))
            }
        }
        expect(slotLogs.some((l) => l.result === SlotResult.miss)).toBe(true)

        // expire the third slot after one validation round; it ends the draw and sends the burn
        const config15 = getConfig(env.blockchain, 15n)!.beginParse()
        const electedFor = config15.loadUint(32)
        env.blockchain.now! += electedFor
        r = await run(env, () => env.jackpot.sendExpire(env.keeper.getSender(), { value: env.fees.expire, slot: 2 }))
        expectChainSucceeded(r.result)
        expect(r.result.transactions).toHaveTransaction({
            from: await env.hipo.walletAddress(env.burner.address),
            to: env.burner.address,
            op: JackpotOp.transferNotification,
        })
        lifecycle += r.kept
        kept.expireWithBurn = r.kept
        kept.drawLifecycle = lifecycle
        expect((await env.jackpot.getDrawState()).state).toBe(DrawState.idle)
        await expectSolvent(env)

        console.log(
            Object.entries(kept)
                .map(([k, v]) => `kept by the Jackpot after ${k.padEnd(18)} ${v.toString()}`)
                .join('\n'),
        )
        for (const [k, v] of Object.entries(kept)) {
            // a burn is paid by expire's chain but was prepaid by start_draw; the lifecycle sums them
            if (k === 'expireWithBurn') continue
            expect([k, v >= 0n]).toEqual([k, true])
        }

        // a range keeps its storage reserve through all of this
        for (const b of env.bookings) {
            expect(await rangeAt(env, b.start).getBalance()).toBeGreaterThanOrEqual(toNano('0.1'))
        }
    })

    it('runs requote and claim on their bare minimum fee', async () => {
        const env = await setupJackpot({ fakeTreasury: true })
        const alice = await env.blockchain.treasury('alice')
        const bob = await env.blockchain.treasury('bob')
        const kept: Record<string, bigint> = {}

        for (const p of [alice, bob]) {
            await depositHgram(env, p, await mintHgram(env, p, toNano('1000')))
            const reply = await replyQuote(env, await pendingQuote(env, QuoteKind.booking), 1100n, 1000n)
            record(env, reply)
            env.bookings.push(...logsOf<never>(reply.externals, LogTopic.booking))
        }

        // requote a draw start whose reply was lost
        await env.hipo.nextValidationRound()
        await startDraw(env)
        env.blockchain.now! += 600
        let r = await run(env, () =>
            env.jackpot.sendRequote(env.keeper.getSender(), {
                value: env.fees.requote,
                target: 12345n,
            }),
        )
        // the target above is wrong on purpose: refused, nothing changes
        expect(r.result.transactions).toHaveTransaction({ to: env.jackpot.address, success: false })
        const lost = await pendingQuote(env, QuoteKind.draw)
        r = await run(env, () =>
            env.jackpot.sendRequote(env.keeper.getSender(), { value: env.fees.requote, target: lost }),
        )
        expectChainSucceeded(r.result)
        kept.requote = r.kept
        await replyQuote(env, await pendingQuote(env, QuoteKind.draw), 1200n, 1000n)

        // a held prize, then a claim on the bare fee
        await env.hipo.nextValidationRound()
        await startDraw(env, roundTime(drawRounds[0]) - 60)
        await replyQuote(env, await pendingQuote(env, QuoteKind.draw), 1300n, 1000n)
        await submitRound(env, drawRounds[0])
        await rangeAt(env, 0n).sendWithdraw(alice.getSender(), { value: env.fees.withdraw, amount: toNano('1') })
        await replyQuote(env, await pendingQuote(env, QuoteKind.withdrawal), 1250n, 1000n)
        expect((await env.jackpot.getJackpotState()).falling).toBe(true)
        for (const slot of [0, 1, 2]) {
            const t = await env.jackpot.getTicket(slot)
            const res = await env.jackpot.sendLocate(env.keeper.getSender(), {
                value: env.fees.locate,
                slot,
                start: bookingOf(env, t).start,
            })
            record(env, res)
        }
        await env.jackpot.sendClearFalling(env.governor.getSender(), { value: toNano('0.05') })
        const winner: SandboxContract<TreasuryContract> =
            (await env.jackpot.getClaimable(alice.address)) > 0n ? alice : bob
        r = await run(env, () => env.jackpot.sendClaim(winner.getSender(), { value: env.fees.claim }))
        expectChainSucceeded(r.result)
        kept.claim = r.kept

        console.log(
            Object.entries(kept)
                .map(([k, v]) => `kept by the Jackpot after ${k.padEnd(18)} ${v.toString()}`)
                .join('\n'),
        )
        for (const [k, v] of Object.entries(kept)) expect([k, v >= 0n]).toEqual([k, true])
    })

    it('refuses every entry message below its minimum, with no state change', async () => {
        const env = await setupJackpot()
        const alice = await env.blockchain.treasury('alice')
        const state = async () => {
            const account = (await env.blockchain.getContract(env.jackpot.address)).accountState
            if (account?.type !== 'active') throw new Error('not active')
            return account.state.data!.hash().toString('hex')
        }
        const before = await state()
        const short = (fee: bigint) => fee - 1n
        const sends = [
            () => env.jackpot.sendDeposit(alice.getSender(), { value: short(env.fees.deposit) }),
            () => env.jackpot.sendStartDraw(alice.getSender(), { value: short(env.fees.startDraw) }),
            () => env.jackpot.sendLocate(alice.getSender(), { value: short(env.fees.locate), slot: 0, start: 0n }),
            () => env.jackpot.sendRequote(alice.getSender(), { value: short(env.fees.requote), target: 1n }),
            () => env.jackpot.sendExpire(alice.getSender(), { value: short(env.fees.expire), slot: 0 }),
            () => env.jackpot.sendClaim(alice.getSender(), { value: short(env.fees.claim) }),
        ]
        for (const send of sends) {
            const result = await send()
            expect(result.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: 101 })
        }
        expect(await state()).toBe(before)
    })
})
