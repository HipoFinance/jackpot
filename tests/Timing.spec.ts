/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests read state they just made */
// The Timing criterion of amendment 1: the rows of its table about Hipo's reward, with the reward landing before or
// after the poke. A player's expected prize is computed from the chain's own numbers over all tickets of the snapshot
// (E = prizes · TC/TT · tickets / snapshot, read from the boundary's log), and compared with what the table says.
// Leaving after the reward and before the poke equals leaving just before it, in exact fractions.
import '@ton/test-utils'
import { toNano } from '@ton/core'
import { BoundaryLog, LogTopic, logsOf } from '../wrappers/Jackpot'
import { Env, depositHgram, expectChainSucceeded, hgramOf, jgramOf, poke, withdraw } from './jackpot/setup'
import { A0, Scene, fresh, potNow, put, setNow, toBoundary } from './jackpot/scenario'

const G = (n: string | number) => toNano(String(n))
const BETA = 1000n
const SCALE = 10n ** 18n

async function ratio(env: Env) {
    const [tc, tt] = await env.hipo.quote()
    return (tc * SCALE) / tt
}

// x is the player who moves. The old pot is yield that landed before: the rate is stored by a poke that is not a
// boundary (min_gap has not passed), so the pot is in the stored rate.
async function scene(inX: boolean, oldPot: boolean) {
    const sc = await fresh({ minDeposit: 1n, players: 3, mint: G('1000') })
    const { env, players } = sc
    await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
    const x = players[2]
    if (inX) await put(env, x, G('200')) // principal 200, at rate 1
    await put(env, players[0], G('300'))
    await put(env, players[1], G('100'))
    if (oldPot) {
        await env.hipo.raiseRate(G('30'))
        await poke(env)
    }
    setNow(env, A0 + 3599)
    return { sc, env, x }
}

// The boundary after the move (the reward is in), and the expected prize, in GRAM at the new rate, of `tickets`.
async function expectedPrize(sc: Scene, tickets: bigint) {
    const { env } = sc
    const r = await toBoundary(env, 0n)
    expectChainSucceeded(r)
    const log = logsOf<BoundaryLog>(r.externals, LogTopic.boundary)[0]
    const rest = log.prizes![0] + log.prizes![1] + log.prizes![2]
    const [tc, tt] = await env.hipo.quote()
    return {
        e: (rest * tc * tickets) / (tt * log.snapshotTickets),
        snapshot: log.snapshotTickets,
        pot: log.pot,
        tc,
        tt,
    }
}

const near = (a: bigint, b: bigint, tol: bigint) => (a > b ? a - b : b - a) <= tol

describe('Timing', () => {
    for (const when of ['before the reward', 'after the reward, before the poke'] as const) {
        it(`Deposit ${when}: not better than holding the hGRAM, and worse by at most the burn on its gain`, async () => {
            const { sc, env, x } = await scene(false, true)
            const tokens = G('200')
            const before = await ratio(env)
            if (when === 'before the reward') {
                expectChainSucceeded((await depositHgram(env, x, tokens, { minC: 0n })).result)
                await env.hipo.raiseRate(G('40'))
            } else {
                await env.hipo.raiseRate(G('40'))
                expectChainSucceeded((await depositHgram(env, x, tokens, { minC: 0n })).result)
            }
            const c = await jgramOf(env, x.address)
            const after = await ratio(env)
            expect(c).toBeGreaterThan(0n)
            const { e } = await expectedPrize(sc, c)
            const worth = c + e
            const hold = (tokens * after) / SCALE
            const v0 = (tokens * before) / SCALE
            // the deposit pays the price of the pot, whose prize returns it; the reward's r·v comes on top, less β
            expect(worth).toBeLessThanOrEqual(hold + 10_000n)
            if (when === 'before the reward') {
                const gain = hold - v0
                expect(hold - worth).toBeLessThanOrEqual(((BETA * (gain + (v0 - c))) / 10000n) * 2n + 10_000n)
            } else {
                // paying for the true pot, the reward included: its expected prize does not beat its price
                const price = hold - c
                expect(e).toBeLessThanOrEqual(price + 10_000n)
            }
        }, 300000)
    }

    it('Stay in over the reward: (1-β)·r·x plus the share of the pot before it', async () => {
        const { sc, env, x } = await scene(true, true)
        const x0 = await jgramOf(env, x.address)
        const oldPotHgram = (await potNow(env)).pot
        const [tc0, tt0] = await env.hipo.quote()
        const oldPotValue = (oldPotHgram * tc0) / tt0
        const before = await ratio(env)
        // a staying player sends no message: only the reward lands
        await env.hipo.raiseRate(G('40'))
        const after = await ratio(env)
        const r = ((after - before) * SCALE) / before
        const { e, snapshot } = await expectedPrize(sc, x0)
        const table = ((10000n - BETA) * ((r * x0) / SCALE + (oldPotValue * x0) / snapshot)) / 10000n
        const tol = (r * x0 * oldPotValue) / (SCALE * snapshot) + e / 200n + 10_000n
        expect(near(e, table, tol)).toBe(true)
    }, 300000)

    it('Leave just before the reward: r·x for certain, and the share of the pot is given up', async () => {
        const { env, x } = await scene(true, true)
        const x0 = await jgramOf(env, x.address)
        const before = await ratio(env)
        const held0 = await hgramOf(env, x.address)
        await withdraw(env, x, 0n)
        await env.hipo.raiseRate(G('40'))
        const after = await ratio(env)
        const out = (await hgramOf(env, x.address)) - held0
        expect(await jgramOf(env, x.address)).toBe(0n)
        const r = ((after - before) * SCALE) / before
        const certain = x0 + (r * x0) / SCALE
        expect(near((out * after) / SCALE, certain, x0 / 1000n + 1000n)).toBe(true)
    }, 300000)

    it('Leave after the reward, before the poke: paid at the old rate, equal to leaving just before the reward, in exact fractions', async () => {
        const early = await scene(true, true)
        const late = await scene(true, true)
        const outOf = async (s: Awaited<ReturnType<typeof scene>>, rewardFirst: boolean) => {
            const held0 = await hgramOf(s.env, s.x.address)
            if (rewardFirst) {
                await s.env.hipo.raiseRate(G('40'))
                await withdraw(s.env, s.x, 0n)
            } else {
                await withdraw(s.env, s.x, 0n)
                await s.env.hipo.raiseRate(G('40'))
            }
            return (await hgramOf(s.env, s.x.address)) - held0
        }
        const before = await outOf(early, false)
        const after = await outOf(late, true)
        expect(after).toBe(before)
        // and nobody else loses: the others' principal is still covered at the stored rate
        const s = await late.env.jackpot.getJackpotState()
        expect(s.tickets).toBe(s.principal)
    }, 400000)

    it('Leave after the boundary: x at the new rate, giving up the chance in the draw just fixed; worse than leaving before', async () => {
        const left = await scene(true, true)
        const stay = await scene(true, true)
        const x0 = await jgramOf(left.env, left.x.address)
        // leaving before the reward
        const h0 = await hgramOf(left.env, left.x.address)
        await withdraw(left.env, left.x, 0n)
        await left.env.hipo.raiseRate(G('40'))
        const beforeOut = (await hgramOf(left.env, left.x.address)) - h0
        const afterRate = await ratio(left.env)
        // leaving after the boundary
        await stay.env.hipo.raiseRate(G('40'))
        const h1 = await hgramOf(stay.env, stay.x.address)
        await toBoundary(stay.env, 0n)
        await withdraw(stay.env, stay.x, 0n)
        const afterOut = (await hgramOf(stay.env, stay.x.address)) - h1
        const rate = await ratio(stay.env)
        expect(rate).toBe(afterRate)
        // x at the new rate, and fewer hGRAM than leaving before the reward
        expect(near((afterOut * rate) / SCALE, x0, x0 / 1000n + 1000n)).toBe(true)
        expect(afterOut).toBeLessThan(beforeOut)
    }, 400000)
})
