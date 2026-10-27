/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests read state they just made */
// Random sequences of everything a player, Hipo and the keeper do, run against the real Hipo contracts,
// with the Jackpot's solvency checked after every transaction that touches it or its hGRAM wallet.
// Used by tests/Property.spec.ts (the long run) and tests/Acceptance.spec.ts (a short one).
import { BlockchainSnapshot, BlockchainTransaction } from '@ton/sandbox'
import { Address, beginCell, Cell, toNano } from '@ton/core'
import {
    BookingLog,
    DrawStartLog,
    DrawState,
    JackpotOp,
    LogTopic,
    SlotLog,
    SlotResult,
    WithdrawalLog,
    logsOf,
} from '../../wrappers/Jackpot'
import { roundTime } from '../../wrappers/drand'
import { Env, quicknet } from './setup'
import {
    Counters,
    Player,
    Run,
    counters,
    deliver,
    depositCoinsBody,
    failed,
    jackpotWallet,
    msg,
    opBody,
    sendTokensBody,
    setupAt,
    solvencyError,
    submitBody,
    walletTokens,
} from './adversary'

// mulberry32: small, fast and seedable.
export function rng(seed: number) {
    let a = seed >>> 0
    const next = () => {
        a = (a + 0x6d2b79f5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    return {
        next,
        int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
        big: (lo: bigint, hi: bigint) => lo + (BigInt(Math.floor(next() * 2 ** 52)) * (hi - lo + 1n)) / 2n ** 52n,
        pick: <T>(xs: T[]) => xs[Math.floor(next() * xs.length)],
    }
}

// Drand rounds in time order; a sequence uses them one draw after another.
export const drandRounds = [...quicknet].sort((a, b) => a.round - b.round).map((r) => r.round)

export interface World {
    env: Env
    players: Player[]
    jackpotWallet: Address
    walletOf: Map<string, Address>
    snapshot: BlockchainSnapshot
}

export async function makeWorld(): Promise<World> {
    // start an hour before the oldest recorded drand round, so every fixture round can be drawn for
    const env = await setupAt(roundTime(drandRounds[0]) - 3600, {
        // small thresholds, so that draws and burns happen in short sequences
        config: { minPot: 1000n, burnBatch: toNano('0.05') },
    })
    const players: Player[] = []
    for (let i = 0; i < 4; i++) players.push(await env.blockchain.treasury(`player-${i.toString()}`))
    const walletOf = new Map<string, Address>()
    for (const p of [...players, env.burner])
        walletOf.set(p.address.toString(), await env.hipo.walletAddress(p.address))
    const world: World = {
        env,
        players,
        jackpotWallet: await jackpotWallet(env),
        walletOf,
        snapshot: env.blockchain.snapshot(),
    }
    return world
}

interface RangeView {
    owner: Address
    start: bigint
    length: bigint
    live: bigint
}

export interface SequenceResult {
    seed: number
    ops: string[]
    transactions: number
    draws: number
    withdrawals: number
}

export class SequenceFailure extends Error {
    constructor(
        readonly seed: number,
        readonly ops: string[],
        message: string,
    ) {
        super(`seed ${seed.toString()}: ${message}\n  ops: ${ops.join(' → ')}`)
    }
}

// One sequence from the world's snapshot. Throws SequenceFailure, naming the seed, on any violation.
export async function runSequence(world: World, seed: number, maxOps = 10): Promise<SequenceResult> {
    const { env, players } = world
    await env.blockchain.loadFrom(world.snapshot)
    env.bookings = []
    const r = rng(seed)
    const ops: string[] = []
    const ranges: RangeView[] = []
    const principal = new Map<string, bigint>()
    const withdrawn = new Map<string, { tokens: bigint; count: bigint }>()
    let txCount = 0
    let draws = 0
    let withdrawals = 0
    let roundIndex = 0
    const key = (a: Address) => a.toString()

    const fail = (message: string): never => {
        throw new SequenceFailure(seed, ops, message)
    }

    const watched = new Set([env.jackpot.address.toString(), world.jackpotWallet.toString()])
    const after = async (tx: BlockchainTransaction) => {
        txCount++
        const address = new Address(0, Buffer.from(tx.address.toString(16).padStart(64, '0'), 'hex')).toString()
        if (!watched.has(address)) return
        const error = await solvencyError(env, world.jackpotWallet)
        if (error != null) fail(`after a transaction on ${address}: ${error}`)
    }

    const run = async (from: Address, to: Address, value: bigint, body: Cell, what: string) => {
        const result = await deliver(env.blockchain, msg(from, to, value, body), { after })
        const bad = failed(result.transactions)
        if (bad.length > 0) fail(`${what}: ${bad.length.toString()} failed transaction(s)`)
        absorb(result)
        return result
    }

    const absorb = (result: Run) => {
        for (const b of logsOf<BookingLog>(result.externals, LogTopic.booking)) {
            ranges.push({ owner: b.owner, start: b.start, length: b.principal, live: b.principal })
            env.bookings.push(b)
            principal.set(key(b.owner), (principal.get(key(b.owner)) ?? 0n) + b.principal)
        }
        for (const w of logsOf<WithdrawalLog>(result.externals, LogTopic.withdrawal)) {
            const range = ranges.find((x) => x.start === w.start)!
            range.live -= w.principal
            const s = withdrawn.get(key(w.owner)) ?? { tokens: 0n, count: 0n }
            withdrawn.set(key(w.owner), { tokens: s.tokens + w.tokens, count: s.count + 1n })
            withdrawals++
        }
    }

    const fees = env.fees
    const hipoFee = toNano('0.1')

    const gramDeposit = async (p: Player, gram: bigint) => {
        ops.push(`gram(${p.address.toString().slice(-4)}, ${gram.toString()})`)
        await run(p.address, env.jackpot.address, gram + fees.deposit, opBody(JackpotOp.deposit), 'GRAM deposit')
    }

    const hgramDeposit = async (p: Player, gram: bigint) => {
        ops.push(`hgram(${p.address.toString().slice(-4)}, ${gram.toString()})`)
        const wallet = world.walletOf.get(key(p.address))!
        await run(
            p.address,
            env.hipo.treasury.address,
            gram + hipoFee,
            depositCoinsBody(0n, null, gram),
            'mint at Hipo',
        )
        const tokens = await walletTokens(env.blockchain, wallet)
        const amount = r.next() < 0.5 ? tokens : r.big(1n, tokens)
        await run(
            p.address,
            wallet,
            fees.hgramDeposit + toNano('0.1'),
            sendTokensBody({
                amount,
                recipient: env.jackpot.address,
                returnExcess: p.address,
                forward: fees.hgramDeposit,
            }),
            'hGRAM deposit',
        )
    }

    const withdraw = async (range: RangeView, x: bigint) => {
        ops.push(`withdraw(${range.start.toString()}, ${x.toString()})`)
        const rangeAddress = await env.jackpot.getRangeAddress(range.start)
        const body = beginCell().storeUint(JackpotOp.withdraw, 32).storeUint(0, 64).storeCoins(x).endCell()
        await run(range.owner, rangeAddress, fees.withdraw, body, 'withdraw')
    }

    const raise = async (gram: bigint) => {
        ops.push(`raise(${gram.toString()})`)
        await env.hipo.raiseRate(gram)
    }

    const nextRound = async () => {
        ops.push('round')
        await env.hipo.nextValidationRound()
    }

    const draw = async () => {
        if (roundIndex >= drandRounds.length) return
        const round = drandRounds[roundIndex]
        const at = roundTime(round) - 60
        if (at < env.blockchain.now!) {
            roundIndex++
            return
        }
        roundIndex++
        ops.push(`draw(${round.toString()})`)
        await env.hipo.nextValidationRound()
        await env.hipo.raiseRate(r.big(toNano('0.01'), toNano('50')))
        env.blockchain.now = at
        const start = await run(
            env.keeper.address,
            env.jackpot.address,
            fees.startDraw,
            opBody(JackpotOp.startDraw),
            'start_draw',
        )
        const started = logsOf<DrawStartLog>(start.externals, LogTopic.drawStart)
        let state = await env.jackpot.getDrawState()
        if (state.state !== DrawState.waiting) return
        draws++
        await run(
            env.keeper.address,
            env.jackpot.address,
            fees.submitRandomness,
            submitBody(round),
            'submit_randomness',
        )
        const paid: SlotLog[] = []
        for (let guard = 0; guard < 3 * 64 + 3; guard++) {
            state = await env.jackpot.getDrawState()
            if (state.openSlots === 0) break
            const slot = [0, 1, 2].find((i) => (state.openSlots >> i) & 1)!
            const t = await env.jackpot.getTicket(slot)
            const range = ranges.find((x) => x.start <= t && t < x.start + x.length)
            if (range == null) fail(`no range holds ticket ${t.toString()}`)
            const result = await run(
                env.keeper.address,
                env.jackpot.address,
                fees.locate,
                opBody(JackpotOp.locate, [slot, 8], [range!.start, 128]),
                'locate',
            )
            paid.push(...logsOf<SlotLog>(result.externals, LogTopic.slot))
        }
        state = await env.jackpot.getDrawState()
        if (state.state !== DrawState.idle) fail('draw did not resolve')
        // the prizes paid are exactly the three of the draw
        const log = started[0]
        for (const s of paid.filter((x) => x.result === SlotResult.hit)) {
            if (s.amount !== log.prizes[s.slot]) fail(`slot ${s.slot.toString()} paid ${s.amount.toString()}`)
            const range = ranges.find((x) => x.start <= s.ticket && s.ticket < x.start + x.length)!
            if (s.ticket >= log.cutoff) fail('a ticket at or above the cutoff won')
            if (s.ticket >= range.start + range.live) fail('a withdrawn ticket won')
        }
    }

    try {
        const n = r.int(3, maxOps)
        for (let i = 0; i < n; i++) {
            const p = r.pick(players)
            const live = ranges.filter((x) => x.live > 0n)
            const roll = r.next()
            if (roll < 0.25) {
                await gramDeposit(p, r.next() < 0.1 ? toNano('10') : r.big(toNano('10'), toNano('3000')))
            } else if (roll < 0.4) {
                await hgramDeposit(p, r.big(toNano('5'), toNano('3000')))
            } else if (roll < 0.55 && live.length > 0) {
                const range = r.pick(live)
                if (range.live > toNano('2')) await withdraw(range, r.big(toNano('1'), range.live - 1n))
                else await withdraw(range, 0n)
            } else if (roll < 0.62 && live.length > 0) {
                await withdraw(r.pick(live), 0n)
            } else if (roll < 0.75) {
                await raise(r.big(1n, toNano('100')))
            } else if (roll < 0.83) {
                await nextRound()
            } else {
                await draw()
            }
        }

        // everyone leaves
        for (const range of ranges.filter((x) => x.live > 0n)) await withdraw(range, 0n)

        const c: Counters = await counters(env)
        const books = await env.jackpot.getBooks()
        if (c.P !== 0n) fail(`P = ${c.P.toString()} after everyone left`)
        if (c.I !== 0n) fail(`I = ${c.I.toString()} after everyone left`)
        if (books.payouts.size !== 0) fail(`${books.payouts.size.toString()} payout(s) never confirmed`)
        if (books.quotes.size !== 0 || books.pending.size !== 0) fail('records left open')
        // nothing stranded outside T, and nothing counted that is not there
        const real = await walletTokens(env.blockchain, world.jackpotWallet)
        if (real !== c.T) fail(`wallet ${real.toString()} ≠ T ${c.T.toString()}`)
        // each player got back at least their principal, less 1 nano-hGRAM of rounding per withdrawal
        for (const [owner, p] of principal) {
            const w = withdrawn.get(owner) ?? { tokens: 0n, count: 0n }
            if ((w.tokens + w.count) * c.TC < p * c.TT) {
                fail(
                    `${owner} got ${w.tokens.toString()} hGRAM in ${w.count.toString()} withdrawals for ${p.toString()} principal`,
                )
            }
        }
    } catch (e) {
        if (e instanceof SequenceFailure) throw e
        throw new SequenceFailure(seed, ops, e instanceof Error ? e.message : String(e))
    }
    return { seed, ops, transactions: txCount, draws, withdrawals }
}
