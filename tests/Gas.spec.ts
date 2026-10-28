/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests read state they just made */
// Gas and fees. Every entry message is sent with exactly its minimum fee and must run its whole chain to
// the end, and no chain may spend the Jackpot's own GRAM. The gas each handler burns is measured and
// pinned, as Hipo's MaxGas.spec.ts does, the nodes' update and descend in their worst case included: a
// fold of 64 held children and the longest scan, at every level.
import { BlockchainTransaction, SendMessageResult } from '@ton/sandbox'
import '@ton/test-utils'
import { Address, toNano } from '@ton/core'
import {
    DrawState,
    JackpotFees,
    JackpotOp,
    LogTopic,
    SlotLog,
    SlotResult,
    logsOf,
    treeLevels,
} from '../wrappers/Jackpot'
import { roundTime } from '../wrappers/drand'
import {
    Env,
    depositGram,
    depositHgram,
    drawRounds,
    expectChainSucceeded,
    expectSolvent,
    mintHgram,
    nextRound,
    nodeAt,
    opOf,
    rangeAt,
    setupJackpot,
    startDraw,
    submitRound,
} from './jackpot/setup'
import {
    craftNode,
    deliver,
    descendBody,
    isTo,
    jackpotWallet,
    msg,
    opBody,
    queryIdOfMessage,
    setWalletTokens,
    updateBody,
    walletTokens,
} from './jackpot/adversary'

const opNames = new Map<number, string>(Object.entries(JackpotOp).map(([k, v]) => [v, k]))

// Highest gas seen per "contract:op", over every test in this file.
const measured = new Map<string, bigint>()

// Highest total gas of one locate chain (one attempt), over every locate this file runs.
let attemptGas = 0n
let fees: JackpotFees

// Pinned maxima. A handler that outgrows its pin fails here, and the fee that pays for it must be
// re-checked before the pin is raised. The fees are sized from these at 400 nano-GRAM per gas
// (contracts/imports/constants.fc).
const maxGas: Record<string, bigint> = {
    'jackpot:deposit': 20000n,
    'jackpot:transferNotification': 18000n,
    'jackpot:takeCurrentQuote': 32000n,
    'jackpot:gasExcess': 16000n,
    'jackpot:withdrawn': 32000n,
    'jackpot:startDraw': 22500n,
    'jackpot:submitRandomness': 90000n,
    'jackpot:locate': 19000n,
    'jackpot:hit': 28000n,
    'jackpot:hit:burn': 36000n,
    'jackpot:miss': 23000n,
    'jackpot:requote': 18000n,
    'jackpot:claim': 22500n,
    'jackpot:topUp': 1500n,
    'jackpot:bounce:sendTokens': 15000n,
    'range:rangeSetup': 4500n,
    'range:withdraw': 8500n,
    'range:check': 6500n,
    'range:bounce:withdrawn': 7000n,
    // the worst case: a fold of all 64 children; fee::node_hop pays 75,000 gas
    'node:update': 56000n,
    'node:descend': 56000n,
}

function addressOf(tx: BlockchainTransaction) {
    return new Address(0, Buffer.from(tx.address.toString(16).padStart(64, '0'), 'hex'))
}

function nodeAddresses(env: Env): Set<string> {
    const out = new Set<string>()
    for (const b of [...env.bookings.map((x) => x.b), 0n]) {
        for (let level = 1; level <= treeLevels; level++) {
            out.add(nodeAt(env, level, b >> BigInt(6 * level)).address.toString())
        }
    }
    return out
}

// The transaction sends a burn: a send_tokens to the Jackpot's wallet whose recipient is the burner.
function sendsBurn(tx: BlockchainTransaction, burner: Address): boolean {
    for (const [, out] of tx.outMessages) {
        if (out.info.type !== 'internal') continue
        const s = out.body.beginParse()
        if (s.remainingBits < 32 || s.loadUint(32) !== JackpotOp.sendTokens) continue
        s.skip(64)
        s.loadCoins()
        if (s.loadAddress().equals(burner)) return true
    }
    return false
}

function record(env: Env, result: { transactions: BlockchainTransaction[] }) {
    const ranges = new Set(env.bookings.map((x) => rangeAt(env, x.b).address.toString()))
    const nodes = nodeAddresses(env)
    let chain = 0n
    let located = false
    for (const tx of result.transactions) {
        if (tx.description.type !== 'generic' || tx.description.computePhase.type !== 'vm') continue
        const addr = addressOf(tx)
        const name = addr.equals(env.jackpot.address)
            ? 'jackpot'
            : ranges.has(addr.toString())
              ? 'range'
              : nodes.has(addr.toString())
                ? 'node'
                : undefined
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
        if (name === 'jackpot' && sendsBurn(tx, env.burner.address)) key += ':burn'
        const gas = tx.description.computePhase.gasUsed
        if (gas > (measured.get(key) ?? 0n)) measured.set(key, gas)
        chain += gas
        if (key === 'jackpot:locate') located = true
        fees = env.fees
    }
    if (located && chain > attemptGas) attemptGas = chain
}

function storageCollected(tx: BlockchainTransaction): bigint {
    return tx.description.type === 'generic' ? (tx.description.storagePhase?.storageFeesCollected ?? 0n) : 0n
}

function computeOk(tx: BlockchainTransaction): boolean {
    return (
        tx.description.type === 'generic' &&
        tx.description.computePhase.type === 'vm' &&
        tx.description.computePhase.success
    )
}

// Runs one entry message and returns what the chain left in the Jackpot's balance (storage fees added
// back, since they are owed whatever happens).
async function run(env: Env, send: () => Promise<SendMessageResult>) {
    const before = await env.jackpot.getBalance()
    const result = await send()
    record(env, result)
    const after = await env.jackpot.getBalance()
    const storage = result.transactions
        .filter((tx) => addressOf(tx).equals(env.jackpot.address))
        .reduce((a, tx) => a + storageCollected(tx), 0n)
    return { result, kept: after - before + storage }
}

describe('Gas and fees', () => {
    afterAll(() => {
        const rows = [...measured.entries()].sort()
        console.log(rows.map(([k, v]) => `${k.padEnd(36)} ${v.toString()}`).join('\n'))
        for (const [k, v] of rows) {
            if (k in maxGas) expect([k, v <= maxGas[k]]).toEqual([k, true])
        }
        // every pinned handler was measured
        for (const k of Object.keys(maxGas)) expect([k, measured.has(k)]).toEqual([k, true])
        // one attempt (locate handler, 4 node descents, range check, hit or miss handler) stays within
        // fee::attempt at 400 nano-GRAM per gas, which the surcharge is sized from
        const attemptFee = fees.attempt
        console.log(`one attempt: ${attemptGas.toString()} gas, fee::attempt ${attemptFee.toString()}`)
        expect(attemptGas).toBeGreaterThan(0n)
        expect(attemptGas * 400n).toBeLessThanOrEqual(attemptFee)
    })

    it('runs every chain to the end on its bare minimum fee, without the Jackpot paying', async () => {
        const env = await setupJackpot({ config: { burnBatch: 0n } })
        const alice = await env.blockchain.treasury('alice')
        const bob = await env.blockchain.treasury('bob')
        const carol = await env.blockchain.treasury('carol')
        const kept: Record<string, bigint> = {}

        // the first deposit: the minimum fee and the minimum deposit. It opens the first node of each
        // level, which the deploy float pays for.
        let r = await run(env, () =>
            env.jackpot.sendDeposit(alice.getSender(), { value: env.fees.deposit + toNano('10') }),
        )
        expectChainSucceeded(r.result)
        env.bookings.push(...logsOf<never>(r.result.externals, LogTopic.booking))
        expect(env.bookings.length).toBe(1)
        kept.firstDeposit = r.kept

        r = await run(env, () => env.jackpot.sendDeposit(bob.getSender(), { value: env.fees.deposit + toNano('10') }))
        expectChainSucceeded(r.result)
        env.bookings.push(...logsOf<never>(r.result.externals, LogTopic.booking))
        kept.deposit = r.kept

        // a big depositor, who will leave in the draw's window and so leave empty positions
        await depositGram(env, carol, toNano('9000'))

        // hGRAM deposit with exactly the forward the fee asks for
        const tokens = await mintHgram(env, bob, toNano('1000'))
        r = await run(env, async () => (await depositHgram(env, bob, tokens, env.fees.hgramDeposit)).result)
        expectChainSucceeded(r.result)
        kept.hgramDeposit = r.kept
        expect(env.bookings.length).toBe(4)

        // withdraw at the range, partial, outside any draw
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

        // the big depositor leaves in the window: short of the surcharge it bounces, and the range restores
        // its live part and returns the GRAM
        const big = env.bookings[2]
        const s = await env.jackpot.getSurcharge(big.b, big.principal)
        expect(s).toBeGreaterThan(0n)
        const refused = await rangeAt(env, big.b).sendWithdraw(carol.getSender(), {
            value: env.fees.withdraw + s - 1n,
            amount: 0n,
        })
        record(env, refused)
        expect((await rangeAt(env, big.b).getRangeData()).live).toBe(big.principal)
        // with it: held back in the nodes
        r = await run(env, () =>
            rangeAt(env, big.b).sendWithdraw(carol.getSender(), { value: env.fees.withdraw + s, amount: 0n }),
        )
        expectChainSucceeded(r.result)
        kept.withdrawDeferred = r.kept

        // locate until every slot settles, every call on the bare fee; the last one sends the burn
        const slotLogs: SlotLog[] = []
        for (let guard = 0; guard < 60; guard++) {
            const draw = await env.jackpot.getDrawState()
            if (draw.openSlots === 0) break
            const slot = [0, 1, 2].find((i) => (draw.openSlots >> i) & 1)!
            r = await run(env, () => env.jackpot.sendLocate(env.keeper.getSender(), { value: env.fees.locate, slot }))
            expectChainSucceeded(r.result)
            lifecycle += r.kept
            slotLogs.push(...logsOf<SlotLog>(r.result.externals, LogTopic.slot))
        }
        expect(slotLogs.some((l) => l.result === SlotResult.miss)).toBe(true)
        expect(slotLogs.some((l) => l.result === SlotResult.hit)).toBe(true)
        const burnerWallet = await env.hipo.walletAddress(env.burner.address)
        expect(await walletTokens(env.blockchain, burnerWallet)).toBeGreaterThan(0n)
        kept.drawLifecycle = lifecycle
        expect((await env.jackpot.getDrawState()).state).toBe(DrawState.idle)
        await expectSolvent(env)

        console.log(
            Object.entries(kept)
                .map(([k, v]) => `kept by the Jackpot after ${k.padEnd(18)} ${v.toString()}`)
                .join('\n'),
        )
        const state = await env.jackpot.getJackpotState()
        console.log(`node float after ${state.nextBooking.toString()} bookings: ${state.nodeFloat.toString()}`)
        for (const [k, v] of Object.entries(kept)) {
            // the first booking opens the first nodes, paid from the deploy float
            if (k === 'firstDeposit') continue
            expect([k, v >= 0n]).toEqual([k, true])
        }

        // ranges and nodes keep their storage reserves through all of this
        for (const b of env.bookings) {
            expect(await rangeAt(env, b.b).getBalance()).toBeGreaterThanOrEqual(toNano('0.1'))
        }
        for (let level = 1; level <= treeLevels; level++) {
            expect(await nodeAt(env, level, 0n).getBalance()).toBeGreaterThanOrEqual(toNano('0.29'))
        }
    })

    it('runs a node update and a descent in the worst case, a fold of all 64 children, at every level', async () => {
        const env = await setupJackpot()
        const all = (v: bigint) => Array.from({ length: 64 }, () => v)
        for (let level = 1; level <= treeLevels; level++) {
            await craftNode(env, level, 0n, {
                committed: all(toNano('1000000')),
                held: all(toNano('1')),
                pendingDraw: 1n,
            })
        }
        const parentOf = (level: number) =>
            level === treeLevels ? env.jackpot.address : nodeAt(env, level + 1, 0n).address
        // the hop each node is paid, from the update fee (4 hops)
        const hop = env.fees.withdraw // generous: the measurement is of gas used, not of the value

        for (let level = 1; level <= treeLevels; level++) {
            const node = nodeAt(env, level, 0n)
            const snapshot = env.blockchain.snapshot()
            // an update tagged with draw 2, deferred, for the last child: folds all 64, then holds again
            const last = (1n << BigInt(6 * level)) - 1n
            const update = await env.blockchain.sendMessage(
                msg(
                    parentOf(level),
                    node.address,
                    hop,
                    updateBody({ tag: 2n, deferred: true, b: last, delta: -toNano('1') }),
                    false,
                ),
            )
            const tx = update.transactions[0]
            expect(computeOk(tx)).toBe(true)
            record(env, { transactions: [tx] })
            const after = await node.getNodeData()
            expect(after.committed.every((v) => v === toNano('999999'))).toBe(true)
            expect(after.held.slice(0, 63).every((v) => v === 0n)).toBe(true)
            expect(after.held[63]).toBe(toNano('1'))
            expect(after.pendingDraw).toBe(2n)
            await env.blockchain.loadFrom(snapshot)

            // a descent tagged with draw 2 to the very last ticket: folds all 64, scans to the last child
            const k = 64n * toNano('999999') - 1n
            const descent = await env.blockchain.sendMessage(
                msg(parentOf(level), node.address, hop, descendBody({ draw: 2n, slot: 0, j: 0, k, offset: k }), false),
            )
            const dtx = descent.transactions[0]
            expect(computeOk(dtx)).toBe(true)
            record(env, { transactions: [dtx] })
            await env.blockchain.loadFrom(snapshot)
        }
    })

    it('runs requote and claim on their bare minimum fee', async () => {
        const env = await setupJackpot()
        const alice = await env.blockchain.treasury('alice')
        const kept: Record<string, bigint> = {}
        const { booking } = await depositGram(env, alice, toNano('100'))
        env.bookings.push(booking!)
        const range = rangeAt(env, booking!.b)

        // requote a withdrawal whose reply was lost
        const held = await deliver(
            env.blockchain,
            msg(
                alice.address,
                range.address,
                env.fees.withdraw,
                opBody(JackpotOp.withdraw).asBuilder().storeCoins(toNano('10')).endCell(),
            ),
            { hold: (m) => isTo(m, env.jackpot.address, JackpotOp.takeCurrentQuote) },
        )
        record(env, held)
        env.blockchain.now! += 600
        const wrong = await env.jackpot.sendRequote(env.keeper.getSender(), { value: env.fees.requote, target: 12345n })
        expect(wrong.transactions).toHaveTransaction({ to: env.jackpot.address, success: false })
        let r = await run(env, () =>
            env.jackpot.sendRequote(env.keeper.getSender(), {
                value: env.fees.requote,
                target: queryIdOfMessage(held.held[0]),
            }),
        )
        expectChainSucceeded(r.result)
        expect(logsOf(r.result.externals, LogTopic.withdrawal).length).toBe(1)
        kept.requote = r.kept

        // a payout that bounces at the first hop becomes claimable; the claim on the bare fee
        const jw = await jackpotWallet(env)
        const tokens = await walletTokens(env.blockchain, jw)
        await setWalletTokens(env.blockchain, jw, 0n)
        record(env, await range.sendWithdraw(alice.getSender(), { value: env.fees.withdraw, amount: toNano('10') }))
        await setWalletTokens(env.blockchain, jw, tokens)
        expect(await env.jackpot.getClaimable(alice.address)).toBeGreaterThan(0n)
        r = await run(env, () => env.jackpot.sendClaim(alice.getSender(), { value: env.fees.claim }))
        expectChainSucceeded(r.result)
        kept.claim = r.kept
        expect(await env.jackpot.getClaimable(alice.address)).toBe(0n)

        console.log(
            Object.entries(kept)
                .map(([k, v]) => `kept by the Jackpot after ${k.padEnd(18)} ${v.toString()}`)
                .join('\n'),
        )
        for (const [k, v] of Object.entries(kept)) expect([k, v >= 0n]).toEqual([k, true])
    })

    it('refuses deposit, start_draw, locate, requote, expire and claim below their minimum, with no state change', async () => {
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
            () => env.jackpot.sendLocate(alice.getSender(), { value: short(env.fees.locate), slot: 0 }),
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
