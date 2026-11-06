/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests read state they just made */
// The core paths of the Jackpot (amendment 1), end to end in the sandbox with the real Hipo contracts: deposits,
// withdrawals by burn, a wallet closing and reopening, a boundary, the draw through three prizes, a skip, a rollover
// at a boundary, and the float refilled by an unstake. One draw runs on the production build with the recorded drand
// rounds; the others use the test build (tests/jackpot/testbuild.ts).
import '@ton/test-utils'
import { Address, beginCell, toNano } from '@ton/core'
import { Blockchain, createEmptyShardAccount, SendMessageResult } from '@ton/sandbox'
import { createHash } from 'crypto'
import { Node } from '../wrappers/Node'
import {
    BoundaryLog,
    DrawState,
    JackpotError,
    JackpotOp,
    LogTopic,
    RandomnessLog,
    RefusedLog,
    Reason,
    SlotLog,
    SlotResult,
    UnstakeLog,
    WithdrawalLog,
    floatLow,
    logsOf,
    rewardSubmit,
} from '../wrappers/Jackpot'
import {
    Env,
    balanceOf,
    boundaryOf,
    codes,
    depositHgram,
    drawRounds,
    expectChainSucceeded,
    expectSolvent,
    fixtureRound,
    gasOf,
    hgramOf,
    jackpotState,
    jgramOf,
    makeBoundary,
    messageFrom,
    mintHgram,
    nodeAt,
    poke,
    reward,
    setupJackpot,
    slotsIn,
    stake,
    submitRound,
    walletAt,
    withdraw,
} from './jackpot/setup'
import { A0, fresh, holdUntil, put, setNow, submitDraw, toAddr, toBoundary } from './jackpot/scenario'

// What a deposit leaves in the float for the nodes it may open: a new position's share of them.
function nodeShare(env: Env): bigint {
    const nodeOpen = env.fees.nodeStorage + toNano('0.02')
    return nodeOpen / 64n + nodeOpen / 4096n + nodeOpen / 262144n + 3n
}

// The owner of the k-th ticket of a snapshot: positions in order, each with its tickets.
function ticketOwner(k: bigint, positions: { owner: Address; tickets: bigint }[]): Address {
    let rest = k
    for (const p of positions) {
        if (rest < p.tickets) return p.owner
        rest -= p.tickets
    }
    throw new Error('ticket beyond the snapshot')
}

// k(i, j) = uint256(sha256(seed ‖ uint8 i ‖ uint8 j)) mod snapshot tickets, recomputed from a logged seed.
function position(seed: bigint, slot: number, attempt: number, snapshot: bigint): bigint {
    const data = Buffer.concat([Buffer.from(seed.toString(16).padStart(64, '0'), 'hex'), Buffer.from([slot, attempt])])
    return BigInt('0x' + createHash('sha256').update(data).digest('hex')) % snapshot
}

describe('Flows', () => {
    // The tree as the nodes hold it: committed + added - removed of position b, read from its level-1 node.
    async function treeBalance(env: Env, b: bigint): Promise<bigint> {
        const node = await nodeAt(env, 1, b >> 6n).getNodeData()
        const c = Number(b & 63n)
        return node.committed[c] + node.added[c] - node.removed[c]
    }

    // The top node's total: the sum of every position, as the tree sees it.
    async function treeTotal(env: Env): Promise<bigint> {
        const top = await nodeAt(env, 4, 0n).getNodeData()
        return (
            top.committed.reduce((a, x) => a + x, 0n) +
            top.added.reduce((a, x) => a + x, 0n) -
            top.removed.reduce((a, x) => a + x, 0n)
        )
    }

    describe('deposits and withdrawals', () => {
        it('first deposit: a new wallet, a position, the tree, and the float kept but for the nodes', async () => {
            const { env, players } = await fresh({ players: 2 })
            const [alice] = players
            const before = await balanceOf(env, env.jackpot.address)
            const tokens = await hgramOf(env, alice.address)
            const { result, booking } = await depositHgram(env, alice, tokens, { minC: 0n })
            expectChainSucceeded(result)
            const [tc, tt] = await env.jackpot.getQuote()
            const v = (tokens * tc) / tt
            expect(booking).toBeDefined()
            // no principal yet, so no pot to pay into: the principal is the value of the tokens
            expect(booking!.principal).toBe(v)
            expect(booking!.tokens).toBe(tokens)
            expect(booking!.b).toBe(0n)
            const s = await jackpotState(env)
            expect(s.principal).toBe(v)
            expect(s.tickets).toBe(v)
            expect(s.heldTokens).toBe(tokens)
            expect(s.incomingTokens).toBe(0n)
            expect(s.nextPosition).toBe(1n)
            const w = await walletAt(env, alice.address).getWalletState()
            expect(w).toMatchObject({ setUp: true, balance: v, hasPosition: true, position: 0n, pending: 0n })
            expect(await jgramOf(env, alice.address)).toBe(v)
            // the tree holds the tickets as held changes, not yet in the snapshot
            const leaf = await nodeAt(env, 1, 0n).getNodeData()
            expect(leaf.added[0]).toBe(v)
            expect(leaf.committed[0]).toBe(0n)
            expect(leaf.owners[0]).toBe(BigInt('0x' + alice.address.hash.toString('hex')))
            expect(await treeTotal(env)).toBe(v)
            // The first position opens the first node of each level from the float, and keeps its node share: the
            // float falls by exactly that and by nothing else. The user paid for all the gas.
            const nodeOpen = env.fees.nodeStorage + toNano('0.02')
            expect(before - (await balanceOf(env, env.jackpot.address))).toBe(4n * nodeOpen - nodeShare(env))
            await expectSolvent(env)
            expect((await env.jackpot.getJettonData()).totalSupply).toBe(v)
        })

        it('a second deposit joins the same wallet and position; another player gets the next position', async () => {
            const { env, players } = await fresh({ players: 2 })
            const [alice, bob] = players
            await put(env, alice, toNano('100'))
            const { result, booking } = await put(env, alice, toNano('50'))
            expectChainSucceeded(result)
            expect(booking!.b).toBe(0n)
            const s = await jackpotState(env)
            expect(s.nextPosition).toBe(1n)
            const w = await walletAt(env, alice.address).getWalletState()
            expect(w.balance).toBe(s.principal)
            expect(w.pending).toBe(0n)
            expect(await treeBalance(env, 0n)).toBe(s.principal)
            const { booking: bobs } = await put(env, bob, toNano('30'))
            expect(bobs!.b).toBe(1n)
            expect(await treeTotal(env)).toBe((await jackpotState(env)).principal)
            await expectSolvent(env)
        })

        it('burns: partial, then full; the wallet closes, and reopens with a new position', async () => {
            const { env, players } = await fresh({ players: 2 })
            const [alice, bob] = players
            await put(env, alice, toNano('100'))
            await put(env, bob, toNano('50'))
            const [tc, tt] = await env.jackpot.getQuote()
            const hgramBefore = await hgramOf(env, alice.address)

            const x = toNano('30')
            const partial = await withdraw(env, alice, x)
            expectChainSucceeded(partial)
            const w = (x * tt) / tc
            const logs = logsOf<WithdrawalLog>(partial.externals, LogTopic.withdrawal)
            expect(logs).toHaveLength(1)
            expect(logs[0]).toMatchObject({ principal: x, tokens: w, last: false, moved: false })
            // the payout is in the step that received the burn: no quote was asked
            expect(
                partial.transactions.some(
                    (t) => t.inMessage?.info.dest?.toString() === env.hipo.treasury.address.toString(),
                ),
            ).toBe(false)
            expect(await hgramOf(env, alice.address)).toBe(hgramBefore + w)
            expect(await jgramOf(env, alice.address)).toBe(toNano('100') - x)
            const s = await jackpotState(env)
            expect(s.principal).toBe(toNano('150') - x)
            // principal and tickets fall together, in the same step
            expect(s.tickets).toBe(s.principal)
            expect(await treeBalance(env, 0n)).toBe(toNano('70'))
            expect((await nodeAt(env, 1, 0n).getNodeData()).removed[0]).toBe(x)

            // a partial burn under 1 GRAM, and more than the balance, are refused by the wallet
            const tiny = await withdraw(env, alice, toNano('0.5'))
            expect(tiny.transactions).toHaveTransaction({ to: walletAt(env, alice.address).address, success: false })
            const over = await withdraw(env, alice, toNano('71'))
            expect(over.transactions).toHaveTransaction({ to: walletAt(env, alice.address).address, success: false })

            // everything: 0 means all. The wallet is deleted and its GRAM returns to the owner.
            const full = await withdraw(env, alice, 0n)
            expectChainSucceeded(full)
            const walletState = await env.blockchain.getContract(walletAt(env, alice.address).address)
            expect(walletState.accountState?.type).not.toBe('active')
            expect(walletState.balance).toBe(0n)
            expect((await jackpotState(env)).principal).toBe(toNano('50'))
            expect(await treeBalance(env, 0n)).toBe(0n)
            await expectSolvent(env)

            // a later deposit opens the wallet again, at a new position: the old one is never used again
            const { booking } = await put(env, alice, toNano('20'))
            expect(booking!.b).toBe(2n)
            expect(await jgramOf(env, alice.address)).toBe(toNano('20'))
            expect(await treeTotal(env)).toBe((await jackpotState(env)).principal)
            await expectSolvent(env)
        })

        it('a deposit pays the normal price of the pot: c = floor(v·P / (P + pot_v)), to the nano', async () => {
            const { env, players } = await fresh({ players: 2 })
            const [alice, bob] = players
            await put(env, alice, toNano('200'))
            await reward(env, toNano('4'))
            await poke(env) // stores the new rate; min_gap has not passed, so no boundary
            const before = await jackpotState(env)
            const [tc, tt] = [before.quoteCoins, before.quoteTokens]
            const need = (before.principal * tt + tc - 1n) / tc
            const pot = before.heldTokens - before.incomingTokens - before.reservedTokens - need
            const potV = (pot * tc + tt - 1n) / tt
            const tokens = await hgramOf(env, bob.address)
            const { result, booking } = await depositHgram(env, bob, tokens, { minC: 0n })
            expectChainSucceeded(result)
            const v = (tokens * tc) / tt
            expect(potV).toBeGreaterThan(0n)
            expect(booking!.principal).toBe((v * before.principal) / (before.principal + potV))
            expect(booking!.principal).toBeLessThan(v)
            await expectSolvent(env)
        })

        it('the default limit: a price more than 1% above the value is refused, and the tokens come back whole', async () => {
            const { env, players } = await fresh({ players: 2 })
            const [alice, bob] = players
            await put(env, alice, toNano('200'))
            await reward(env, toNano('400')) // a 5% rise: the pot is about 5% of the principal
            await poke(env)
            const before = await jackpotState(env)
            const bobBefore = await hgramOf(env, bob.address)
            const floatBefore = await balanceOf(env, env.jackpot.address)
            // no options at all: the default limit is 1% under the value
            const { result, booking } = await depositHgram(env, bob, toNano('100'))
            expectChainSucceeded(result)
            expect(booking).toBeUndefined()
            const [refused] = logsOf<RefusedLog>(result.externals, LogTopic.refused)
            expect(refused.reason).toBe(Reason.price)
            const after = await jackpotState(env)
            expect(after.principal).toBe(before.principal)
            expect(after.tickets).toBe(before.tickets)
            expect(after.heldTokens).toBe(before.heldTokens)
            expect(after.incomingTokens).toBe(0n)
            expect(after.nextPosition).toBe(before.nextPosition)
            expect(await hgramOf(env, bob.address)).toBe(bobBefore)
            expect(await jgramOf(env, bob.address)).toBe(0n)
            // the wallet that was opened for it is gone again, and the float did not move
            const w = await env.blockchain.getContract(walletAt(env, bob.address).address)
            expect(w.accountState?.type).not.toBe('active')
            expect(await balanceOf(env, env.jackpot.address)).toBe(floatBefore)
            // a payload that is not deposit_options is the default too
            const again = await depositHgram(env, bob, toNano('100'), {
                payload: beginCell().storeUint(0, 1).storeUint(5, 64).endCell(),
            })
            expect(again.booking).toBeUndefined()
            expect(await hgramOf(env, bob.address)).toBe(bobBefore)
        })

        it('the Jackpot never pays for a user chain: its balance is the same after a deposit and a burn', async () => {
            const { env, players } = await fresh({ players: 1 })
            const [alice] = players
            await put(env, alice, toNano('100'))
            const before = await balanceOf(env, env.jackpot.address)
            const d = await put(env, alice, toNano('50'))
            expectChainSucceeded(d.result)
            expect(await balanceOf(env, env.jackpot.address)).toBe(before)
            const w = await withdraw(env, alice, toNano('20'))
            expectChainSucceeded(w)
            expect(await balanceOf(env, env.jackpot.address)).toBe(before)
            const full = await withdraw(env, alice, 0n)
            expectChainSucceeded(full)
            expect(await balanceOf(env, env.jackpot.address)).toBe(before)
        })

        it("gas returned: what the user spends is the chain's real fees, at the minimum and at 1 GRAM over it", async () => {
            const { env, players } = await fresh({ players: 2 })
            const [alice, bob] = players
            await put(env, alice, toNano('200'))
            for (const extra of [0n, toNano('1')]) {
                const tokens = toNano('20')
                const before = await balanceOf(env, bob.address)
                const { result } = await depositHgram(env, bob, tokens, {
                    minC: 0n,
                    forward: env.fees.deposit + extra,
                })
                const spent = before - (await balanceOf(env, bob.address))
                const fees = result.transactions.reduce((a, t) => a + t.totalFees.coins, 0n)
                // a new wallet keeps its reserve and a new position leaves its node share in the float
                const reserve = extra === 0n ? env.fees.walletStorage + nodeShare(env) : 0n
                expect(spent - fees - reserve).toBeLessThanOrEqual(toNano('0.002'))
                expect(spent - fees - reserve).toBeGreaterThanOrEqual(0n)

                const beforeW = await balanceOf(env, bob.address)
                const w = await withdraw(env, bob, toNano('5'), env.fees.withdraw + extra)
                const spentW = beforeW - (await balanceOf(env, bob.address))
                const feesW = w.transactions.reduce((a, t) => a + t.totalFees.coins, 0n)
                expect(spentW - feesW).toBeLessThanOrEqual(toNano('0.002'))
                expect(spentW - feesW).toBeGreaterThanOrEqual(0n)
            }
        })

        it('a burn pays while halted and with an empty float; a deposit while halted is refused whole', async () => {
            const { env, players } = await fresh({ players: 2 })
            const [alice, bob] = players
            await put(env, alice, toNano('200'))
            await env.jackpot.sendSetHalted(env.governor.getSender(), { value: toNano('0.05'), halted: true })
            const hgramBefore = await hgramOf(env, alice.address)
            const result = await withdraw(env, alice, toNano('50'))
            expectChainSucceeded(result)
            expect(await hgramOf(env, alice.address)).toBeGreaterThan(hgramBefore)
            // a deposit while halted comes back
            const bobBefore = await hgramOf(env, bob.address)
            const dep = await depositHgram(env, bob, toNano('100'), { minC: 0n })
            expect(dep.booking).toBeUndefined()
            expect(
                logsOf<RefusedLog>(dep.result.externals, LogTopic.refused).length + dep.result.externals.length,
            ).toBeGreaterThanOrEqual(0)
            expect(await hgramOf(env, bob.address)).toBe(bobBefore)
            expect((await jackpotState(env)).incomingTokens).toBe(0n)
            // with the float emptied to a trace
            await env.jackpot.sendSetHalted(env.governor.getSender(), { value: toNano('0.05'), halted: false })
            const { setBalance } = await import('./jackpot/scenario')
            await setBalance(env, env.jackpot.address, toNano('0.02'))
            const h = await hgramOf(env, alice.address)
            expectChainSucceeded(await withdraw(env, alice, toNano('10')))
            expect(await hgramOf(env, alice.address)).toBeGreaterThan(h)
        })

        it('a full burn, the wallet closing, and the same player depositing again keeps the books straight', async () => {
            const { env, players } = await fresh({ players: 3 })
            for (const p of players) await put(env, p, toNano('500'))
            const rb = await toBoundary(env, toNano('40'))
            expectChainSucceeded(rb)
            expect((await env.jackpot.getDrawState()).state).toBe(DrawState.waiting)
            expectChainSucceeded(await submitDraw(env))
            expect((await env.jackpot.getDrawState()).state).toBe(DrawState.none)
            await expectSolvent(env)
            expectChainSucceeded(await withdraw(env, players[0], 0n))
            expect(await jgramOf(env, players[0].address)).toBe(0n)
            await expectSolvent(env)
        })
    })

    describe('a draw', () => {
        async function three() {
            const sc = await fresh({ players: 3 })
            const [alice, bob, carol] = sc.players
            const a = await put(sc.env, alice, toNano('200'))
            const b = await put(sc.env, bob, toNano('100'))
            const c = await put(sc.env, carol, toNano('100'))
            const positions = [
                { owner: alice.address, tickets: a.booking!.principal },
                { owner: bob.address, tickets: b.booking!.principal },
                { owner: carol.address, tickets: c.booking!.principal },
            ]
            return { ...sc, positions }
        }

        it('a boundary sends nothing but the quote chain, and takes the snapshot at once', async () => {
            const { env, players } = await three()
            expect((await env.jackpot.getDrawState()).state).toBe(DrawState.none)
            const s0 = await jackpotState(env)
            expect(s0.tag).toBe(0n)
            await reward(env, toNano('40'))
            setNow(env, A0 + 3600)
            const result = await poke(env)
            expectChainSucceeded(result)
            // the transactions: the poke, the treasury's reply, the Jackpot's handling of it, the excess to the poker
            expect(
                result.transactions.filter(
                    (t) => t.inMessage?.info.dest?.toString() === env.jackpot.address.toString(),
                ),
            ).toHaveLength(2)
            const logs = logsOf<BoundaryLog>(result.externals, LogTopic.boundary)
            expect(logs).toHaveLength(1)
            expect(logs[0]).toMatchObject({ tag: 1n, snapshotTickets: s0.tickets, time: BigInt(A0 + 3600) })
            const draw = await env.jackpot.getDrawState()
            expect(draw.state).toBe(DrawState.waiting)
            expect(draw.snapshotTickets).toBe(s0.tickets)
            // a second poke in the same period makes no other boundary
            await poke(env)
            expect((await jackpotState(env)).tag).toBe(1n)
            // a deposit now joins the next draw: the tree keeps the snapshot as it was
            const late = await put(env, players[0], toNano('10'))
            const leaf = await nodeAt(env, 1, 0n).getNodeData()
            expect(leaf.added[0]).toBe(late.booking!.principal)
        })

        it('submit through three prizes; each winner is the owner of the k-th ticket, recomputed from the logs', async () => {
            const { env, positions } = await three()
            const rb = await toBoundary(env, toNano('400'))
            const [log] = logsOf<BoundaryLog>(rb.externals, LogTopic.boundary)
            const before = await jackpotState(env)
            const keeperBefore = await balanceOf(env, env.keeper.address)
            const floatBefore = await balanceOf(env, env.jackpot.address)
            const result = await submitDraw(env)
            expectChainSucceeded(result)

            expect(log.snapshotTickets).toBe(before.tickets)
            const [p0, p1, p2] = log.prizes!
            const rest = log.pot - log.unstaked - log.burn
            expect(p0).toBe(rest / 2n)
            expect(p1).toBe((rest * 3000n) / 10000n)
            expect(p0 + p1 + p2).toBe(rest)
            expect(log.burn).toBe(((log.pot - log.unstaked - log.carried) * 1000n) / 10000n)
            expect(log.pot).toBeGreaterThan(toNano('10'))

            const [rand] = logsOf<RandomnessLog>(result.externals, LogTopic.randomness)
            const slots = slotsIn(result)
            expect(slots.map((x: SlotLog) => x.result)).toEqual([SlotResult.hit, SlotResult.hit, SlotResult.hit])
            const prizes = [p0, p1, p2]
            for (const hit of slots) {
                expect(hit.attempt).toBe(0)
                expect(hit.position).toBe(position(rand.seed, hit.slot, 0, log.snapshotTickets))
                expect(hit.owner!.toString()).toBe(ticketOwner(hit.position, positions).toString())
                expect(hit.amount).toBe(prizes[hit.slot])
            }
            const state = await jackpotState(env)
            expect((await env.jackpot.getDrawState()).state).toBe(DrawState.none)
            expect(state.carried).toBe(0n)
            // the prizes left reserved_tokens when they were paid; the burn owed stays
            expect(state.burnOwed).toBe(log.burn)
            expect(state.reservedTokens).toBe(log.burn)
            expect(state.heldTokens).toBe(before.heldTokens - rest)
            // the winners hold their prizes in hGRAM
            const won = new Map<string, bigint>()
            for (const hit of slots) won.set(hit.owner!.toString(), (won.get(hit.owner!.toString()) ?? 0n) + hit.amount)
            for (const [who, amount] of won) {
                expect(await hgramOf(env, Address.parse(who))).toBeGreaterThanOrEqual(amount)
            }
            // after the draw the pot is gone: free hGRAM covers the principal and no more than a nano or two
            const [tc, tt] = await env.jackpot.getQuote()
            const free = state.heldTokens - state.incomingTokens - state.reservedTokens
            expect(free * tc - state.principal * tt).toBeGreaterThanOrEqual(0n)
            expect(free - (state.principal * tt + tc - 1n) / tc).toBeLessThanOrEqual(2n)
            await expectSolvent(env)
            // the submitter ends ahead by r_s less its gas, the float by about r_s less the searches
            const keeperAfter = await balanceOf(env, env.keeper.address)
            expect(keeperAfter - keeperBefore + env.fees.submit).toBeGreaterThan(rewardSubmit / 2n)
            expect(floatBefore - (await balanceOf(env, env.jackpot.address))).toBeLessThan(toNano('1'))
            // a second submit finds the draw over
            const second = await submitDraw(env)
            expect(second.transactions).toHaveTransaction({
                to: env.jackpot.address,
                success: false,
                exitCode: JackpotError.notWaitingForRandomness,
            })
            expect(await treeTotal(env)).toBe(state.principal)
        })

        it('the production build: the recorded drand round is checked, the seed mixes in mc_hash, junk is refused', async () => {
            const round = drawRounds[0]
            const env = await setupJackpot({
                time: boundaryOf(round) - 3600,
                config: { minGap: 3600, minDeposit: toNano('1') },
            })
            const players = [await env.blockchain.treasury('pa'), await env.blockchain.treasury('pb')]
            const positions: { owner: Address; tickets: bigint }[] = []
            for (const p of players) {
                await mintHgram(env, p, toNano('1000'))
                const { booking } = await depositHgram(env, p, toNano('300'), { minC: 0n })
                positions.push({ owner: p.address, tickets: booking!.principal })
            }
            const rb = await makeBoundary(env, { at: boundaryOf(round), gram: toNano('40') })
            const [log] = logsOf<BoundaryLog>(rb.externals, LogTopic.boundary)
            expect(log.round).toBe(BigInt(round))
            // a signature from another round, and a short one, change nothing
            const wrong = await submitRound(env, drawRounds[1])
            expect(wrong.transactions).toHaveTransaction({ to: env.jackpot.address, success: false })
            expect((await env.jackpot.getDrawState()).state).toBe(DrawState.waiting)
            const cheap = await submitRound(env, round, env.fees.submit - 1n)
            expect(cheap.transactions).toHaveTransaction({
                to: env.jackpot.address,
                success: false,
                exitCode: JackpotError.insufficientFee,
            })
            const result = await submitRound(env, round)
            expectChainSucceeded(result)
            const [rand] = logsOf<RandomnessLog>(result.externals, LogTopic.randomness)
            const signature = Buffer.from(fixtureRound(round).signature, 'hex')
            const mcHash = Buffer.from(log.mcHash!.toString(16).padStart(64, '0'), 'hex')
            expect(rand.seed).toBe(
                BigInt(
                    '0x' +
                        createHash('sha256')
                            .update(Buffer.concat([signature, mcHash]))
                            .digest('hex'),
                ),
            )
            for (const hit of slotsIn(result)) {
                expect(hit.position).toBe(position(rand.seed, hit.slot, hit.attempt, log.snapshotTickets))
                if (hit.result === SlotResult.hit) {
                    expect(hit.owner!.toString()).toBe(ticketOwner(hit.position, positions).toString())
                }
            }
            expect(slotsIn(result).filter((x) => x.result === SlotResult.hit)).toHaveLength(3)
            await expectSolvent(env)
        })

        it('a skip keeps the draw, and the next boundary after it pays the pot to a snapshot with the new deposit', async () => {
            const { env, players } = await three()
            await toBoundary(env, toNano('40'))
            const first = await env.jackpot.getDrawState()
            expect(first.state).toBe(DrawState.waiting)
            // a deposit while the draw waits: the normal price, and no ticket in the draw that is waiting
            const mid = await put(env, players[0], toNano('50'))
            const [tc, tt] = await env.jackpot.getQuote()
            expect(mid.booking!.principal).toBeLessThanOrEqual((mid.booking!.tokens * tc) / tt)
            // nobody submits. The next boundary passes.
            const skip = await toBoundary(env, toNano('40'))
            expectChainSucceeded(skip)
            expect(skip.externals.length).toBeGreaterThan(0)
            const after = await env.jackpot.getDrawState()
            expect(after.state).toBe(DrawState.waiting)
            expect(after.tag).toBe(first.tag) // the snapshot stays as it was
            expect(after.snapshotTickets).toBe(first.snapshotTickets) // the deposit waits
            expect(after.round).toBeGreaterThan(first.round)
            expect(after.seed).toBe(0n)
            const result = await submitDraw(env)
            expectChainSucceeded(result)
            const slots = slotsIn(result)
            expect(slots.filter((x) => x.result === SlotResult.hit)).toHaveLength(3)
            // the deposit made while it waited is not among the winners' tickets: positions are within the snapshot
            for (const hit of slots) expect(hit.position).toBeLessThan(first.snapshotTickets)
            // and it joins the next draw: the next boundary takes a snapshot of all of it
            const next = await toBoundary(env, toNano('40'))
            expect(logsOf<BoundaryLog>(next.externals, LogTopic.boundary)[0].snapshotTickets).toBe(
                (await jackpotState(env)).tickets,
            )
        })

        it('a slot that is still searching at the next boundary rolls over', async () => {
            const { env } = await three()
            const rb = await toBoundary(env, toNano('40'))
            const [bl] = logsOf<BoundaryLog>(rb.externals, LogTopic.boundary)
            // the level-3 node is gone, so no search is ever answered: the slots stay open
            const node = nodeAt(env, 3, 0n)
            await env.blockchain.setShardAccount(node.address, createEmptyShardAccount(node.address))
            await submitDraw(env)
            const open = await env.jackpot.getDrawState()
            expect(open.state).toBe(DrawState.resolving)
            expect(open.openSlots).toBe(7)
            // the boundary ends the draw: every open slot rolls over into carried, and a new snapshot is taken
            const tick = await toBoundary(env, toNano('40'))
            const slots = slotsIn(tick)
            expect(slots.map((x) => x.result)).toEqual([SlotResult.expired, SlotResult.expired, SlotResult.expired])
            const after = await jackpotState(env)
            const [p0, p1, p2] = bl.prizes!
            expect(logsOf<BoundaryLog>(tick.externals, LogTopic.boundary)[0].carried).toBe(p0 + p1 + p2)
            expect(after.tag).toBe(2n)
            expect((await env.jackpot.getDrawState()).state).toBe(DrawState.waiting)
            await expectSolvent(env)
        })

        it('a deposit booked before a boundary is in that draw, one booked after it is not', async () => {
            const { env, players } = await three()
            await reward(env, toNano('40'))
            await put(env, players[0], toNano('7'))
            const tickets = (await jackpotState(env)).tickets
            const rb = await toBoundary(env, 0n)
            expect(logsOf<BoundaryLog>(rb.externals, LogTopic.boundary)[0].snapshotTickets).toBe(tickets)
            await put(env, players[1], toNano('9'))
            expect((await env.jackpot.getDrawState()).snapshotTickets).toBe(tickets)
            expect((await jackpotState(env)).tickets).toBeGreaterThan(tickets)
        })
    })

    describe('the jetton', () => {
        it('one wallet per player, not transferable, answering TEP-74', async () => {
            const { env, players } = await fresh({ players: 2 })
            const [alice, bob] = players
            await put(env, alice, toNano('100'))
            await put(env, alice, toNano('40'))
            await put(env, bob, toNano('60'))
            const w = walletAt(env, alice.address)
            expect((await env.jackpot.getWalletAddress(alice.address)).toString()).toBe(w.address.toString())
            const data = await w.getWalletData()
            expect(data.owner.toString()).toBe(alice.address.toString())
            expect(data.jetton.toString()).toBe(env.jackpot.address.toString())
            const supply = (await env.jackpot.getJettonData()).totalSupply
            expect(supply).toBe(data.balance + (await walletAt(env, bob.address).getWalletData()).balance)
            const send = await w.sendTransfer(alice.getSender(), {
                value: toNano('0.1'),
                amount: toNano('1'),
                to: bob.address,
            })
            expect(send.transactions).toHaveTransaction({
                to: w.address,
                success: false,
                exitCode: JackpotError.notTransferable,
            })
            expect((await w.getWalletData()).balance).toBe(data.balance)
        })

        it('a forged deposit_ready changes nothing', async () => {
            const { env, players } = await fresh({ players: 2 })
            await put(env, players[0], toNano('100'))
            const before = await jackpotState(env)
            const ctx = beginCell().endCell()
            const body = beginCell()
                .storeUint(JackpotOp.depositReady, 32)
                .storeUint(12345, 64)
                .storeBit(false)
                .storeBit(false)
                .storeRef(ctx)
                .endCell()
            const result = await env.blockchain.sendMessage(
                messageFrom(players[1].address, env.jackpot.address, toNano('0.1'), body),
            )
            // a context that cannot be read throws before the sender check, and the value goes back with the bounce
            expect(result.transactions).toHaveTransaction({ from: players[1].address, to: env.jackpot.address })
            expect(await jackpotState(env)).toEqual(before)
        })
    })

    describe('gas', () => {
        it('float_low covers the most one draw can spend', async () => {
            const { env } = await fresh({ players: 1 })
            expect(env.fees.floatLow).toBeGreaterThan(env.fees.drawBudget)
            expect(env.fees.floatHigh).toBeGreaterThan(env.fees.floatLow)
        })

        // 400 nano-GRAM per gas is the worst case the fees are sized at
        const gasPrice = 400n

        it('every handler of a deposit, a burn, a poke and a draw fits its fee', async () => {
            const { env, players } = await fresh({ players: 2 })
            const [alice, bob] = players
            await put(env, alice, toNano('200'))
            const chains: SendMessageResult[] = []
            chains.push((await put(env, bob, toNano('100'))).result)
            chains.push(await withdraw(env, alice, toNano('30')))
            chains.push(await toBoundary(env, toNano('40')))
            chains.push(await submitDraw(env))
            const limits = new Map<string, bigint>()
            const track = (who: string, gas: bigint) =>
                limits.set(who, gas > (limits.get(who) ?? 0n) ? gas : (limits.get(who) ?? 0n))
            for (const r of chains) {
                for (const g of gasOf(r, env.jackpot.address))
                    track(g.op === JackpotOp.submitRandomness ? 'submit' : 'jackpot', g.gas)
                for (const tx of r.transactions) {
                    const dest = tx.inMessage?.info.dest?.toString()
                    if (dest == null || tx.description.type !== 'generic' || tx.description.computePhase.type !== 'vm')
                        continue
                    const gas = tx.description.computePhase.gasUsed
                    if (
                        dest === walletAt(env, alice.address).address.toString() ||
                        dest === walletAt(env, bob.address).address.toString()
                    )
                        track('wallet', gas)
                    for (let level = 1; level <= 4; level++) {
                        if (dest === nodeAt(env, level, 0n).address.toString()) track('node', gas)
                    }
                }
            }
            expect(limits.get('jackpot')! * gasPrice).toBeLessThanOrEqual(20_000_000n + 100_000n * 400n) // fee::handler, and fee::boundary_max (100,000 gas)
            expect(limits.get('wallet')! * gasPrice).toBeLessThanOrEqual(20_000_000n)
            expect(limits.get('node')! * gasPrice).toBeLessThanOrEqual(35_000_000n) // fee::node_hop
            expect(limits.get('submit')! * gasPrice).toBeLessThanOrEqual(60_000_000n)
        })

        it('a node, in its worst case (a fold of all 64 children), fits a hop', async () => {
            const { nodeCode } = await codes()
            const bc = await Blockchain.create()
            bc.now = 1_800_000_000
            const jackpot = await bc.treasury('j')
            let worst = 0n
            for (const level of [4, 1]) {
                const node = bc.openContract(
                    Node.createFromConfig({ jackpot: jackpot.address, level, index: 0n }, nodeCode),
                )
                const parent = Node.createFromConfig({ jackpot: jackpot.address, level: 2, index: 0n }, nodeCode)
                const from = level === 4 ? jackpot.address : parent.address
                const shift = BigInt(6 * (level - 1))
                const send = async (body: ReturnType<typeof beginCell>) => {
                    const r = await bc.sendMessage(messageFrom(from, node.address, toNano('1'), body.endCell(), false))
                    const tx = r.transactions.find(
                        (t) => t.inMessage?.info.dest?.toString() === node.address.toString(),
                    )!
                    const d = tx.description
                    if (d.type !== 'generic' || d.computePhase.type !== 'vm') throw new Error('no compute')
                    expect(d.computePhase.success).toBe(true)
                    return d.computePhase.gasUsed
                }
                const update = (tag: number, c: number, delta: bigint, owner: boolean) => {
                    const body = beginCell()
                        .storeUint(JackpotOp.update, 32)
                        .storeUint(0, 64)
                        .storeUint(tag, 32)
                        .storeUint(BigInt(c) << shift, 32)
                        .storeInt(delta, 128)
                        .storeBit(owner)
                    if (owner) body.storeUint(1000n + BigInt(c), 256)
                    return body
                }
                // the first message deploys the node: the state init goes with it
                await bc.sendMessage({
                    ...messageFrom(from, node.address, toNano('1'), update(1, 0, 5n, true).endCell(), false),
                    init: node.init,
                })
                for (let c = 1; c < 64; c++) await send(update(1, c, BigInt(c) * 1_000_000_000n, true))
                worst = [worst, await send(update(2, 0, 7n, true))].reduce((a, x) => (x > a ? x : a))
                for (let c = 0; c < 64; c++) await send(update(2, c, -3n, false))
                worst = [worst, await send(update(3, 63, -1n, false))].reduce((a, x) => (x > a ? x : a))
                const descend = beginCell()
                    .storeUint(JackpotOp.descend, 32)
                    .storeUint(0, 64)
                    .storeUint(4, 32)
                    .storeUint(0, 8)
                    .storeUint(0, 8)
                    .storeUint(5, 128)
                    .storeUint(63n * 1_000_000_000n * 32n, 128)
                worst = [worst, await send(descend)].reduce((a, x) => (x > a ? x : a))
            }
            expect(worst * gasPrice).toBeLessThanOrEqual(35_000_000n)
        })
    })

    describe('a burn the Jackpot cannot pay for', () => {
        it('a burn_notification with too little value bounces whole: the wallet restores x and pending, the Jackpot changes nothing', async () => {
            const { env, players } = await fresh({ players: 1 })
            const [alice] = players
            await put(env, alice, toNano('100'))
            const before = await jackpotState(env)
            const w = walletAt(env, alice.address)
            // the wallet's burn_notification, held on its way to the Jackpot
            const [note] = await holdUntil(
                env,
                messageFrom(
                    alice.address,
                    w.address,
                    env.fees.withdraw,
                    beginCell()
                        .storeUint(JackpotOp.burn, 32)
                        .storeUint(7, 64)
                        .storeCoins(0n)
                        .storeAddress(null)
                        .storeMaybeRef(null)
                        .endCell(),
                ),
                toAddr(w.address),
            )
            expect(await w.getWalletState()).toMatchObject({ balance: 0n, pending: 1n })
            // delivered with too little value for its sends: it fails and comes back
            const poor = {
                ...note,
                info: { ...(note.info as object), value: { coins: toNano('0.03') } } as typeof note.info,
            }
            const result = await env.blockchain.sendMessage(poor)
            expect(result.transactions).toHaveTransaction({ from: w.address, to: env.jackpot.address, success: false })
            expect(result.transactions).toHaveTransaction({
                from: env.jackpot.address,
                to: w.address,
                inMessageBounced: true,
            })
            expect(await w.getWalletState()).toMatchObject({ balance: toNano('100'), pending: 0n })
            expect(await jgramOf(env, alice.address)).toBe(toNano('100'))
            expect(await jackpotState(env)).toEqual(before)
        })
    })

    describe('the float', () => {
        it('a boundary below float_low unstakes part of the pot, and the float returns when Hipo burns it', async () => {
            const { env } = await fresh({ players: 3, float: toNano('7.5') })
            await put(env, await env.blockchain.treasury('player0'), toNano('200'))
            await put(env, await env.blockchain.treasury('player1'), toNano('100'))
            const before = await balanceOf(env, env.jackpot.address)
            expect(before).toBeLessThan(floatLow)
            const rb = await toBoundary(env, toNano('40'))
            expectChainSucceeded(rb)
            const unstakeLogs = logsOf<UnstakeLog>(rb.externals, LogTopic.unstake)
            expect(unstakeLogs).toHaveLength(1)
            const log = logsOf<BoundaryLog>(rb.externals, LogTopic.boundary)[0]
            expect(log.unstaked).toBeGreaterThan(0n)
            expect(log.unstaked).toBeLessThanOrEqual(log.pot / 5n)
            // Hipo burned it at once: the counter is back to 0 and the GRAM is in the float
            const state = await jackpotState(env)
            expect(state.unstakingTokens).toBe(0n)
            const after = await balanceOf(env, env.jackpot.address)
            expect(after).toBeGreaterThan(before)
            expect(after).toBeLessThanOrEqual(toNano('15') + toNano('1'))
            await expectSolvent(env)
        })

        it('a stranger refills a float that is too low for a draw; it is refused when the float covers a draw', async () => {
            const { env, players } = await fresh({ players: 3, float: toNano('3.5') })
            await put(env, players[0], toNano('200'))
            await put(env, players[1], toNano('100'))
            await reward(env, toNano('40'))
            await poke(env) // stores the rate; the pot exists at the stored rate
            const low = await balanceOf(env, env.jackpot.address)
            expect(low).toBeLessThan(env.fees.drawBudget)
            const refill = await env.jackpot.sendRefill(players[2].getSender(), { value: env.fees.refill })
            expectChainSucceeded(refill)
            expect((await jackpotState(env)).unstakingTokens).toBe(0n)
            expect(await balanceOf(env, env.jackpot.address)).toBeGreaterThan(low)
            await env.jackpot.sendTopUp(players[2].getSender(), toNano('10'))
            const again = await env.jackpot.sendRefill(players[2].getSender(), { value: env.fees.refill })
            expect(again.transactions).toHaveTransaction({ to: env.jackpot.address, success: false })
        })
    })

    describe('the whole round', () => {
        it('deposits, a boundary, a draw and a full burn: books straight at every step', async () => {
            const { env, players } = await fresh({ players: 3 })
            for (const p of players) {
                const r = await stake(env, p, toNano('100'), 0n)
                expectChainSucceeded(r.result)
                expect(r.booking).toBeDefined()
            }
            await expectSolvent(env)
            const rb = await makeBoundary(env, { gram: toNano('200') })
            expect(logsOf<BoundaryLog>(rb.externals, LogTopic.boundary)).toHaveLength(1)
            expect((await env.jackpot.getDrawState()).state).toBe(DrawState.waiting)
            expectChainSucceeded(await submitDraw(env))
            await expectSolvent(env)
            const w = await withdraw(env, players[0], 0n)
            expectChainSucceeded(w)
            expect(await jgramOf(env, players[0].address)).toBe(0n)
            await expectSolvent(env)
        })
    })
})
