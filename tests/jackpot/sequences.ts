/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-unnecessary-condition -- test harness code that reads state it just made */
// Random sequences of everything a player, Hipo and the keeper do, run in the sandbox against the real Hipo
// contracts and the test build of the Jackpot (tests/jackpot/testbuild.ts, so that every draw has a round).
// After every chain of transactions the invariants of the amendment's "Property, extended" criterion are checked,
// and every draw's slots are recomputed from the logs alone: the drand signature of the round and the mc_hash the
// boundary logged (the "Winners recomputed" criterion). Used by tests/Property.spec.ts.
import {
    BlockchainSnapshot,
    BlockchainTransaction,
    SandboxContract,
    TreasuryContract,
    createEmptyShardAccount,
} from '@ton/sandbox'
import { Address, Cell, Message, beginCell, toNano } from '@ton/core'
import { createHash } from 'crypto'
import {
    BookingLog,
    DrawState,
    JackpotOp,
    LogMessage,
    LogTopic,
    RandomnessLog,
    SkipLog,
    SlotLog,
    SlotResult,
    WithdrawalLog,
    attemptsPerSlot,
    logsOf,
    parseLogStrict,
    submitCutoff,
} from '../../wrappers/Jackpot'
import {
    Env,
    depositHgram,
    expectSolvent,
    hgramOf,
    makeBoundary,
    mintHgram,
    nodeAt,
    opOf,
    poke,
    setupJackpot,
    start,
    submitTest,
    walletAt,
    withdraw,
} from './setup'
import { atJackpot, deliver, submitMessage } from './scenario'
import { testSignature } from './testbuild'

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
        int: (n: number) => Math.floor(next() * n),
        pick: <T>(xs: T[]): T => xs[Math.floor(next() * xs.length)],
    }
}

export class SequenceFailure extends Error {}

export interface World {
    env: Env
    players: SandboxContract<TreasuryContract>[]
    snapshot: BlockchainSnapshot
    // the number of cells of the Jackpot's data at deploy, content aside: it must never change
    dataCells: number
    // counts the per-transaction checks when the stepper is installed
    mid: { count: number }
}

// The cells of a cell tree (shared cells counted once), with the content cell left out.
function cellsOf(root: Cell, skip: Cell) {
    const seen = new Set<string>()
    const skipHash = skip.hash().toString('hex')
    const walk = (c: Cell) => {
        const h = c.hash().toString('hex')
        if (seen.has(h) || h === skipHash) return
        seen.add(h)
        c.refs.forEach(walk)
    }
    walk(root)
    return seen.size
}

async function dataCells(env: Env) {
    const c = await env.blockchain.getContract(env.jackpot.address)
    if (c.accountState?.type !== 'active') throw new Error('the Jackpot is not active')
    const content = (await env.jackpot.getJettonData()).content
    return cellsOf(c.accountState.state.data!, content)
}

// The per-transaction mode: every chain is run one transaction at a time, and after each transaction the
// solvency invariants are checked: free_tokens >= 0, free_tokens·TC >= principal·TT at the stored rate,
// tickets = principal, and the real wallet >= held_tokens.
function installStepper(env: Env, mid: { count: number }) {
    const qm = (
        env.blockchain as unknown as {
            defaultQueueManager: {
                runQueue: (params?: unknown) => Promise<unknown>
                runQueueIter: (lock: boolean, params?: unknown) => AsyncIterable<BlockchainTransaction>
            }
        }
    ).defaultQueueManager
    qm.runQueue = async (params?: unknown) => {
        const transactions: BlockchainTransaction[] = []
        for await (const tx of qm.runQueueIter(true, params)) {
            transactions.push(tx)
            await midCheck(env, mid, tx)
        }
        ;(env.blockchain as unknown as { onTransactions?: (t: unknown) => void }).onTransactions?.(transactions)
        return {
            transactions,
            events: transactions.flatMap((t) => t.events),
            externals: transactions.flatMap((t) => t.externals),
        }
    }
}

async function midCheck(env: Env, mid: { count: number }, tx: BlockchainTransaction) {
    mid.count++
    try {
        await expectSolvent(env)
        const s = await env.jackpot.getJackpotState()
        if (s.heldTokens < 0n || s.incomingTokens < 0n || s.reservedTokens < 0n)
            throw new Error('a counter is negative')
    } catch (e) {
        throw new SequenceFailure(`after transaction ${String(tx.lt)} (op ${String(opOf(tx))}): ${String(e)}`)
    }
}

export async function makeWorld(): Promise<World> {
    const env = await setupJackpot({
        testBuild: true,
        time: start,
        config: { minGap: 3600, minDeposit: toNano('1') },
    })
    const players: SandboxContract<TreasuryContract>[] = []
    for (let i = 0; i < 4; i++) players.push(await env.blockchain.treasury(`p${i.toString()}`))
    // everyone holds hGRAM from the start, so a deposit is one chain
    for (const p of players) await mintHgram(env, p, toNano('800'))
    // any pot sets a draw aside, so that the sequences reach the searches
    await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: toNano('0.05'), minPot: 1n })
    const mid = { count: 0 }
    if (process.env.PROPERTY_EACH_TX) installStepper(env, mid)
    return { env, players, snapshot: env.blockchain.snapshot(), dataCells: await dataCells(env), mid }
}

export interface Result {
    transactions: number
    draws: number
    withdrawals: number
    winners: number
    misses: number
    rollovers: number
    interleaved: number
    stuck: number
    boundaries: number
    skips: number
    pokes: number
    bounces: number
    untracked: number
    logs: number
    midChecks: number
}

interface Pos {
    owner: string
    bal: bigint
}

interface Chain {
    externals: LogMessage[]
    transactions: unknown[]
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest()
const word = (n: bigint) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex')
const logTopics = new Set<number>(Object.values(LogTopic))

export async function runSequence(world: World, seed: number, steps = 16): Promise<Result> {
    const { env, players } = world
    await env.blockchain.loadFrom(world.snapshot)
    env.blockchain.now = start
    env.bookings.length = 0
    const r = rng(seed)
    const log: string[] = []
    const result: Result = {
        transactions: 0,
        draws: 0,
        withdrawals: 0,
        winners: 0,
        misses: 0,
        rollovers: 0,
        interleaved: 0,
        stuck: 0,
        boundaries: 0,
        skips: 0,
        pokes: 0,
        bounces: 0,
        untracked: 0,
        logs: 0,
        midChecks: 0,
    }

    const pos = new Map<number, Pos>() // the model: every position's balance
    let snap: { b: number; owner: string; tickets: bigint }[] = []
    let removed = new Map<number, bigint>()
    let tag = 0n
    let untracked = 0n // hGRAM sent to the Jackpot with no notification: the failures the run injected

    const fail = (what: string): never => {
        throw new SequenceFailure(`seed ${seed.toString()}: ${what}\n  ops: ${log.join(' | ')}`)
    }

    const begin = () => new Map([...pos].map(([b, p]) => [b, { ...p }]))
    // Applies a chain's logs to the model; a boundary is detected by the tag moving, and the snapshot is what
    // the model held before the chain. Every log must be an external out to addr_none that parses to the end.
    const finish = async (what: string, before: Map<number, Pos>, res: Chain, pokeAllowed = false) => {
        result.transactions += res.transactions.length
        for (const m of res.externals) {
            if (m.info.dest != null) fail(`${what}: a log with a destination`)
            const t = parseLogStrict(m)
            if (!logTopics.has(t.topic)) fail(`${what}: a log with an unknown tag`)
            result.logs++
        }
        // the treasury is asked for a quote only after a poke
        const asked = (res.transactions as BlockchainTransaction[]).filter(
            (t) =>
                t.inMessage?.info.dest?.toString() === env.hipo.treasury.address.toString() &&
                opOf(t) === JackpotOp.provideCurrentQuote,
        )
        if (asked.length > 0 && !pokeAllowed) fail(`${what}: a quote was asked for outside a poke`)
        const state = await env.jackpot.getJackpotState()
        if (state.tag > tag) {
            snap = [...before].sort((a, b) => a[0] - b[0]).map(([b, p]) => ({ b, owner: p.owner, tickets: p.bal }))
            removed = new Map()
            tag = state.tag
            result.boundaries++
            const total = snap.reduce((a, x) => a + x.tickets, 0n)
            const draw = await env.jackpot.getDrawState()
            if (draw.state === DrawState.waiting && draw.snapshotTickets !== total)
                fail(`${what}: snapshot ${draw.snapshotTickets.toString()} != model ${total.toString()}`)
        }
        if (logsOf<SkipLog>(res.externals, LogTopic.skip).length > 0) result.skips++
        for (const b of logsOf<BookingLog>(res.externals, LogTopic.booking)) {
            const p = pos.get(Number(b.b)) ?? { owner: b.owner.toString(), bal: 0n }
            p.bal += b.principal
            pos.set(Number(b.b), p)
        }
        for (const w of logsOf<WithdrawalLog>(res.externals, LogTopic.withdrawal)) {
            const p = pos.get(Number(w.b))!
            p.bal -= w.principal
            removed.set(Number(w.b), (removed.get(Number(w.b)) ?? 0n) + w.principal)
            result.withdrawals++
        }
        for (const x of logsOf<SlotLog>(res.externals, LogTopic.slot)) {
            if (x.result === SlotResult.expired || x.result === SlotResult.rolledOver) result.rollovers++
        }
        return res
    }
    const apply = async (what: string, run: () => Promise<Chain>, pokeAllowed = false) => {
        log.push(what)
        const before = begin()
        return finish(what, before, await run(), pokeAllowed)
    }

    let checks = 0
    const check = async (what: string, deep = false) => {
        checks++
        try {
            await expectSolvent(env) // free >= 0, solvency at the stored rate, tickets = principal, held <= wallet
        } catch (e) {
            fail(`${what}: solvency: ${String(e)}`)
        }
        const s = await env.jackpot.getJackpotState()
        if (s.incomingTokens !== 0n) fail(`${what}: incoming_tokens ${s.incomingTokens.toString()} after the chain`)
        const sum = [...pos.values()].reduce((a, p) => a + p.bal, 0n)
        if (s.principal !== sum)
            fail(`${what}: principal ${s.principal.toString()} != sum of balances ${sum.toString()}`)
        if (s.tickets !== s.principal) fail(`${what}: tickets != principal`)
        // untracked hGRAM is what the run injected, to the nano-hGRAM
        const gap = (await hgramOf(env, env.jackpot.address)) - s.heldTokens
        if (gap !== untracked) fail(`${what}: untracked ${gap.toString()} != injected ${untracked.toString()}`)
        // fixed storage: the same cells as at deploy, whatever came in
        const cells = await dataCells(env)
        if (cells !== world.dataCells)
            fail(`${what}: the data has ${cells.toString()} cells, not ${world.dataCells.toString()}`)
        // the tree: committed + added - removed of each position is its balance, and the top node is the principal
        const nodeState = await env.blockchain.getContract(nodeAt(env, 1, 0n).address)
        if (nodeState.accountState?.type === 'active') {
            const leaf = await nodeAt(env, 1, 0n).getNodeData()
            for (const [b, p] of pos) {
                const c = b & 63
                const v = leaf.committed[c] + leaf.added[c] - leaf.removed[c]
                if (v !== p.bal) fail(`${what}: node(1,0)[${b.toString()}] = ${v.toString()} != ${p.bal.toString()}`)
            }
            // every node of the first branch: each entry of a node is the total of the node below it
            for (let level = 2; level <= 4 && (deep || checks % 4 === 0); level++) {
                const here = nodeAt(env, level, 0n)
                if ((await env.blockchain.getContract(here.address)).accountState?.type !== 'active') continue
                const data = await here.getNodeData()
                for (let c = 0; c < 64; c++) {
                    const entry = data.committed[c] + data.added[c] - data.removed[c]
                    const below = nodeAt(env, level - 1, BigInt(c))
                    let sumBelow = 0n
                    if ((await env.blockchain.getContract(below.address)).accountState?.type === 'active') {
                        const d = await below.getNodeData()
                        sumBelow = d.committed.reduce((a, x, i) => a + x + d.added[i] - d.removed[i], 0n)
                    }
                    if (entry !== sumBelow)
                        fail(
                            `${what}: node(${level.toString()},0)[${c.toString()}] = ${entry.toString()} but the node below holds ${sumBelow.toString()}`,
                        )
                }
            }
            const top = await nodeAt(env, 4, 0n).getNodeData()
            const total =
                top.committed.reduce((a, x) => a + x, 0n) +
                top.added.reduce((a, x) => a + x, 0n) -
                top.removed.reduce((a, x) => a + x, 0n)
            if (total !== s.principal)
                fail(`${what}: top node ${total.toString()} != principal ${s.principal.toString()}`)
        }
        // jGRAM: every open wallet agrees with the model
        for (const pl of players) {
            const st = await env.blockchain.getContract(walletAt(env, pl.address).address)
            if (st.accountState?.type !== 'active') continue
            const w = await walletAt(env, pl.address).getWalletState()
            if (w.balance > 0n && !w.hasPosition) fail(`${what}: a balance with no position`)
            if (w.hasPosition && w.balance !== (pos.get(Number(w.position))?.bal ?? -1n))
                fail(`${what}: wallet ${w.balance.toString()} != model`)
        }
    }

    // Recomputes every slot of a draw from the logs and the model, as of the snapshot: the seed is
    // sha256(signature ‖ mc_hash), k(i,j) = sha256(seed ‖ i ‖ j) mod snapshot_tickets.
    const checkDraw = (
        what: string,
        res: { externals: LogMessage[] },
        round: number,
        mcHash: bigint,
        snapshotTickets: bigint,
    ) => {
        const total = snap.reduce((a, x) => a + x.tickets, 0n)
        if (snapshotTickets !== total) fail(`${what}: the draw's snapshot differs from the model`)
        const [rl] = logsOf<RandomnessLog>(res.externals, LogTopic.randomness)
        const seedBytes = sha256(Buffer.concat([testSignature(round), word(mcHash)]))
        if (rl == null) fail(`${what}: no randomness log`)
        if (rl.seed !== BigInt('0x' + seedBytes.toString('hex')))
            fail(`${what}: the logged seed is not sha256(signature ‖ mc_hash)`)
        result.draws++
        const slots = logsOf<SlotLog>(res.externals, LogTopic.slot)
        for (let slot = 0; slot < 3; slot++) {
            const mine = slots.filter((x) => x.slot === slot)
            let j = 0
            for (; j < attemptsPerSlot; j++) {
                const k =
                    BigInt('0x' + sha256(Buffer.concat([seedBytes, Buffer.from([slot, j])])).toString('hex')) % total
                let rest = k
                let hit: { b: number; owner: string } | undefined
                for (const p of snap) {
                    if (rest < p.tickets) {
                        const live = p.tickets - (removed.get(p.b) ?? 0n)
                        if (rest < live) hit = p
                        break
                    }
                    rest -= p.tickets
                }
                const got = mine[j]
                if (got == null) fail(`${what}: slot ${slot.toString()} attempt ${j.toString()} missing in the logs`)
                if (got.position !== k) fail(`${what}: position ${got.position.toString()} != ${k.toString()}`)
                if (hit) {
                    if (got.result !== SlotResult.hit || got.owner?.toString() !== hit.owner)
                        fail(`${what}: slot ${slot.toString()} winner differs`)
                    result.winners++
                    break
                }
                if (got.result !== SlotResult.miss)
                    fail(`${what}: slot ${slot.toString()} attempt ${j.toString()} should miss`)
                result.misses++
            }
            if (j === attemptsPerSlot && mine[j]?.result !== SlotResult.rolledOver)
                fail(`${what}: slot ${slot.toString()} should roll over`)
        }
    }

    const midStart = world.mid.count
    const withdrawerOf = async () => {
        const open: SandboxContract<TreasuryContract>[] = []
        for (const pl of players) {
            const st = await env.blockchain.getContract(walletAt(env, pl.address).address)
            if (st.accountState?.type !== 'active') continue
            if ((await walletAt(env, pl.address).getWalletState()).balance > 0n) open.push(pl)
        }
        return open.length ? r.pick(open) : undefined
    }
    const amountOf = (balance: bigint) => {
        const full = r.next() < 0.4 || balance < toNano('3')
        return full ? 0n : toNano('1') + BigInt(r.int(Number(balance / 10n ** 9n) - 1)) * 10n ** 9n
    }
    // a draw that is waiting, and whether a submit is still taken: now < last_boundary + min_gap - S
    const waiting = async () => {
        const d = await env.jackpot.getDrawState()
        const b = await env.jackpot.getBoundary()
        const now: number = env.blockchain.now ?? start
        return { d, open: d.state === DrawState.waiting && now < b.lastBoundary + b.minGap - submitCutoff }
    }
    const freezeWallet = async (owner: Address) => {
        const addr = walletAt(env, owner).address
        const acc = (await env.blockchain.getContract(addr)).account
        const state = acc.account!.storage.state
        if (state.type !== 'active') return undefined
        const init = beginCell().storeUint(6, 5).storeRef(state.state.code!).storeRef(state.state.data!).endCell()
        await env.blockchain.setShardAccount(addr, {
            ...acc,
            account: {
                ...acc.account!,
                storage: {
                    ...acc.account!.storage,
                    state: { type: 'frozen', stateHash: BigInt('0x' + init.hash().toString('hex')) },
                },
            },
        })
        return { addr, acc }
    }

    for (let step = 0; step < steps; step++) {
        let roll = r.next()
        const w0 = await waiting()
        // a draw that is waiting inside its window is submitted more often than chance would
        if (w0.open && r.next() < 0.45) roll = 0.95
        if (step < 2) roll = 0
        const pl = r.pick(players)
        const s = await env.jackpot.getJackpotState()
        if (roll < 0.2) {
            const held = await hgramOf(env, pl.address)
            if (held < toNano('10')) continue
            const t = toNano(String(5 + r.int(Number(held / 10n ** 9n) > 400 ? 400 : Number(held / 10n ** 9n) - 5)))
            // a wallet frozen by hand: the full-body bounce brings the deposit back and the tokens return whole
            const open =
                (await env.blockchain.getContract(walletAt(env, pl.address).address)).accountState?.type === 'active'
            if (open && r.next() < 0.3) {
                const saved = await freezeWallet(pl.address)
                if (saved != null) {
                    const before = await hgramOf(env, pl.address)
                    await apply(`deposit ${t.toString()} to a frozen wallet`, () =>
                        depositHgram(env, pl, t, { minC: 0n }).then((x) => x.result),
                    )
                    if ((await hgramOf(env, pl.address)) !== before) fail('a bounced deposit did not return the tokens')
                    await env.blockchain.setShardAccount(saved.addr, saved.acc)
                    result.bounces++
                    await check(log[log.length - 1])
                    continue
                }
            }
            await apply(`deposit ${t.toString()}`, () => depositHgram(env, pl, t, { minC: 0n }).then((x) => x.result))
        } else if (roll < 0.34) {
            const who = await withdrawerOf()
            if (who == null) continue
            const ws = await walletAt(env, who.address).getWalletState()
            const x = amountOf(ws.balance)
            await apply(`withdraw ${x.toString()}`, () => withdraw(env, who, x))
        } else if (roll < 0.4) {
            const who = await withdrawerOf()
            if (who == null) continue
            await apply('w', () =>
                env.jackpot.sendComment(who.getSender(), { value: env.fees.commentWithdraw, text: 'w' }),
            )
        } else if (roll < 0.5) {
            // a reward in parts: a part lands, and a poke may come between the parts
            if (s.principal > 0n) {
                const [coins] = await env.hipo.quote()
                const parts = 1 + r.int(2)
                for (let part = 0; part < parts; part++) {
                    const gram = (coins * BigInt(1 + r.int(4))) / 1000n
                    await apply(`reward part ${gram.toString()}`, async () => {
                        await env.hipo.raiseRate(gram)
                        return { externals: [], transactions: [] }
                    })
                    if (r.next() < 0.5) {
                        env.blockchain.now = (env.blockchain.now ?? start) + 10 + r.int(300)
                        result.pokes++
                        await apply('poke between the parts', () => poke(env), true)
                    }
                }
            }
        } else if (roll < 0.55) {
            // a gift of coins to Hipo: a rise that no round brought
            const [coins] = await env.hipo.quote()
            const gram = (coins * BigInt(1 + r.int(30))) / 10000n
            await apply(`gift ${gram.toString()}`, async () => {
                await env.hipo.raiseRate(gram)
                return { externals: [], transactions: [] }
            })
        } else if (roll < 0.67) {
            env.blockchain.now = (env.blockchain.now ?? start) + 10 + r.int(2000)
            result.pokes++
            await apply('poke', () => poke(env), true)
        } else if (roll < 0.8) {
            // a boundary: min_gap later, a reward, a poke; with a draw waiting it is a skip
            if (s.principal > 0n) {
                result.pokes++
                await apply('boundary', () => makeBoundary(env), true)
            }
        } else if (roll < 0.85) {
            // hGRAM sent with no notification stays untracked
            const held = await hgramOf(env, pl.address)
            if (held < toNano('5')) continue
            const t = toNano(String(1 + r.int(3)))
            const wallet = await env.hipo.walletOf(pl.address)
            await apply(`untracked ${t.toString()}`, () =>
                wallet.sendSendTokens(pl.getSender(), {
                    value: toNano('0.3'),
                    tokens: t,
                    recipient: env.jackpot.address,
                    returnExcess: pl.address,
                    forwardTonAmount: 0n,
                }),
            )
            untracked += t
            result.untracked++
        } else {
            const w = await waiting()
            if (w.open && s.principal > 0n) {
                const round = Number(w.d.round)
                const kind = r.next()
                if (kind < 0.4) {
                    // a player withdraws after the randomness is known and before the searches run
                    log.push('submit, withdraw, searches')
                    const before = begin()
                    const txs: BlockchainTransaction[] = []
                    let outs: Message[] = []
                    for await (const tx of await env.blockchain.sendMessageIter(await submitMessage(env))) {
                        txs.push(tx)
                        if (process.env.PROPERTY_EACH_TX) await midCheck(env, world.mid, tx)
                        if (atJackpot(env, JackpotOp.submitRandomness)(tx)) {
                            ;(
                                env.blockchain as unknown as { defaultQueueManager: { messageQueue: unknown[] } }
                            ).defaultQueueManager.messageQueue.length = 0
                            outs = [...tx.outMessages.values()].filter((m) => m.info.type === 'internal')
                            break
                        }
                    }
                    const first = await finish('submit', before, {
                        externals: txs.flatMap((t) => t.externals),
                        transactions: txs,
                    })
                    const who = await withdrawerOf()
                    if (who) {
                        const ws = await walletAt(env, who.address).getWalletState()
                        await apply('withdraw between submit and searches', () =>
                            withdraw(env, who, amountOf(ws.balance)),
                        )
                    }
                    const externals = [...first.externals]
                    for (const m of outs) {
                        const res = await finish('searches', begin(), await deliver(env, m))
                        externals.push(...res.externals)
                    }
                    result.interleaved++
                    checkDraw('interleaved', { externals }, round, w.d.mcHash, w.d.snapshotTickets)
                } else if (kind < 0.5) {
                    // a node that never answers: the slots roll over at the next boundary
                    log.push('stuck draw')
                    const node = nodeAt(env, 3, 0n)
                    const saved = (await env.blockchain.getContract(node.address)).account
                    await env.blockchain.setShardAccount(node.address, createEmptyShardAccount(node.address))
                    await apply('submit (stuck)', () => submitTest(env, round))
                    result.pokes++
                    await apply('boundary (rolls the slots over)', () => makeBoundary(env), true)
                    await env.blockchain.setShardAccount(node.address, saved)
                    result.stuck++
                } else {
                    const res = await apply('submit', () => submitTest(env, round))
                    checkDraw('submit', res, round, w.d.mcHash, w.d.snapshotTickets)
                }
            } else {
                env.blockchain.now = (env.blockchain.now ?? start) + 100
            }
        }
        await check(log[log.length - 1] ?? 'start')
    }

    // everyone leaves: the pool, the wallets and every node end empty
    for (const pl of players) {
        const st = await env.blockchain.getContract(walletAt(env, pl.address).address)
        if (st.accountState?.type !== 'active') continue
        if ((await walletAt(env, pl.address).getWalletState()).balance === 0n) continue
        await apply('exit', () => withdraw(env, pl, 0n))
    }
    await check('final exit', true)
    const end = await env.jackpot.getJackpotState()
    if (end.principal !== 0n || end.tickets !== 0n || end.incomingTokens !== 0n)
        fail(
            `final exit: principal ${end.principal.toString()}, tickets ${end.tickets.toString()}, incoming ${end.incomingTokens.toString()}`,
        )
    result.midChecks = world.mid.count - midStart
    return result
}
