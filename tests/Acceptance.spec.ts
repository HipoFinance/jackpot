/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests read state they just made */
// The acceptance criteria of docs/specs/2026-11-03-jackpot-v2-amendment-1.md that are about the price, the seed, the
// rate and the draw's money, one test (or describe) per criterion, named after it. Most run on the test build of the
// Jackpot (any 48 bytes pass for a round's signature, see tests/jackpot/testbuild.ts) so that every draw has a round.
// Boundaries, the cut-off, skips, settings and rhythm are in tests/Boundaries.spec.ts; the composable options in
// tests/Composable.spec.ts; retire, migration and the close handler in tests/Retire.spec.ts; the long runs in
// tests/Soak.spec.ts; the timing rows in tests/Timing.spec.ts; the property run in tests/Property.spec.ts.
//
// SNIPER_SEEDS (1000), HAL_SEEDS (1000) and EXIT_SEEDS (200) set the number of seeds of the sampled criteria.
import '@ton/test-utils'
import { Address, toNano } from '@ton/core'
import {
    BoundaryLog,
    DrawState,
    JackpotError,
    JackpotOp,
    LogTopic,
    SlotLog,
    SlotResult,
    UnstakeLog,
    floatHigh,
    logsOf,
} from '../wrappers/Jackpot'
import {
    Env,
    balanceOf,
    depositHgram,
    expectChainSucceeded,
    expectSolvent,
    hgramOf,
    jackpotState,
    jgramOf,
    mintHgram,
    nodeAt,
    opOf,
    poke,
    slotsIn,
    submitTest,
    walletAt,
    withdraw,
} from './jackpot/setup'
import {
    A0,
    atJackpot,
    deliver,
    fresh,
    holdUntil,
    jackpotWalletTx,
    pokeFake,
    potNow,
    put,
    setNow,
    startDeposit,
    submitDraw,
    submitMessage,
    toAddr,
    toBoundary,
} from './jackpot/scenario'

const G = (n: string | number) => toNano(String(n))
const beta = 1000n // basis points, the initial burn share
const seedsOf = (name: string, spec: number) => Number(process.env[name] ?? String(spec))

// The mean and standard error of what `who` wins in a draw over `n` seeds of the same snapshot, in GRAM.
async function meanPrize(env: Env, snap: ReturnType<Env['blockchain']['snapshot']>, n: number, who: Address) {
    const [tc, tt] = await env.hipo.quote()
    let sum = 0
    let sq = 0
    for (let i = 0; i < n; i++) {
        await env.blockchain.loadFrom(snap)
        const r = await submitDraw(env, i)
        const won = slotsIn(r)
            .filter((x: SlotLog) => x.result === SlotResult.hit && x.owner?.toString() === who.toString())
            .reduce((a, x) => a + x.amount, 0n)
        const g = Number((won * tc) / tt) / 1e9
        sum += g
        sq += g * g
    }
    const mean = sum / n
    const variance = Math.max(sq / n - mean * mean, 0)
    return { mean, se: Math.sqrt(variance / n) }
}

describe('Acceptance', () => {
    describe('Deposits always pay the normal price', () => {
        // v = 0.01, 1, 100 and 10,000 times P, deposited right before a boundary with a full pot.
        const P = G('10')
        const seeds = seedsOf('SNIPER_SEEDS', 1000)
        for (const [label, num, den] of [
            ['0.01', 1n, 100n],
            ['1', 1n, 1n],
            ['100', 100n, 1n],
            ['10,000', 10000n, 1n],
        ] as const) {
            it(`v = ${label} × P: the price is the normal formula, the expected prize minus it is -β·(v - c) in exact arithmetic, and the mean over ${seeds.toString()} seeds is at most 0`, async () => {
                const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('20') })
                const { env, players } = sc
                const [alice, sniper] = players
                await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
                await put(env, alice, P) // P = 10 GRAM of principal
                await env.hipo.raiseRate(G('40')) // a full pot: Q/P about 200%
                await poke(env) // the stored rate has the reward: not a boundary, min_gap has not passed
                const v = (P * num) / den
                const held0 = await hgramOf(env, sniper.address)
                const tokens = (await mintHgram(env, sniper, v)) - held0
                setNow(env, A0 + 3599)
                const before = await potNow(env)
                const dep = await depositHgram(env, sniper, tokens, { minC: 0n })
                const c = dep.booking!.principal
                const [tc, tt] = await env.hipo.quote()
                const vv = (tokens * tc) / tt
                // the on-chain c to the nano
                const potV = (before.pot * tc + tt - 1n) / tt
                expect(c).toBe((vv * P) / (P + potV))
                await toBoundary(env, 0n)
                const snap = env.blockchain.snapshot()
                const state = await env.jackpot.getDrawState()
                const prizes = state.prizes[0] + state.prizes[1] + state.prizes[2]
                const price = vv - c
                // expected prize in GRAM: the sniper's share of the tickets of every slot
                const expectedPrize = (prizes * tc * c) / (tt * (P + c))
                const gain = expectedPrize - price
                const tol = price / 1_000_000n + 5000n
                expect(gain).toBeLessThanOrEqual(tol)
                const target = -(price * beta) / 10000n
                const diff = gain - target
                expect(diff < 0n ? -diff : diff).toBeLessThanOrEqual(price / 100_000n + 5000n)
                // the sampled mean over seeds, with the same snapshot
                const m = await meanPrize(env, snap, seeds, sniper.address)
                // mean prize minus (v - c) is at most zero within 4 standard errors
                expect(m.mean - Number(price) / 1e9).toBeLessThanOrEqual(4 * m.se + Number(tol) / 1e9)
            }, 7_200_000)
        }
    })

    describe('A deposit while a draw waits', () => {
        it('pays the normal formula, wins nothing in the waiting draw, and joins the next snapshot', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 3, mint: G('2000') })
            const { env, players } = sc
            const [alice, bob, carol] = players
            await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
            await put(env, alice, G('300'))
            await put(env, bob, G('300'))
            await toBoundary(env, G('40'))
            expect((await env.jackpot.getDrawState()).state).toBe(DrawState.waiting)
            // the yield since the boundary is the only free pot: the price follows the normal formula
            const before = await potNow(env)
            const [tc, tt] = await env.hipo.quote()
            const dep = await depositHgram(env, carol, G('100'), { minC: 0n })
            const v = (G('100') * tc) / tt
            const potV = (before.pot * tc + tt - 1n) / tt
            expect(dep.booking!.principal).toBe((v * before.state.principal) / (before.state.principal + potV))
            // it wins nothing in the waiting draw
            const draw = await submitDraw(env)
            expectChainSucceeded(draw)
            expect(slotsIn(draw).some((x) => x.owner?.toString() === carol.address.toString())).toBe(false)
            // and it is in the next snapshot
            const next = await toBoundary(env, G('40'))
            const [log] = logsOf<BoundaryLog>(next.externals, LogTopic.boundary)
            expect(log.snapshotTickets).toBe((await jackpotState(env)).tickets)
            expect(await jgramOf(env, carol.address)).toBe(dep.booking!.principal)
        }, 300000)
    })

    describe('No undercharge after a withdrawal', () => {
        it('W 900, H 100 (scaled by 1/1000); W withdraws all; D deposits 100: D books 99.691, and H’s mean prize is 0.279 GRAM', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 3, mint: G('1500') })
            const { env, players } = sc
            const [w, h, d] = players
            await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
            await put(env, w, G('900'))
            await put(env, h, G('100'))
            // a reward that makes the free pot 0.31 GRAM over 1,000 of principal, as the example's 310 over 1,000,000
            const snap0 = env.blockchain.snapshot()
            await env.hipo.raiseRate(G('1'))
            const probe = await potNow(env)
            const potPerGram = Number((probe.pot * probe.tc) / probe.tt) / 1e9
            await env.blockchain.loadFrom(snap0)
            await env.hipo.raiseRate(BigInt(Math.round((0.31 / potPerGram) * 1e9)))
            await poke(env) // stores the rate
            const pot = await potNow(env)
            const potValue = Number((pot.pot * pot.tc) / pot.tt) / 1e9
            expect(potValue).toBeGreaterThan(0.3)
            expect(potValue).toBeLessThan(0.32)
            // W leaves, the stored rate pays them x
            await withdraw(env, w, 0n)
            expect((await jackpotState(env)).principal).toBe(G('100'))
            // D deposits 100 GRAM of value
            const dHeld = await hgramOf(env, d.address)
            const tokens = (await mintHgram(env, d, G('100'))) - dHeld
            setNow(env, A0 + 3599)
            const dep = await depositHgram(env, d, tokens, { minC: 0n })
            const c = dep.booking!.principal
            expect(Math.abs(Number(c) / 1e9 - 99.691)).toBeLessThan(0.01)
            // H’s mean prize: the pot is fixed at the next boundary, with D's price in it
            await toBoundary(env, 0n)
            const snap = env.blockchain.snapshot()
            const state = await env.jackpot.getDrawState()
            const [tc, tt] = await env.hipo.quote()
            const rest = state.prizes[0] + state.prizes[1] + state.prizes[2]
            const expectedH = Number((rest * tc * G('100')) / (tt * (G('100') + c))) / 1e9
            expect(Math.abs(expectedH - 0.279)).toBeLessThan(0.004)
            const m = await meanPrize(env, snap, seedsOf('HAL_SEEDS', 1000), h.address)
            console.log('H mean prize', m.mean, '+-', m.se, 'expected', expectedH)
            expect(Math.abs(m.mean - expectedH)).toBeLessThanOrEqual(4 * m.se + 1e-6)
        }, 7_200_000)
    })

    describe('The seed-informed exit is closed', () => {
        it('a player who burns after seeing that they lost gives up only their own chance: the honest player’s prizes are the same, seed by seed', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
            const { env, players } = sc
            const [honest, other] = players
            await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
            await put(env, honest, G('500'))
            await put(env, other, G('500'))
            await toBoundary(env, G('40'))
            const snap = env.blockchain.snapshot()
            const prizeOf = (slots: SlotLog[], who: Address) =>
                slots
                    .filter((x) => x.result === SlotResult.hit && x.owner?.toString() === who.toString())
                    .reduce((a, x) => a + x.amount, 0n)
            let lost = 0
            const n = seedsOf('EXIT_SEEDS', 200)
            for (let i = 0; i < n; i++) {
                await env.blockchain.loadFrom(snap)
                const plain = slotsIn(await submitDraw(env, i))
                if (prizeOf(plain, other.address) > 0n) continue // only a seed the other player lost
                lost++
                // the seed is public (the submit ran); the loser burns before the searches
                await env.blockchain.loadFrom(snap)
                const held = await holdUntil(
                    env,
                    await submitMessage(env, i),
                    atJackpot(env, JackpotOp.submitRandomness),
                )
                await withdraw(env, other, 0n)
                const searched: SlotLog[] = []
                for (const m of held) searched.push(...slotsIn(await deliver(env, m)))
                expect(prizeOf(searched, honest.address)).toBe(prizeOf(plain, honest.address))
            }
            console.log('seeds the other player lost:', lost, 'of', n)
            expect(lost).toBeGreaterThan(0)
        }, 7_200_000)
    })

    describe('Pot 0', () => {
        it('at pot 0, c = v to the nano for v from 0.01 to 10,000 times P', async () => {
            for (const [num, den] of [
                [1n, 100n],
                [1n, 1n],
                [100n, 1n],
                [10000n, 1n],
            ] as const) {
                const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('20') })
                const { env, players } = sc
                await put(env, players[0], G('10'))
                const v = (G('10') * num) / den
                const tokens = await mintHgram(env, players[1], v)
                const dep = await depositHgram(env, players[1], tokens, { minC: 0n })
                const [tc, tt] = await env.hipo.quote()
                expect(dep.booking!.principal).toBe((tokens * tc) / tt)
            }
        }, 300000)
    })

    describe('The rate cancels with a pot', () => {
        it('with a stored pot above 0, the booking changes by at most 2 + booked/free nano when the stored rate is anywhere from half to twice the true one, and the expected prize minus the price is the same at every stored rate', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000'), fake: true })
            const { env, players } = sc
            const [alice, bob] = players
            await put(env, alice, G('100')) // P = 100 at the deploy rate
            const base = env.blockchain.snapshot()
            const t = G('50')
            const results: { r: number; c: bigint; gain: number }[] = []
            const F = (await jackpotState(env)).heldTokens
            for (const [tc, tt] of [
                [105n, 100n],
                [150n, 100n],
                [210n, 100n],
            ]) {
                await env.blockchain.loadFrom(base)
                await pokeFake(sc, tc * 10n ** 9n, tt * 10n ** 9n)
                const dep = await depositHgram(env, bob, t, { minC: 0n })
                const c = dep.booking!.principal
                const P = G('100')
                const r = 1.5 // Hipo's true rate; only the stored rate varies
                // in hGRAM: the price is (v - c)/r; the prize is the deposit's share of the pot after it, less the burn
                const price = Number(t) - Number(c) / r
                const potH = Number(F) - Number(P) / r
                const prize = (Number(c) / (Number(P) + Number(c))) * 0.9 * (potH + price)
                results.push({ r: Number(tc) / Number(tt), c, gain: (prize - price) / 1e9 })
            }
            const mid = results[1]
            for (const x of results) {
                const slack = 2n + x.c / F + 1n
                expect(x.c > mid.c ? x.c - mid.c : mid.c - x.c).toBeLessThanOrEqual(2n * slack)
                // the rate cancels: t·P/F, whatever the stored rate
                expect(x.c > G('50') ? x.c - G('50') : G('50') - x.c).toBeLessThanOrEqual(slack)
                expect(Math.abs(x.gain - mid.gain)).toBeLessThan(1e-6)
            }
        }, 300000)
    })

    describe('An old rate only costs the depositor', () => {
        it('with the stored pot at 0 and the stored rate below Hipo’s, a deposit books deposit_value at the stored rate and the difference stays in free_tokens', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
            const { env, players } = sc
            await put(env, players[0], G('100'))
            await env.hipo.raiseRate(G('40')) // no poke: the stored rate is the old one
            const before = await jackpotState(env)
            const freeBefore = before.heldTokens - before.incomingTokens - before.reservedTokens
            const tokens = G('50')
            const dep = await depositHgram(env, players[1], tokens, { minC: 0n })
            const after = await jackpotState(env)
            expect(dep.booking!.principal).toBe((tokens * before.quoteCoins) / before.quoteTokens)
            const [tc, tt] = await env.hipo.quote()
            expect(dep.booking!.principal).toBeLessThan((tokens * tc) / tt)
            const freeAfter = after.heldTokens - after.incomingTokens - after.reservedTokens
            expect(freeAfter - freeBefore).toBe(tokens)
        }, 200000)
    })

    describe('A fall not yet seen', () => {
        it('a withdrawal pays at most its pro-rata share; the next poke raises the falling flag; after it bookings are refused with rate_falling and withdrawals pay pro rata', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 3, mint: G('1000'), fake: true })
            const { env, players } = sc
            await put(env, players[0], G('100'))
            await put(env, players[1], G('100'))
            await pokeFake(sc, G('110'), G('100')) // the stored rate rises to 1.1
            const s = await jackpotState(env)
            const free = s.heldTokens - s.incomingTokens - s.reservedTokens
            // Hipo's true rate has fallen (set by hand in the stand-in), nobody has poked: the leaver gets at most its share
            const h0 = await hgramOf(env, players[0].address)
            await withdraw(env, players[0], 0n)
            const paid = (await hgramOf(env, players[0].address)) - h0
            expect(paid).toBeLessThanOrEqual((free * G('100')) / s.principal)
            expect((await jackpotState(env)).falling).toBe(false)
            // the next poke, at the lower rate, raises the flag
            await pokeFake(sc, G('100'), G('100'))
            expect((await jackpotState(env)).falling).toBe(true)
            const refused = await depositHgram(env, players[2], G('30'), {
                options: { minPrincipal: 0n, forwardTonAmount: G('0.02') },
                forward: env.fees.deposit + G('0.02'),
            })
            expect(refused.booking).toBeUndefined()
            const after = await jackpotState(env)
            const freeAfter = after.heldTokens - after.incomingTokens - after.reservedTokens
            const h1 = await hgramOf(env, players[1].address)
            await withdraw(env, players[1], 0n)
            const proRata = (freeAfter * G('100')) / after.principal
            const atRate = (G('100') * after.quoteTokens) / after.quoteCoins
            expect((await hgramOf(env, players[1].address)) - h1).toBe(proRata < atRate ? proRata : atRate)
        }, 300000)
    })

    describe('Refill at a stale rate', () => {
        it('after a fall set by hand, refill unstakes at most float_high worth of hGRAM at the stored rate', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000'), fake: true, float: G('3.5') })
            const { env, players } = sc
            await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
            await put(env, players[0], G('200'))
            await pokeFake(sc, G('150'), G('100')) // the stored rate is high; Hipo's true rate is not
            const s = await jackpotState(env)
            const r = await env.jackpot.sendRefill(players[1].getSender(), { value: env.fees.refill })
            const logs = logsOf<UnstakeLog>(r.externals, LogTopic.unstake)
            expect(logs).toHaveLength(1)
            expect(logs[0].amount).toBeGreaterThan(0n)
            expect((logs[0].amount * s.quoteCoins) / s.quoteTokens).toBeLessThanOrEqual(floatHigh)
        }, 200000)
    })

    describe('Zero withdrawal', () => {
        it('burn(0) at balance 0 throws in the wallet', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000') })
            const { env, players } = sc
            // the wallet exists with balance 0 and a deposit in flight
            await startDeposit(env, players[0], G('100'), jackpotWalletTx(env, players[0]))
            expect((await walletAt(env, players[0].address).getWalletState()).balance).toBe(0n)
            const r = await withdraw(env, players[0], 0n)
            expect(r.transactions).toHaveTransaction({
                to: walletAt(env, players[0].address).address,
                success: false,
                exitCode: JackpotError.invalidParameters,
            })
        }, 60000)
    })

    describe('Post-seed withdrawal', () => {
        it('a player withdraws after the seed is public and before the search: a slot whose winner ticket was withdrawn misses and moves on; the other slots keep their winners', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 3, mint: G('1000') })
            const { env, players } = sc
            await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
            for (const p of players) await put(env, p, G('100'))
            await toBoundary(env, G('30'))
            const snap = env.blockchain.snapshot()
            const base = await submitDraw(env)
            const winners = slotsIn(base).filter((x) => x.result === SlotResult.hit)
            expect(winners.length).toBe(3)
            const target = players.find((p) => p.address.toString() === winners[0].owner!.toString())!
            await env.blockchain.loadFrom(snap)
            const held = await holdUntil(env, await submitMessage(env), atJackpot(env, JackpotOp.submitRandomness))
            await withdraw(env, target, 0n)
            const after: SlotLog[] = []
            for (const m of held) after.push(...slotsIn(await deliver(env, m)))
            const first = after.filter((x) => x.slot === winners[0].slot)
            expect(first[0].position).toBe(winners[0].position)
            expect(first[0].result).toBe(SlotResult.miss)
            expect(first.length).toBeGreaterThan(1)
            for (const w of winners) {
                if (w.owner!.toString() === target.address.toString()) continue
                const same = after.find((x) => x.slot === w.slot && x.attempt === w.attempt)
                expect(same?.result).toBe(SlotResult.hit)
                expect(same?.owner?.toString()).toBe(w.owner!.toString())
            }
        }, 300000)
    })

    describe('Outage', () => {
        it('drand silent across two boundaries, with deposits and withdrawals: all pay; on return the waiting draw pays its reserved pot, the next boundary pays the rest to a snapshot that holds the new deposits, and a round from before the latest boundary is refused', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 4, mint: G('2000') })
            const { env, players } = sc
            const [alice, bob, carol] = players
            await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
            await put(env, alice, G('300'))
            await put(env, bob, G('300'))
            const b1 = await toBoundary(env, G('40'))
            const [log1] = logsOf<BoundaryLog>(b1.externals, LogTopic.boundary)
            const d1 = await env.jackpot.getDrawState()
            const reservedAfterFirst = (await jackpotState(env)).reservedTokens
            // drand is silent: deposits and withdrawals meanwhile all pay
            expectChainSucceeded(await withdraw(env, alice, G('100')))
            const dep = await put(env, carol, G('100'))
            expect(dep.booking).toBeDefined()
            // a second boundary while the draw waits: a skip
            const b2 = await toBoundary(env, G('40'))
            expect(logsOf(b2.externals, LogTopic.skip)).toHaveLength(1)
            const d2 = await env.jackpot.getDrawState()
            expect(d2.tag).toBe(d1.tag)
            expect(d2.prizes).toEqual(d1.prizes)
            expect((await jackpotState(env)).reservedTokens).toBe(reservedAfterFirst)
            expect(d2.round).toBeGreaterThan(d1.round)
            // a round from before the latest boundary is refused
            const stale = await submitTest(env, Number(d1.round))
            expect(stale.transactions).toHaveTransaction({ to: env.jackpot.address, success: false })
            // the draw pays its reserved pot
            const paid = await submitDraw(env)
            expectChainSucceeded(paid)
            const hits = slotsIn(paid).filter((x) => x.result === SlotResult.hit)
            expect(hits).toHaveLength(3)
            expect(hits.reduce((a, x) => a + x.amount, 0n)).toBe(log1.prizes![0] + log1.prizes![1] + log1.prizes![2])
            expect((await jackpotState(env)).carried).toBe(0n)
            // the next boundary pays the rest to a snapshot that holds the new deposit
            const b3 = await toBoundary(env, G('40'))
            const [log3] = logsOf<BoundaryLog>(b3.externals, LogTopic.boundary)
            expect(log3.snapshotTickets).toBe((await jackpotState(env)).tickets)
            expect(log3.pot).toBeGreaterThan(0n)
            expect(await jgramOf(env, carol.address)).toBeGreaterThan(0n)
            expectChainSucceeded(await submitDraw(env, 1))
            await expectSolvent(env)
        }, 600000)
    })

    describe('Boundary mid-search', () => {
        it('a hit delivered after the boundary pays nothing and its prize is in carried; two draws are never open', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 3, mint: G('1000') })
            const { env, players } = sc
            await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
            for (const p of players) await put(env, p, G('100'))
            await toBoundary(env, G('30'))
            const d = await env.jackpot.getDrawState()
            // hold the first search at the leaf node: its answer is a hit on its way to the Jackpot
            const leaf = nodeAt(env, 1, 0n).address
            const held = await holdUntil(env, await submitMessage(env), toAddr(leaf))
            const hit = held.find((m) => m.info.dest?.toString() === env.jackpot.address.toString())
            expect(hit).toBeDefined()
            expect((await env.jackpot.getDrawState()).state).toBe(DrawState.resolving)
            // the next boundary ends the draw with the slots open
            const next = await toBoundary(env, G('30'))
            expectChainSucceeded(next)
            expect(slotsIn(next).filter((x) => x.result === SlotResult.expired)).toHaveLength(3)
            // the three prizes went back into free_tokens as carried, and the new pot did not burn them again
            const [nextLog] = logsOf<BoundaryLog>(next.externals, LogTopic.boundary)
            expect(nextLog.carried).toBe(d.prizes[0] + d.prizes[1] + d.prizes[2])
            const carried = (await jackpotState(env)).carried
            // the late hit pays nothing
            const reserved = (await jackpotState(env)).reservedTokens
            const heldBefore = (await jackpotState(env)).heldTokens
            const late = await deliver(env, hit!)
            expect(late.transactions.some((t) => opOf(t) === JackpotOp.sendTokens)).toBe(false)
            const after = await jackpotState(env)
            expect([after.reservedTokens, after.heldTokens, after.carried]).toEqual([reserved, heldBefore, carried])
            // the newer draw (the boundary's) is waiting, and it is the only one
            expect((await env.jackpot.getDrawState()).state).toBe(DrawState.waiting)
        }, 300000)
    })

    describe('Mint ignored', () => {
        it('a mint to the Jackpot leaves held_tokens, incoming_tokens and principal unchanged, and return_tokens can return it', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
            const { env, players } = sc
            await put(env, players[0], G('100'))
            const before = await jackpotState(env)
            const hipoFees = await env.hipo.treasury.getTreasuryFees(0n)
            await env.hipo.treasury.sendDepositCoins(players[1].getSender(), {
                value: G('50') + hipoFees.depositCoinsFee,
                owner: env.jackpot.address,
            })
            const after = await jackpotState(env)
            expect(after.heldTokens).toBe(before.heldTokens)
            expect(after.incomingTokens).toBe(before.incomingTokens)
            expect(after.principal).toBe(before.principal)
            const minted = (await hgramOf(env, env.jackpot.address)) - before.heldTokens
            expect(minted).toBeGreaterThan(0n)
            const h = await hgramOf(env, players[1].address)
            const r = await env.jackpot.sendReturnTokens(env.governor.getSender(), {
                value: G('0.3'),
                owner: players[1].address,
                amount: minted,
            })
            expectChainSucceeded(r)
            expect(await hgramOf(env, players[1].address)).toBe(h + minted)
        }, 120000)
    })

    describe('Wallet one-per-player', () => {
        it('two deposits merge into one balance and one position; one withdrawal covers all; total supply equals the sum of balances', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
            const { env, players } = sc
            const a = await put(env, players[0], G('100'))
            const b = await put(env, players[0], G('50'))
            expect(b.booking!.b).toBe(a.booking!.b)
            await put(env, players[1], G('70'))
            const s = await jackpotState(env)
            expect(await jgramOf(env, players[0].address)).toBe(a.booking!.principal + b.booking!.principal)
            expect(s.tickets).toBe((await jgramOf(env, players[0].address)) + (await jgramOf(env, players[1].address)))
            expectChainSucceeded(await withdraw(env, players[0], 0n))
            expect(await jgramOf(env, players[0].address)).toBe(0n)
            expect((await jackpotState(env)).tickets).toBe(await jgramOf(env, players[1].address))
        }, 200000)
    })

    describe('Griefing bound', () => {
        it('the Jackpot’s balance falls by at most fee::draw_budget over a boundary and its draw', async () => {
            const sc = await fresh({ minDeposit: 1n, players: 3, mint: G('1000'), float: G('40') })
            const { env, players } = sc
            await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
            for (const p of players) await put(env, p, G('100'))
            const g0 = await balanceOf(env, env.jackpot.address)
            await toBoundary(env, G('30'))
            expectChainSucceeded(await submitDraw(env))
            const g1 = await balanceOf(env, env.jackpot.address)
            expect(g0 - g1).toBeLessThanOrEqual(env.fees.drawBudget)
        }, 300000)
    })
})
