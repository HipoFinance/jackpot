// More rules the audits found untested: burns with the float at 0, a whale outside the snapshot, a boundary's gas
// across gaps, held changes in every order, the griefing bound with three payouts, a lost during a live draw, and
// positions from b = 64 up with hits. The stale-ready and requote rules of v2 are gone with the records; their
// races are in tests/Races.spec.ts.
import '@ton/test-utils'
import { beginCell, toNano } from '@ton/core'
import { DrawState, JackpotOp, SlotResult } from '../wrappers/Jackpot'
import {
    balanceOf,
    expectChainSucceeded,
    expectSolvent,
    gasOf,
    hgramOf,
    jackpotState,
    jgramOf,
    messageFrom,
    mintHgram,
    nodeAt,
    poke,
    reward,
    slotsIn,
    walletAt,
    withdraw,
    depositHgram,
} from './jackpot/setup'
import {
    A0,
    atJackpot,
    deliver,
    fresh,
    holdUntil,
    put,
    setBalance,
    setNextPosition,
    setNow,
    submitDraw,
    submitMessage,
    toBoundary,
} from './jackpot/scenario'

const G = (n: string | number) => toNano(String(n))

async function waiting(players = 4) {
    const sc = await fresh({ minDeposit: 1n, players, mint: G('1000') })
    await sc.env.jackpot.sendSetMinPot(sc.env.governor.getSender(), { value: G('0.05'), minPot: 1n })
    await put(sc.env, sc.players[0], G('300'))
    await put(sc.env, sc.players[1], G('100'))
    await toBoundary(sc.env, G('400'))
    return sc
}

describe('Burns with the float at 0', () => {
    it('a burn pays in every draw state with the Jackpot holding almost no GRAM', async () => {
        const sc = await waiting()
        const { env, players } = sc
        const paid = async (i: number, x: bigint) => {
            await setBalance(env, env.jackpot.address, G('0.02'))
            const h = await hgramOf(env, players[i].address)
            expectChainSucceeded(await withdraw(env, players[i], x))
            expect(await hgramOf(env, players[i].address)).toBeGreaterThan(h)
        }
        await paid(0, G('10')) // waiting
        // resolving: the submit is held with its searches on the way
        await setBalance(env, env.jackpot.address, G('40'))
        const outs = await holdUntil(env, await submitMessage(env), atJackpot(env, JackpotOp.submitRandomness))
        expect((await env.jackpot.getDrawState()).state).toBe(DrawState.resolving)
        await paid(1, G('10')) // resolving
        await setBalance(env, env.jackpot.address, G('40'))
        for (const m of outs) await deliver(env, m)
        await paid(0, G('10')) // none
    }, 300000)
})

describe('A whale outside the snapshot', () => {
    it('one that books and leaves after the boundary changes nothing in the draw', async () => {
        const sc = await waiting()
        const { env, players } = sc
        const snap = env.blockchain.snapshot()
        const control = slotsIn(await submitDraw(env)).map((x) => [
            x.slot,
            x.attempt,
            x.result,
            x.position,
            x.owner?.toString(),
        ])
        await env.blockchain.loadFrom(snap)
        await put(env, players[2], G('900')) // books during the draw, and
        expectChainSucceeded(await withdraw(env, players[2], 0n)) // leaves
        const r = slotsIn(await submitDraw(env)).map((x) => [
            x.slot,
            x.attempt,
            x.result,
            x.position,
            x.owner?.toString(),
        ])
        expect(r).toEqual(control)
    }, 300000)
})

describe('A whale that books and leaves before the boundary', () => {
    it('changes nothing in the draw', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 4, mint: G('1000') })
        const { env, players } = sc
        await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
        await put(env, players[0], G('300'))
        await put(env, players[1], G('100'))
        const before = env.blockchain.snapshot()
        const run = async () => {
            await toBoundary(env, G('400'))
            return slotsIn(await submitDraw(env)).map((x) => [
                x.slot,
                x.attempt,
                x.result,
                x.position,
                x.owner?.toString(),
            ])
        }
        const control = await run()
        await env.blockchain.loadFrom(before)
        await put(env, players[2], G('900'))
        expectChainSucceeded(await withdraw(env, players[2], 0n))
        expect(await run()).toEqual(control)
    }, 300000)
})

describe('A boundary', () => {
    it('costs the same gas after one gap as after a hundred without a message', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const { env, players } = sc
        await put(env, players[0], G('100'))
        await reward(env, G('400'))
        const snap = env.blockchain.snapshot()
        const gasAt = async (t: number) => {
            await env.blockchain.loadFrom(snap)
            setNow(env, t)
            const r = await poke(env)
            return gasOf(r, env.jackpot.address)[1].gas
        }
        const one = await gasAt(A0 + 3600)
        const hundred = await gasAt(A0 + 100 * 3600 + 100)
        expect(hundred).toBe(one)
    }, 200000)
})

describe('Held changes in every order', () => {
    it('deposits and burns on one b in one period, in every order: committed does not change until the next tag, then equals the truth', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('2000') })
        const { env, players } = sc
        await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
        const a = players[0]
        await put(env, a, G('200'))
        await toBoundary(env, G('400'))
        await put(env, players[1], G('1')) // the first message of the tag: the node folds
        const snap = env.blockchain.snapshot()
        const leaf = () => nodeAt(env, 1, 0n).getNodeData()
        const orders = ['dw', 'wd', 'ddw', 'wwd', 'dwdw', 'wdwd', 'dwwd', 'wddw']
        for (const order of orders) {
            await env.blockchain.loadFrom(snap)
            const committed = (await leaf()).committed[0]
            expect(committed).toBe(G('200'))
            for (const c of order) {
                if (c === 'd') await put(env, a, G('20'))
                else await withdraw(env, a, G('15'))
                expect((await leaf()).committed[0]).toBe(committed)
            }
            const truth = (await walletAt(env, a.address).getWalletState()).balance
            const l = await leaf()
            expect(l.committed[0] + l.added[0] - l.removed[0]).toBe(truth)
            // the draw ends, a negative after it is not lost, and the next tag folds everything
            expectChainSucceeded(await submitDraw(env))
            await withdraw(env, a, G('5'))
            await toBoundary(env, G('400'))
            await put(env, players[1], G('1'))
            const f = await leaf()
            const now = (await walletAt(env, a.address).getWalletState()).balance
            expect(f.committed[0]).toBe(now)
            expect(f.removed[0] + f.added[0]).toBeLessThanOrEqual(G('2'))
        }
    }, 600000)
})

describe('The griefing bound', () => {
    it('with the whale gone and the seed varied, the worst draw (3 payouts and the most misses) stays within fee::draw_budget', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 3, mint: G('1000'), burnBatch: 1n })
        const { env, players } = sc
        const [whale, honest] = players
        await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
        await mintHgram(env, honest, G('20000'))
        await put(env, honest, G('15000'))
        await mintHgram(env, whale, G('100000'))
        await put(env, whale, G('50000'))
        await toBoundary(env, G('3000'))
        await withdraw(env, whale, 0n)
        const snap = env.blockchain.snapshot()
        let worst = { n: 0, spent: 0n, hits: 0 }
        const seeds = Number(process.env.GRIEF_SEEDS ?? '20')
        for (let i = 0; i < seeds; i++) {
            await env.blockchain.loadFrom(snap)
            const before = await balanceOf(env, env.jackpot.address)
            const logs = slotsIn(await submitDraw(env, i))
            const spent = before - (await balanceOf(env, env.jackpot.address))
            const hits = logs.filter((x) => x.result === SlotResult.hit).length
            expect(spent).toBeLessThanOrEqual(env.fees.drawBudget)
            if (hits === 3 && logs.length > worst.n) worst = { n: logs.length, spent, hits }
        }
        // a draw with three payouts and many searches was among them
        expect(worst.hits).toBe(3)
        expect(worst.n).toBeGreaterThan(8)
    }, 600000)
})

describe('A lost during a live draw', () => {
    it('from a node, it moves the slot to the next attempt; from a stranger, it does nothing; its gas fits', async () => {
        const sc = await waiting()
        const { env, players } = sc
        await holdUntil(env, await submitMessage(env), atJackpot(env, JackpotOp.submitRandomness))
        const d = await env.jackpot.getDrawState()
        const k = await env.jackpot.getPosition(0)
        const body = beginCell()
            .storeUint(JackpotOp.lost, 32)
            .storeUint(0, 64)
            .storeUint(d.tag, 32)
            .storeUint(0, 8)
            .storeUint(0, 8)
            .storeUint(k, 128)
            .storeUint(1, 8)
            .storeUint(0, 32)
            .endCell()
        await deliver(env, messageFrom(players[3].address, env.jackpot.address, G('0.5'), body, false))
        expect((await env.jackpot.getDrawState()).attempts[0]).toBe(0)
        const r = await deliver(
            env,
            messageFrom(nodeAt(env, 1, 0n).address, env.jackpot.address, G('0.5'), body, false),
        )
        expect((await env.jackpot.getDrawState()).attempts[0]).toBe(1)
        expect(gasOf(r, env.jackpot.address)[0].gas * 400n).toBeLessThanOrEqual(20_000_000n)
    }, 300000)
})

describe('Far positions', () => {
    it('b = 64, 4096 and 262144 open their nodes at the minimum, win, and burn', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 4, mint: G('1000') })
        const { env, players } = sc
        await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
        expectChainSucceeded((await put(env, players[0], G('100'))).result)
        const targets = [64n, 4096n, 262144n]
        const nodeOpen = env.fees.nodeStorage + G('0.02')
        for (let i = 0; i < 3; i++) {
            await setNextPosition(env, targets[i])
            const g0 = await balanceOf(env, env.jackpot.address)
            const r = await depositHgram(env, players[i + 1], G('100'), { minC: 0n })
            expectChainSucceeded(r.result)
            const w = await walletAt(env, players[i + 1].address).getWalletState()
            expect(w.position).toBe(targets[i])
            const share = nodeOpen / 64n + nodeOpen / 4096n + nodeOpen / 262144n + 3n
            // the opens of the levels this b is the first child of, paid from the float, and the share kept
            let opens = 0n
            for (const shift of [6n, 12n, 18n, 24n]) if ((targets[i] & ((1n << shift) - 1n)) === 0n) opens += nodeOpen
            expect(g0 - (await balanceOf(env, env.jackpot.address))).toBe(opens - share)
            expect((await nodeAt(env, 1, targets[i] >> 6n).getNodeData()).initialized).toBe(true)
        }
        const winners = new Set<bigint>()
        for (let d = 0; d < 8; d++) {
            await toBoundary(env, G('300'))
            const r = await submitDraw(env, d)
            expectChainSucceeded(r)
            for (const x of slotsIn(r)) if (x.result === SlotResult.hit && x.b >= 64n) winners.add(x.b)
            await expectSolvent(env)
        }
        expect(winners.size).toBeGreaterThanOrEqual(2) // hits reached positions in different far nodes
        for (let i = 1; i < 4; i++) {
            expectChainSucceeded(await withdraw(env, players[i], 0n))
            expect(await jgramOf(env, players[i].address)).toBe(0n)
        }
        await expectSolvent(env)
        expect((await jackpotState(env)).principal).toBe(await jgramOf(env, players[0].address))
    }, 600000)
})
