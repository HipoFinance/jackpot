// Amendment 1: boundaries driven by Hipo's rate, the pot and snapshot fixed before the seed, the seed's mix with the
// masterchain block hash, skips, the submit's cut-off, settings and rhythm. Acceptance criteria are named in the tests.
import { createHash } from 'crypto'
import { Blockchain } from '@ton/sandbox'
import { beginCell, toNano } from '@ton/core'
import {
    BoundaryLog,
    DrawState,
    Jackpot,
    JackpotError,
    LogTopic,
    RandomnessLog,
    SkipLog,
    SlotLog,
    drandDelay,
    logsOf,
    submitCutoff,
} from '../wrappers/Jackpot'
import { roundAt } from '../wrappers/drand'
import {
    codes,
    expectChainSucceeded,
    expectSolvent,
    mcSeqno,
    poke,
    reward,
    setMcBlocks,
    start,
    submitTest,
} from './jackpot/setup'
import { A0, fresh, put, setNow, toBoundary } from './jackpot/scenario'
import { mcHashOf, testSignature } from './jackpot/testbuild'

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

async function staked(sc: Awaited<ReturnType<typeof fresh>>, each = toNano('1000')) {
    for (const p of sc.players) await put(sc.env, p, each)
}

describe('Boundaries (amendment 1)', () => {
    it('First boundary: none before min_gap, one at the first reward after it; bad deploys are refused', async () => {
        const sc = await fresh({ minGap: 3600 })
        const { env } = sc
        await staked(sc)
        // a reward at once: the rate rose, but min_gap has not passed
        await reward(env, toNano('50'))
        setNow(env, A0 + 3599)
        await poke(env)
        expect((await env.jackpot.getDrawState()).state).toBe(DrawState.none)
        expect((await env.jackpot.getJackpotState()).tag).toBe(0n)
        // after min_gap the next reply is a boundary
        setNow(env, A0 + 3600)
        const r = await poke(env)
        expect(logsOf<BoundaryLog>(r.externals, LogTopic.boundary)).toHaveLength(1)
        expect((await env.jackpot.getDrawState()).state).toBe(DrawState.waiting)

        // deploy refusals: a zero rate, settings out of bounds
        const { jackpotCode, jettonWalletCode, nodeCode } = await codes()
        for (const bad of [{ quoteCoins: 0n }, { riseMin: 0 }, { riseMin: 10001 }, { minGap: 3599 }, { minGap: 2592001 }]) {
            const bc = await Blockchain.create()
            bc.now = start
            const gov = await bc.treasury('g')
            const j = bc.openContract(
                Jackpot.createFromConfig(
                    {
                        treasury: gov.address,
                        parent: gov.address,
                        walletCode: beginCell().endCell(),
                        jettonWalletCode,
                        nodeCode,
                        burner: gov.address,
                        governor: gov.address,
                        halter: gov.address,
                        quoteCoins: 100n,
                        quoteTokens: 100n,
                        lastBoundary: start,
                        ...bad,
                    },
                    jackpotCode,
                ),
            )
            const d = await j.sendDeploy(gov.getSender(), toNano('1'))
            expect(d.transactions).toHaveTransaction({ to: j.address, success: false, exitCode: JackpotError.invalidParameters })
        }
    }, 120000)

    it('The pot is fixed before the seed; exact snapshot', async () => {
        const sc = await fresh()
        const { env } = sc
        await staked(sc)
        const before = await env.jackpot.getJackpotState()
        const r = await toBoundary(env, toNano('40'))
        expectChainSucceeded(r)
        const [log] = logsOf<BoundaryLog>(r.externals, LogTopic.boundary)
        const [tc, tt] = await env.hipo.quote()
        expect([log.quoteCoins, log.quoteTokens]).toEqual([tc, tt])
        const after = await env.jackpot.getJackpotState()
        // reserved rises by exactly the pot less the unstake; the burn is part of it
        expect(after.reservedTokens - before.reservedTokens).toBe(log.pot - log.unstaked)
        expect(log.snapshotTickets).toBe(before.tickets)
        const now = env.blockchain.now ?? start
        expect(log.round).toBe(BigInt(roundAt(now + drandDelay)))
        const state = await env.jackpot.getDrawState()
        // a deposit after the boundary, a withdrawal and a poke change none of the reserved pot, the prizes, the snapshot
        await put(env, sc.players[0], toNano('100'))
        await env.jackpot.getJackpotState()
        const kept = await env.jackpot.getDrawState()
        expect(kept.snapshotTickets).toBe(state.snapshotTickets)
        expect(kept.prizes).toEqual(state.prizes)
        expect((await env.jackpot.getJackpotState()).reservedTokens).toBe(after.reservedTokens)
        await poke(env)
        expect((await env.jackpot.getDrawState()).prizes).toEqual(state.prizes)
        expect((await env.jackpot.getJackpotState()).reservedTokens).toBe(after.reservedTokens)
        // the deposit after the boundary cannot win it
        const d = await submitTest(env, Number(state.round))
        for (const s of logsOf<SlotLog>(d.externals, LogTopic.slot)) expect(s.position).toBeLessThan(state.snapshotTickets)
        await expectSolvent(env)
    })

    it('The seed mixes in mc_hash: the highest seqno, in any order; seed = sha256(signature || mc_hash)', async () => {
        const seeds: bigint[] = []
        for (const order of ['descending', 'shuffled', 'other-block']) {
            const sc = await fresh()
            const { env } = sc
            await staked(sc)
            const newest = order === 'other-block' ? mcSeqno + 77 : mcSeqno
            setMcBlocks(env.blockchain, newest)
            if (order !== 'descending') {
                const pb = env.blockchain.prevBlocks
                if (pb == null) throw new Error('no previous blocks')
                pb.lastMcBlocks = [...pb.lastMcBlocks].sort((a, b) => ((a.seqno * 7919) % 13) - ((b.seqno * 7919) % 13))
                env.blockchain.prevBlocks = pb
            }
            const r = await toBoundary(env, toNano('40'))
            const [log] = logsOf<BoundaryLog>(r.externals, LogTopic.boundary)
            expect(log.mcSeqno).toBe(BigInt(newest))
            expect(log.mcHash).toBe(mcHashOf(newest))
            const d = await env.jackpot.getDrawState()
            expect(d.mcHash).toBe(mcHashOf(newest))
            const sub = await submitTest(env, Number(d.round))
            const [rl] = logsOf<RandomnessLog>(sub.externals, LogTopic.randomness)
            const expected = sha(
                Buffer.concat([testSignature(Number(d.round)), Buffer.from(mcHashOf(newest).toString(16).padStart(64, '0'), 'hex')]),
            )
            expect(rl.seed).toBe(BigInt('0x' + expected))
            seeds.push(rl.seed)
        }
        // the same drand signature, a different block hash: another seed
        expect(seeds[0]).not.toBe(seeds[2])
        expect(seeds[0]).toBe(seeds[1])
    }, 120000)

    it('Skip: a boundary with a draw waiting keeps its snapshot, tag and pot, moves R, stores a fresh mc_hash', async () => {
        const sc = await fresh()
        const { env } = sc
        await staked(sc)
        await toBoundary(env, toNano('40'))
        const first = await env.jackpot.getDrawState()
        const s1 = await env.jackpot.getJackpotState()
        await put(env, sc.players[0], toNano('100')) // booked meanwhile
        setMcBlocks(env.blockchain, mcSeqno + 10)
        const r = await toBoundary(env, toNano('40'))
        const skips = logsOf<SkipLog>(r.externals, LogTopic.skip)
        expect(skips).toHaveLength(1)
        expect(skips[0].mcHash).toBe(mcHashOf(mcSeqno + 10))
        const second = await env.jackpot.getDrawState()
        const s2 = await env.jackpot.getJackpotState()
        expect(second.tag).toBe(first.tag)
        expect(second.snapshotTickets).toBe(first.snapshotTickets)
        expect(second.prizes).toEqual(first.prizes)
        expect(second.round).toBeGreaterThan(first.round)
        expect(second.mcHash).toBe(mcHashOf(mcSeqno + 10))
        expect(s2.reservedTokens).toBe(s1.reservedTokens)
        expect(s2.carried).toBe(s1.carried)
        // the draw pays its reserved pot, then the next boundary shares the pot to a snapshot that holds the new deposit
        const sub = await submitTest(env, Number(second.round))
        expectChainSucceeded(sub)
        // the three prizes left reserved_tokens; only the burn owed stays
        expect((await env.jackpot.getJackpotState()).reservedTokens).toBe(s2.burnOwed)
        const r3 = await toBoundary(env, toNano('40'))
        const [log] = logsOf<BoundaryLog>(r3.externals, LogTopic.boundary)
        expect(log.snapshotTickets).toBe((await env.jackpot.getJackpotState()).tickets)
        await expectSolvent(env)
    })

    it('Cut-off: a submit at last_boundary + min_gap - S throws with no change; a second earlier succeeds', async () => {
        for (const late of [true, false]) {
            const sc = await fresh({ minGap: 7200 })
            const { env } = sc
            await staked(sc)
            await toBoundary(env, toNano('40'))
            const d = await env.jackpot.getDrawState()
            const b = await env.jackpot.getBoundary()
            const before = await env.jackpot.getJackpotState()
            setNow(env, b.lastBoundary + b.minGap - submitCutoff - (late ? 0 : 1))
            const r = await submitTest(env, Number(d.round))
            if (late) {
                expect(r.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: JackpotError.tooLate })
                expect(await env.jackpot.getJackpotState()).toEqual(before)
                expect((await env.jackpot.getDrawState()).state).toBe(DrawState.waiting)
            } else {
                expectChainSucceeded(r)
            }
        }
    })

    it('Submit: junk throws, a second submitter fails at the state check, the first is paid the reward once', async () => {
        const sc = await fresh()
        const { env } = sc
        await staked(sc)
        await toBoundary(env, toNano('40'))
        const d = await env.jackpot.getDrawState()
        const junk = await env.jackpot.sendSubmitRandomness(env.keeper.getSender(), {
            value: env.fees.submit,
            signature: beginCell().storeBuffer(Buffer.alloc(48, 1)).endCell(),
            witness: beginCell().endCell(),
        })
        expect(junk.transactions).toHaveTransaction({ to: env.jackpot.address, success: false })
        const low = await submitTest(env, Number(d.round), env.fees.submit - 1n)
        expect(low.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: JackpotError.insufficientFee })
        const first = await submitTest(env, Number(d.round), toNano('1'))
        expectChainSucceeded(first)
        const requests = first.transactions.filter((t) => t.inMessage?.info.src?.toString() === env.jackpot.address.toString())
        // no message of the submit goes to the treasury
        expect(requests.every((t) => t.inMessage?.info.dest?.toString() !== env.hipo.treasury.address.toString())).toBe(true)
        const second = await submitTest(env, Number(d.round), toNano('1'), 5)
        expect(second.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: JackpotError.notWaitingForRandomness })
    })

    it('Settings: set_rise_min and set_min_gap refuse bad values and strangers; min_gap applies at the next boundary', async () => {
        const sc = await fresh({ minGap: 3600 })
        const { env } = sc
        const v = toNano('0.05')
        for (const bad of [0, 10001]) {
            const r = await env.jackpot.sendSetRiseMin(env.governor.getSender(), { value: v, riseMin: bad })
            expect(r.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: JackpotError.invalidParameters })
        }
        for (const bad of [3599, 2592001]) {
            const r = await env.jackpot.sendSetMinGap(env.governor.getSender(), { value: v, minGap: bad })
            expect(r.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: JackpotError.invalidParameters })
        }
        const s1 = await env.jackpot.sendSetRiseMin(env.keeper.getSender(), { value: v, riseMin: 20 })
        expect(s1.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: JackpotError.accessDenied })
        const s2 = await env.jackpot.sendSetMinGap(env.keeper.getSender(), { value: v, minGap: 7200 })
        expect(s2.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: JackpotError.accessDenied })
        await env.jackpot.sendSetRiseMin(env.governor.getSender(), { value: v, riseMin: 20 })
        expect((await env.jackpot.getBoundary()).riseMin).toBe(20)
        // min_gap is stored and applies from the boundary after next
        await env.jackpot.sendSetMinGap(env.governor.getSender(), { value: v, minGap: 7200 })
        let b = await env.jackpot.getBoundary()
        expect([b.minGap, b.nextMinGap]).toEqual([3600, 7200])
        await staked(sc)
        await toBoundary(env, toNano('40')) // checks its own rule with the old value, then applies the new one
        b = await env.jackpot.getBoundary()
        expect([b.minGap, b.nextMinGap]).toEqual([7200, 0])
        expect(b.earliestNextBoundary).toBe(b.lastBoundary + 7200)
    })

    it('clear_falling resets the boundary rate', async () => {
        const sc = await fresh()
        const { env } = sc
        await staked(sc)
        await reward(env, toNano('100'))
        await poke(env) // stores the higher rate, no boundary (min_gap)
        const [tc, tt] = await env.hipo.quote()
        await env.jackpot.sendClearFalling(env.governor.getSender(), { value: toNano('0.05') })
        const b = await env.jackpot.getBoundary()
        expect([b.boundaryCoins, b.boundaryTokens]).toEqual([tc, tt])
        expect((await env.jackpot.getJackpotState()).falling).toBe(false)
    })

    it('Rhythm: min_gap of 2.5 rewards gives exactly one boundary every third reward', async () => {
        const sc = await fresh({ minGap: 90000 })
        const { env } = sc
        await staked(sc)
        let boundaries = 0
        const times: number[] = []
        for (let i = 1; i <= 30; i++) {
            setNow(env, A0 + i * 36000)
            await reward(env, toNano('20'))
            const r = await poke(env)
            const logs = logsOf<BoundaryLog>(r.externals, LogTopic.boundary)
            if (logs.length) {
                boundaries += 1
                times.push(i)
                const d = await env.jackpot.getDrawState()
                if (d.state === DrawState.waiting) await submitTest(env, Number(d.round))
            }
        }
        expect(boundaries).toBe(10)
        expect(times).toEqual([3, 6, 9, 12, 15, 18, 21, 24, 27, 30])
    })

    it('Hands-free: pokes and submits only; one boundary and three prizes each round', async () => {
        const sc = await fresh({ minGap: 3600 })
        const { env } = sc
        await staked(sc)
        const prizes: number[] = []
        for (let i = 1; i <= 12; i++) {
            setNow(env, A0 + i * 4000)
            await reward(env, toNano('20'))
            const r = await poke(env)
            expect(logsOf<BoundaryLog>(r.externals, LogTopic.boundary)).toHaveLength(1)
            const d = await env.jackpot.getDrawState()
            const sub = await submitTest(env, Number(d.round))
            expectChainSucceeded(sub)
            prizes.push(logsOf<SlotLog>(sub.externals, LogTopic.slot).filter((s) => s.result === 0).length)
        }
        // each draw pays up to three prizes; with 4 players and 16 attempts a slot nearly always hits
        expect(prizes.every((p) => p === 3)).toBe(true)
        await expectSolvent(env)
    })

    it('Low float: at a boundary with the float below fee::unstake, u is 0 and the pot is set aside whole', async () => {
        const sc = await fresh({ float: toNano('0.5') })
        const { env } = sc
        await staked(sc)
        const r = await toBoundary(env, toNano('40'))
        const [log] = logsOf<BoundaryLog>(r.externals, LogTopic.boundary)
        expect(log.unstaked).toBe(0n)
        expectChainSucceeded(r)
    })
})
