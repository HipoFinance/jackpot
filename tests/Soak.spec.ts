 
// The long runs of the Acceptance criteria: Hands-free, Refill (P = 5,000 GRAM) and Float (a real pot and
// Hipo's real unstake). The sizes default to the spec's (50, 100, 50 rounds); a short sample is run with the
// *_ROUNDS environment variables:
//   HANDS_FREE_ROUNDS (50), REFILL_ROUNDS (100), FLOAT_ROUNDS (50)
import '@ton/test-utils'
import { toNano } from '@ton/core'
import { BlockchainTransaction } from '@ton/sandbox'
import { BoundaryLog, DrawState, JackpotError, JackpotOp, LogTopic, SlotResult, UnstakeLog, logsOf } from '../wrappers/Jackpot'
import { balanceOf, expectChainSucceeded, expectSolvent, jackpotState, opOf, poke, slotsIn } from './jackpot/setup'
import { A0, Scene, fresh, put, setNow, submitDraw, pokeFake } from './jackpot/scenario'

const G = (n: string | number) => toNano(String(n))
const roundsOf = (name: string, spec: number) => Number(process.env[name] ?? String(spec))

// P = 5,000 GRAM, a small yield each round, a Jackpot whose float starts low so that Hipo's unstake is used.
async function bigScene(float: bigint) {
    const sc = await fresh({ minDeposit: 1n, players: 3, mint: G('3000'), float })
    await sc.env.jackpot.sendSetMinPot(sc.env.governor.getSender(), { value: G('0.05'), minPot: 1n })
    await put(sc.env, sc.players[0], G('2500'))
    await put(sc.env, sc.players[1], G('2500'))
    return sc
}

// One round: the reward lands (a gift of 0.05% of the pool), the keeper pokes, the keeper submits. Nothing else is
// sent by anyone. Returns the poke's and the submit's chains.
async function round(sc: Scene, n: number) {
    const { env } = sc
    const [coins] = await env.hipo.quote()
    const gift = await env.hipo.treasury.sendGiftCoins(env.hipo.governor.getSender(), {
        value: coins / 2000n + G('1'),
        coins: coins / 2000n,
    })
    expect(gift.transactions.filter((t) => t.parent == null)).toHaveLength(1)
    expect(gift.transactions.some((t) => t.inMessage?.info.dest?.toString() === env.jackpot.address.toString())).toBe(false)
    setNow(env, A0 + (n + 1) * (sc.minGap + 100))
    const boundary = await poke(env)
    const draw = await submitDraw(env, n)
    return { boundary, draw }
}

const keeperRoot = (env: Scene['env'], r: { transactions: BlockchainTransaction[] }) => {
    // only the keeper enters from outside: one root transaction, the keeper's wallet taking an external message
    const roots = r.transactions.filter((t) => t.parent == null)
    expect(roots).toHaveLength(1)
    expect(roots[0].inMessage?.info.type).toBe('external-in')
    expect(roots[0].inMessage?.info.dest?.toString()).toBe(env.keeper.address.toString())
    const senders = new Set(r.transactions.map((t) => t.inMessage?.info.src?.toString()).filter((x) => x != null))
    expect(senders.has(env.governor.address.toString())).toBe(false)
    return roots[0]
}

describe('Soak', () => {
    it('Hands-free: N rounds run with poke and submit_randomness as the only messages besides the treasury replies and reward steps: one boundary and 3 prizes each', async () => {
        const n = roundsOf('HANDS_FREE_ROUNDS', 50)
        const sc = await bigScene(G('40'))
        const { env } = sc
        for (let i = 0; i < n; i++) {
            const { boundary, draw } = await round(sc, i)
            expectChainSucceeded(boundary)
            expectChainSucceeded(draw)
            keeperRoot(env, boundary)
            const root = keeperRoot(env, draw)
            const first = draw.transactions.filter((t) => t.parent === root)
            expect(first).toHaveLength(1)
            expect(first[0].inMessage?.info.dest?.toString()).toBe(env.jackpot.address.toString())
            expect(opOf(first[0])).toBe(JackpotOp.submitRandomness)
            expect(logsOf<BoundaryLog>(boundary.externals, LogTopic.boundary)).toHaveLength(1)
            expect(slotsIn(draw).filter((x) => x.result === SlotResult.hit)).toHaveLength(3)
            expect((await env.jackpot.getDrawState()).state).toBe(DrawState.none)
        }
        await expectSolvent(env)
    }, 3_600_000)

    it('Refill: over the rounds at P = 5,000 GRAM, the float stays above fee::draw_budget', async () => {
        const n = roundsOf('REFILL_ROUNDS', 100)
        const sc = await bigScene(G('7.5'))
        const { env } = sc
        let min = await balanceOf(env, env.jackpot.address)
        let unstakes = 0
        for (let i = 0; i < n; i++) {
            const { boundary, draw } = await round(sc, i)
            unstakes += logsOf<UnstakeLog>([...boundary.externals, ...draw.externals], LogTopic.unstake).length
            const g = await balanceOf(env, env.jackpot.address)
            if (g < min) min = g
            expect(g).toBeGreaterThan(env.fees.drawBudget)
        }
        console.log(`refill: ${n.toString()} rounds, lowest float ${(Number(min) / 1e9).toFixed(3)} GRAM, ${unstakes.toString()} unstakes`)
        await expectSolvent(env)
    }, 3_600_000)

    it('Float: over the rounds with a real pot and Hipo’s real unstake, the float stays above fee::draw_budget and the unstaking counter returns to 0', async () => {
        const n = roundsOf('FLOAT_ROUNDS', 50)
        const sc = await bigScene(G('7.5'))
        const { env } = sc
        for (let i = 0; i < n; i++) {
            await round(sc, i)
            expect(await balanceOf(env, env.jackpot.address)).toBeGreaterThan(env.fees.drawBudget)
            expect((await jackpotState(env)).unstakingTokens).toBe(0n)
        }
    }, 3_600_000)
})

describe('Refill with a stand-in treasury', () => {
    it('refill throws at float >= fee::draw_budget, and unstakes nothing while the flag is up', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000'), fake: true, float: G('3.5') })
        const { env, players } = sc
        await put(env, players[0], G('100'))
        // the float is below the budget: refill is accepted and uses the stored rate; a poke at a lower rate raises the flag
        await pokeFake(sc, G('110'), G('100'))
        await pokeFake(sc, G('100'), G('100'))
        expect((await jackpotState(env)).falling).toBe(true)
        const r = await env.jackpot.sendRefill(players[1].getSender(), { value: env.fees.refill })
        expectChainSucceeded(r)
        expect(logsOf<UnstakeLog>(r.externals, LogTopic.unstake)).toHaveLength(0)
        expect((await jackpotState(env)).unstakingTokens).toBe(0n)
        // at a float that covers a draw, refill is refused
        await env.jackpot.sendTopUp(players[1].getSender(), G('10'))
        const again = await env.jackpot.sendRefill(players[1].getSender(), { value: env.fees.refill })
        expect(again.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.refillNotNeeded,
        })
    }, 200000)
})
