/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests read state they just made */
 
// Acceptance criteria of docs/specs/2026-11-03-jackpot-v2-amendment-1.md that were open: the boundary rule at the exact
// threshold, a thousand pokes, a placed boundary, the chains, the bounce formats, the Failures table, the rate in exact
// fractions, the end of the tree, and the value returned by each entry. Each test is named after its criterion or row.
//
// PLACED_SEEDS (6) sets the number of seeds of the placed-boundary check; a long run raises it.
import '@ton/test-utils'
import { Address, Cell, Dictionary, beginCell, toNano } from '@ton/core'
import { readFileSync } from 'fs'
import { BlockchainTransaction, SendMessageResult } from '@ton/sandbox'
import {
    BoundaryLog,
    DrawState,
    JackpotOp,
    LogTopic,
    SlotLog,
    SlotResult,
    UntrackedLog,
    logsOf,
} from '../wrappers/Jackpot'
import {
    balanceOf,
    commentOf,
    depositHgram,
    expectChainSucceeded,
    expectSolvent,
    hgramOf,
    jackpotState,
    jgramOf,
    messageFrom,
    nodeAt,
    notificationsTo,
    opOf,
    poke,
    reward,
    slotsIn,
    sweepValue,
    walletAt,
    withdraw,
} from './jackpot/setup'
import { A0, deliver, fresh, holdUntil, pokeFake, put, setNow, submitDraw, toAddr, toBoundary } from './jackpot/scenario'

const G = (n: string | number) => toNano(String(n))
const ppm = 1_000_000n
const seedsOf = (name: string, spec: number) => Number(process.env[name] ?? String(spec))

describe('The rule, at the threshold', () => {
    it('a reply one part per million short of rise_min is not a boundary; at exactly rise_min it is; a reply while halted stores the rate and makes none', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000'), fake: true, riseMin: 50 })
        const { env, players } = sc
        await put(env, players[0], G('100'))
        const b = await env.jackpot.getBoundary()
        const at = (rise: bigint) => ({ tc: b.boundaryCoins * (ppm + rise), tt: b.boundaryTokens * ppm })
        setNow(env, b.lastBoundary + b.minGap)
        const short = at(49n) // one part per million short of 50
        const r1 = await pokeFake(sc, short.tc, short.tt)
        expectChainSucceeded(r1)
        expect(logsOf(r1.externals, LogTopic.boundary)).toHaveLength(0)
        expect((await jackpotState(env)).tag).toBe(0n)
        // the reply still stores its rate
        expect(await env.jackpot.getQuote()).toEqual([short.tc, short.tt])
        const exact = at(50n)
        const r2 = await pokeFake(sc, exact.tc, exact.tt)
        expect(logsOf(r2.externals, LogTopic.boundary)).toHaveLength(1)
        expect((await jackpotState(env)).tag).toBe(1n)
        // halted: a rise of 60 ppm over the new boundary rate stores the rate and makes no boundary
        await env.jackpot.sendSetHalted(env.governor.getSender(), { value: G('0.05'), halted: true })
        const b2 = await env.jackpot.getBoundary()
        setNow(env, b2.lastBoundary + b2.minGap)
        const big = { tc: b2.boundaryCoins * (ppm + 60n), tt: b2.boundaryTokens * ppm }
        const r3 = await pokeFake(sc, big.tc, big.tt)
        expect(logsOf(r3.externals, LogTopic.boundary)).toHaveLength(0)
        expect((await jackpotState(env)).tag).toBe(1n)
        expect(await env.jackpot.getQuote()).toEqual([big.tc, big.tt])
    }, 200000)
})

describe('Pokes', () => {
    it('1,000 pokes with no qualifying rise change nothing but the stored rate; each costs only its sender’s gas, and the Jackpot’s balance does not fall', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const { env, players } = sc
        await put(env, players[0], G('300'))
        await put(env, players[1], G('100'))
        // the rate has not moved: no rise, so no boundary at any time
        const state = await jackpotState(env)
        const boundary = await env.jackpot.getBoundary()
        const draw = await env.jackpot.getDrawState()
        const float0 = await balanceOf(env, env.jackpot.address)
        setNow(env, boundary.lastBoundary + boundary.minGap + 10)
        // the first poke pays the storage rent of the time jump; from then on the balance never falls. The pokes are sent
        // as plain internal messages from the keeper, so each costs the sandbox three transactions, not four.
        const pokeBody = beginCell().storeUint(JackpotOp.poke, 32).storeUint(0, 64).endCell()
        const one = () => env.blockchain.sendMessage(messageFrom(env.keeper.address, env.jackpot.address, env.fees.poke, pokeBody))
        expectChainSucceeded(await one())
        let float = await balanceOf(env, env.jackpot.address)
        for (let i = 0; i < 1000; i++) {
            const r = await one()
            if (i % 100 === 0) expectChainSucceeded(r)
            const f = await balanceOf(env, env.jackpot.address)
            expect(f).toBeGreaterThanOrEqual(float) // never falls
            float = f
        }
        // nothing but the stored rate changed (it is the rate of the last poke)
        const after = await jackpotState(env)
        expect({ ...after, quoteCoins: 0n, quoteTokens: 0n }).toEqual({ ...state, quoteCoins: 0n, quoteTokens: 0n })
        expect(after.quoteCoins * (await env.hipo.quote())[1]).toBe((await env.hipo.quote())[0] * after.quoteTokens)
        expect(await env.jackpot.getBoundary()).toEqual(boundary)
        expect(await env.jackpot.getDrawState()).toEqual(draw)
        // the pokers paid their own gas: a poke costs its sender at most fee::poke
        expect(float0 - float).toBeLessThan(G('0.01')) // only the one storage charge
    }, 900000)
})

describe('Placing a boundary gains nothing', () => {
    // Two worlds with the same players and the same total yield. In A the reward lands and one poke makes the boundary.
    // In B anyone first places a boundary with a gift of rise_min × Hipo's coins after min_gap, and the real reward
    // makes the next boundary. Every player's expected prize, in exact fractions over the two pots, is the same
    // (apart from the gift itself), and the sampled mean of the first draw agrees with its expected value.
    async function world(placed: boolean) {
        const sc = await fresh({ minDeposit: 1n, players: 3, mint: G('2000'), riseMin: 50 })
        const { env, players } = sc
        await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
        await put(env, players[0], G('600'))
        await put(env, players[1], G('300'))
        await put(env, players[2], G('100'))
        const [coins] = await env.hipo.quote()
        const b = await env.jackpot.getBoundary()
        const expected = new Map<string, bigint>() // owner -> expected prize in hGRAM times the snapshot, summed over draws
        const draws: { tickets: bigint; prizes: bigint; snap: ReturnType<typeof env.blockchain.snapshot> }[] = []
        const take = (r: SendMessageResult) => {
            const [log] = logsOf<BoundaryLog>(r.externals, LogTopic.boundary)
            if (log.prizes == null) return
            draws.push({ tickets: log.snapshotTickets, prizes: log.prizes[0] + log.prizes[1] + log.prizes[2], snap: env.blockchain.snapshot() })
        }
        if (placed) {
            // a gift of rise_min of Hipo's coins after min_gap, then a poke: the placed boundary
            const gift = (coins * 51n) / ppm
            await env.hipo.treasury.sendGiftCoins(env.hipo.governor.getSender(), { value: gift + G('1'), coins: gift })
            setNow(env, b.lastBoundary + b.minGap)
            take(await poke(env))
            await submitDraw(env)
            setNow(env, (env.blockchain.now ?? A0) + b.minGap)
        } else {
            setNow(env, b.lastBoundary + 2 * b.minGap)
        }
        // the real reward, and the boundary it makes
        await reward(env, (coins * 400n) / ppm)
        take(await poke(env))
        return { env, players, draws, expected }
    }

    it('every player’s expected prize over the pots is the same with and without the placed boundary', async () => {
        const plain = await world(false)
        const placed = await world(true)
        const tickets = async (w: typeof plain, i: number) => {
            const j = await jgramOf(w.env, w.players[i].address)
            return j
        }
        const total = (w: typeof plain) => w.draws.reduce((a, d) => a + d.prizes, 0n)
        // the sum of all prizes over the pots is the same yield, less the burn on each pot, to within the burn rounding
        // (the placed world pays out the gift's share too): compare each player's share of the pots, in fractions
        for (let i = 0; i < 3; i++) {
            const share = async (w: typeof plain) => {
                const t = await tickets(w, i)
                return w.draws.reduce((a, d) => a + (d.prizes * t * 10n ** 12n) / d.tickets, 0n)
            }
            const a = await share(plain)
            const b = await share(placed)
            // the placed world has the gift's yield on top, so its expected prize is at least the plain one and at most the
            // plain one plus the gift's share of the pot: nobody's share of the pot changes
            const ta = total(plain)
            const tb = total(placed)
            expect(tb).toBeGreaterThanOrEqual(ta)
            // each player's fraction of the pots' prizes is the same: share / total
            const fa = (a * 10n ** 9n) / ta
            const fb = (b * 10n ** 9n) / tb
            expect(fa > fb ? fa - fb : fb - fa).toBeLessThanOrEqual(20n)
        }
        // the sampled mean of the first placed draw agrees with its expected value
        const seeds = seedsOf('PLACED_SEEDS', 6)
        const d0 = placed.draws[0]
        let sum = 0
        let sq = 0
        const [tc, tt] = await placed.env.hipo.quote()
        for (let s = 0; s < seeds; s++) {
            await placed.env.blockchain.loadFrom(d0.snap)
            const r = await submitDraw(placed.env, s)
            const won = slotsIn(r)
                .filter((x: SlotLog) => x.result === SlotResult.hit && x.owner?.toString() === placed.players[0].address.toString())
                .reduce((acc, x) => acc + x.amount, 0n)
            const g = Number((won * tc) / tt) / 1e9
            sum += g
            sq += g * g
        }
        const mean = sum / seeds
        const se = Math.sqrt(Math.max(sq / seeds - mean * mean, 0) / seeds)
        const expectedGram = Number((d0.prizes * 600n * 10n ** 9n * tc) / (d0.tickets * tt)) / 1e9
        expect(Math.abs(mean - expectedGram)).toBeLessThanOrEqual(5 * se + expectedGram * 0.02 + 1e-6)
    }, 900000)
})

describe('Chains', () => {
    // the messages of a user chain, in order, as [op, sender, receiver] by role
    const hipoOps = { receiveTokens: 0x178d4519 }
    async function chainOf(
        env: Awaited<ReturnType<typeof fresh>>['env'],
        who: Address,
        r: SendMessageResult,
        keep: number[],
    ) {
        const names = new Map<string, string>([
            [who.toString(), 'player'],
            [(await env.hipo.walletAddress(who)).toString(), 'playerHgram'],
            [walletAt(env, who).address.toString(), 'playerJgram'],
            [env.jackpot.address.toString(), 'jackpot'],
            [(await env.jackpot.getAddresses()).wallet.toString(), 'jackpotHgram'],
        ])
        const out: [number, string, string][] = []
        for (const tx of r.transactions) {
            const info = tx.inMessage?.info
            if (info?.type !== 'internal') continue
            const op = opOf(tx)
            const o = op ?? -1
            if (!keep.includes(o)) continue
            out.push([o, names.get(info.src.toString()) ?? '?', names.get(info.dest.toString()) ?? '?'])
        }
        return out
    }
    const J = JackpotOp
    const keep = [J.sendTokens, hipoOps.receiveTokens, J.transferNotification, J.prepareDeposit, J.depositReady, J.depositBooked, J.burn, J.burnNotification, J.provideCurrentQuote, 0]

    it('a deposit’s chain is, message for message, the transfer, its notification, prepare_deposit, deposit_ready, deposit_booked; it sends no quote', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000') })
        const { env, players } = sc
        const r = (await depositHgram(env, players[0], G('100'))).result
        expect(await chainOf(env, players[0].address, r, keep)).toEqual([
            [J.sendTokens, 'player', 'playerHgram'],
            [hipoOps.receiveTokens, 'playerHgram', 'jackpotHgram'],
            [J.transferNotification, 'jackpotHgram', 'jackpot'],
            [J.prepareDeposit, 'jackpot', 'playerJgram'],
            [J.depositReady, 'playerJgram', 'jackpot'],
            [J.depositBooked, 'jackpot', 'playerJgram'],
        ])
        expect(r.transactions.some((t) => opOf(t) === J.provideCurrentQuote)).toBe(false)
    }, 200000)

    it('a withdrawal’s chain is burn, burn_notification, the payout; a `w` adds the comment first; neither sends a quote', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const { env, players } = sc
        await put(env, players[0], G('100'))
        await put(env, players[1], G('100'))
        const burn = await withdraw(env, players[0], G('40'))
        expect(await chainOf(env, players[0].address, burn, keep)).toEqual([
            [J.burn, 'player', 'playerJgram'],
            [J.burnNotification, 'playerJgram', 'jackpot'],
            [J.sendTokens, 'jackpot', 'jackpotHgram'],
            [hipoOps.receiveTokens, 'jackpotHgram', 'playerHgram'],
        ])
        const w = await env.jackpot.sendComment(players[1].getSender(), { value: env.fees.commentWithdraw, text: 'w' })
        expect(await chainOf(env, players[1].address, w, keep)).toEqual([
            [0, 'player', 'jackpot'],
            [J.burn, 'jackpot', 'playerJgram'],
            [J.burnNotification, 'playerJgram', 'jackpot'],
            [J.sendTokens, 'jackpot', 'jackpotHgram'],
            [hipoOps.receiveTokens, 'jackpotHgram', 'playerHgram'],
            [J.transferNotification, 'playerHgram', 'player'],
        ])
        for (const r of [burn, w]) expect(r.transactions.some((t) => opOf(t) === J.provideCurrentQuote)).toBe(false)
    }, 200000)
})

describe('Bounce formats', () => {
    it('every bounceable message the Jackpot and the wallet send carries extra_flags = 3, in one flow that produces each kind', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 3, mint: G('2000'), float: G('7.5') })
        const { env, players } = sc
        const wallets = new Set([env.jackpot.address.toString(), ...players.map((p) => walletAt(env, p.address).address.toString())])
        const seen = new Map<number, number>()
        const scan = (r: SendMessageResult) => {
            for (const tx of r.transactions) {
                for (const m of tx.outMessages.values()) {
                    if (m.info.type !== 'internal' || !wallets.has(m.info.src.toString())) continue
                    if (!m.info.bounce) continue
                    const op = m.body.beginParse().remainingBits >= 32 ? m.body.beginParse().loadUint(32) : -1
                    seen.set(op, (seen.get(op) ?? 0) + 1)
                    expect(m.info.ihrFee).toBe(3n) // extra_flags = 3: a full-body bounce
                }
            }
        }
        await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
        scan((await depositHgram(env, players[0], G('300'))).result) // prepare_deposit, deposit_booked
        scan((await depositHgram(env, players[1], G('100'), { minC: G('9999') })).result) // a refusal: deposit_cancelled
        scan((await depositHgram(env, players[2], G('100'))).result)
        scan(await toBoundary(env, G('40'))) // provide_current_quote and, below float_low, unstake_tokens
        scan(await env.jackpot.sendProvideWalletAddress(players[0].getSender(), { value: G('0.1'), owner: players[1].address, includeAddress: true })) // take_wallet_address
        scan(await withdraw(env, players[0], G('50'))) // burn_notification
        scan(await withdraw(env, players[0], 0n)) // burn_notification with last: close_wallet
        scan(await env.jackpot.sendComment(players[1].getSender(), { value: env.fees.commentWithdraw, text: 'w' })) // the burn of a w
        const fake = await env.blockchain.treasury('fake-wallet')
        scan(
            await deliver(
                env,
                messageFrom(fake.address, env.jackpot.address, G('0.1'), beginCell().storeUint(JackpotOp.transferNotification, 32).storeUint(0, 64).storeCoins(1n).storeAddress(players[0].address).storeBit(false).endCell(), false),
            ),
        ) // a foreign return
        scan(await env.jackpot.sendRescueJetton(env.governor.getSender(), { value: G('0.1'), jettonWallet: fake.address, amount: 1n, destination: players[0].address }))
        scan(await env.jackpot.sendRescueNft(env.governor.getSender(), { value: G('0.1'), nft: fake.address, destination: players[0].address }))
        const kinds = [JackpotOp.prepareDeposit, JackpotOp.depositBooked, JackpotOp.depositCancelled, JackpotOp.provideCurrentQuote, JackpotOp.unstakeTokens, JackpotOp.takeWalletAddress, JackpotOp.burnNotification, JackpotOp.closeWallet, JackpotOp.burn, JackpotOp.sendTokens, JackpotOp.nftTransfer]
        for (const k of kinds) expect(seen.get(k)).toBeGreaterThan(0)
    }, 600000)
})

describe('Gas returned', () => {
    // The value a message brings above its fee comes back to the sender: sending 1 GRAM more costs the sender no more than
    // 0.002 GRAM more, and the sender never spends more than the fee plus that.
    const tolerance = G('0.002')
    async function returned(
        env: Awaited<ReturnType<typeof fresh>>['env'],
        who: { address: Address },
        fee: bigint,
        send: (value: bigint) => Promise<unknown>,
        gains = 0n,
    ) {
        const snap = env.blockchain.snapshot()
        const spend = async (value: bigint) => {
            await env.blockchain.loadFrom(snap)
            const b0 = await balanceOf(env, who.address)
            await send(value)
            return b0 - (await balanceOf(env, who.address))
        }
        const exact = await spend(fee)
        const rich = await spend(fee + G('1'))
        expect(rich - exact).toBeLessThanOrEqual(tolerance)
        expect(exact + gains).toBeLessThanOrEqual(fee + tolerance)
    }

    it('`w`, a poke, a submit, a refill and TEP-89 each return the value less their fee, within 0.002 GRAM', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000'), float: G('3.5') })
        const { env, players } = sc
        await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
        await put(env, players[0], G('300'))
        await put(env, players[1], G('100'))
        await returned(env, players[1], env.fees.commentWithdraw, (value) =>
            env.jackpot.sendComment(players[1].getSender(), { value, text: 'w' }),
        )
        await returned(env, env.keeper, env.fees.poke, (value) => poke(env, value))
        await returned(env, players[0], 2n * G('0.02'), (value) =>
            env.jackpot.sendProvideWalletAddress(players[0].getSender(), { value, owner: players[0].address, includeAddress: false }),
        )
        await returned(env, env.keeper, env.fees.refill, (value) => env.jackpot.sendRefill(env.keeper.getSender(), { value }))
        // a submit: the keeper is paid the reward on top
        await env.hipo.raiseRate(G('40'))
        await toBoundary(env, 0n)
        const d = await env.jackpot.getDrawState()
        expect(d.state).toBe(DrawState.waiting)
        const { submitTest } = await import('./jackpot/setup')
        await returned(env, env.keeper, env.fees.submit, (value) => submitTest(env, Number(d.round), value), G('0.02'))
    }, 600000)
})

// A bounce as the network makes it for a message sent with extra_flags = 3: the whole original body in a reference
function bounceOf(from: Address, to: Address, value: bigint, original: Cell) {
    const m = messageFrom(from, to, value, beginCell().storeUint(0xfffffffe, 32).storeRef(original).endCell(), false)
    return { ...m, info: { ...(m.info as object), bounced: true } as typeof m.info }
}

async function freeze(env: Awaited<ReturnType<typeof fresh>>['env'], addr: Address) {
    const acc = (await env.blockchain.getContract(addr)).account
    const state = acc.account!.storage.state
    if (state.type !== 'active') throw new Error('not active')
    const init = beginCell().storeUint(6, 5).storeRef(state.state.code!).storeRef(state.state.data!).endCell()
    await env.blockchain.setShardAccount(addr, {
        ...acc,
        account: {
            ...acc.account!,
            storage: { ...acc.account!.storage, state: { type: 'frozen', stateHash: BigInt('0x' + init.hash().toString('hex')) } },
        },
    })
    return { code: state.state.code!, data: state.state.data! }
}

describe('Bounced deposit_booked', () => {
    it('after the undo the wallet gets deposit_cancelled and its pending returns to what it was; a new wallet is not left opening and can take the next deposit', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const { env, players } = sc
        const [alice, bob] = players
        await put(env, alice, G('100'))
        const s0 = await jackpotState(env)
        // Bob's first deposit, held after the Jackpot booked it: deposit_booked is on its way to his new wallet
        const wallet = walletAt(env, bob.address).address
        const { startDeposit } = await import('./jackpot/scenario')
        const outs = await startDeposit(env, bob, G('50'), (tx) => tx.inMessage?.info.dest?.toString() === env.jackpot.address.toString() && opOf(tx) === JackpotOp.depositReady)
        const booked = outs.find((m) => m.info.dest?.toString() === wallet.toString() && m.body.beginParse().preloadUint(32) === JackpotOp.depositBooked)!
        expect(booked).toBeDefined()
        expect(await walletAt(env, bob.address).getWalletState()).toMatchObject({ pending: 1n, balance: 0n })
        expect((await jackpotState(env)).principal).toBeGreaterThan(s0.principal)
        // the wallet cannot take it: the bounce comes back to the Jackpot
        const r = await env.blockchain.sendMessage(bounceOf(wallet, env.jackpot.address, G('0.3'), booked.body))
        expectChainSucceeded(r)
        expect(r.transactions).toHaveTransaction({ from: env.jackpot.address, to: wallet })
        expect(r.transactions.some((t) => t.inMessage?.info.dest?.toString() === wallet.toString() && opOf(t) === JackpotOp.depositCancelled)).toBe(true)
        const s1 = await jackpotState(env)
        expect([s1.principal, s1.tickets]).toEqual([s0.principal, s0.tickets])
        // pending is back to 0 (the wallet had nothing and closed, so it is not left opening)
        const w = await env.blockchain.getContract(wallet)
        if (w.accountState?.type === 'active') expect((await walletAt(env, bob.address).getWalletState()).pending).toBe(0n)
        // and Bob can deposit again
        const again = await depositHgram(env, bob, G('20'))
        expect(again.booking).toBeDefined()
        await expectSolvent(env)
    }, 300000)
})

describe('Failures, row by row', () => {
    it('A poke’s provide_current_quote bounces: the rest goes to the poker, no counter changes', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000'), fake: true })
        const { env, players } = sc
        await put(env, players[0], G('100'))
        const s0 = await jackpotState(env)
        const b0 = await env.jackpot.getBoundary()
        const { createEmptyShardAccount } = await import('@ton/sandbox')
        await env.blockchain.setShardAccount(sc.fake!.address, createEmptyShardAccount(sc.fake!.address))
        const k0 = await balanceOf(env, env.keeper.address)
        const r = await poke(env, G('0.5'))
        expect(r.transactions).toHaveTransaction({ from: sc.fake!.address, to: env.jackpot.address, inMessageBounced: true })
        expect(r.transactions).toHaveTransaction({ from: env.jackpot.address, to: env.keeper.address })
        expect(await jackpotState(env)).toEqual(s0)
        expect(await env.jackpot.getBoundary()).toEqual(b0)
        expect(k0 - (await balanceOf(env, env.keeper.address))).toBeLessThan(G('0.1'))
    }, 100000)

    it('A poke’s quote gets no reply: nothing changes, the GRAM stays at the treasury', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000'), fake: true })
        const { env, players } = sc
        await put(env, players[0], G('100'))
        const s0 = await jackpotState(env)
        const t0 = await balanceOf(env, sc.fake!.address)
        const r = await poke(env, G('0.5'))
        expect(r.transactions).toHaveTransaction({ from: env.jackpot.address, to: sc.fake!.address })
        expect(await jackpotState(env)).toEqual(s0)
        expect(await balanceOf(env, sc.fake!.address)).toBeGreaterThan(t0)
    }, 100000)

    it('prepare_deposit bounces: a frozen wallet; deposit_tokens go back to the response destination, incoming_tokens returns to 0, the payout lowers held_tokens', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000') })
        const { env, players } = sc
        await put(env, players[0], G('100'))
        const s0 = await jackpotState(env)
        const h = await hgramOf(env, players[0].address)
        await freeze(env, walletAt(env, players[0].address).address)
        const dep = await depositHgram(env, players[0], G('30'))
        expect(dep.booking).toBeUndefined()
        const note = notificationsTo(dep.result, players[0].address)[0]
        expect(commentOf(note.payload)).toBe('Hipo Jackpot: deposit returned (your Jackpot wallet could not take it)')
        expect(await hgramOf(env, players[0].address)).toBe(h)
        const s1 = await jackpotState(env)
        expect([s1.incomingTokens, s1.heldTokens, s1.principal]).toEqual([0n, s0.heldTokens, s0.principal])
    }, 200000)

    it('deposit_ready fails at the Jackpot: hGRAM stays in held_tokens and incoming_tokens, the wallet lowers pending, return_tokens(…, true) recovers it', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000'), failReady: true })
        const { env, players } = sc
        const h = await hgramOf(env, players[0].address)
        const dep = await depositHgram(env, players[0], G('100'))
        expect(dep.booking).toBeUndefined()
        const s = await jackpotState(env)
        expect([s.incomingTokens, s.heldTokens, s.principal]).toEqual([G('100'), G('100'), 0n])
        const w = await env.blockchain.getContract(walletAt(env, players[0].address).address)
        expect(w.accountState?.type).not.toBe('active') // pending lowered, the empty wallet closed
        expectChainSucceeded(await env.jackpot.sendReturnTokens(env.governor.getSender(), { value: G('0.3'), owner: players[0].address, amount: G('100'), inFlight: true }))
        expect(await hgramOf(env, players[0].address)).toBe(h)
        expect((await jackpotState(env)).incomingTokens).toBe(0n)
    }, 200000)

    it('deposit_booked bounces: see "Bounced deposit_booked" above (the undo, deposit_cancelled, the refund at the stored rate)', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000') })
        const { env, players } = sc
        await put(env, players[0], G('100'))
        // a hand-made bounce for the booking: principal and tickets leave, the refund is paid at the stored rate
        const s0 = await jackpotState(env)
        const wallet = walletAt(env, players[0].address).address
        const reply = beginCell().storeAddress(players[0].address).storeAddress(players[0].address).storeCoins(1n).storeMaybeRef(null).endCell()
        const original = beginCell().storeUint(JackpotOp.depositBooked, 32).storeUint(5, 64).storeCoins(G('10')).storeUint(0, 32).storeRef(reply).endCell()
        const h = await hgramOf(env, players[0].address)
        expectChainSucceeded(await env.blockchain.sendMessage(bounceOf(wallet, env.jackpot.address, G('0.4'), original)))
        const s1 = await jackpotState(env)
        expect(s1.principal).toBe(s0.principal - G('10'))
        expect((await hgramOf(env, players[0].address)) - h).toBe((G('10') * s0.quoteTokens) / s0.quoteCoins)
    }, 200000)

    it('burn_notification fails at the Jackpot: nothing changes there, the wallet restores the amount', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000') })
        const { env, players } = sc
        const [alice] = players
        await put(env, alice, G('100'))
        const s0 = await jackpotState(env)
        const w = walletAt(env, alice.address)
        const [note] = await holdUntil(
            env,
            messageFrom(alice.address, w.address, env.fees.withdraw, beginCell().storeUint(JackpotOp.burn, 32).storeUint(7, 64).storeCoins(0n).storeAddress(null).storeMaybeRef(null).endCell()),
            toAddr(w.address),
        )
        const poor = { ...note, info: { ...(note.info as object), value: { coins: G('0.03') } } as typeof note.info }
        const r = await env.blockchain.sendMessage(poor)
        expect(r.transactions).toHaveTransaction({ from: w.address, to: env.jackpot.address, success: false })
        expect(await w.getWalletState()).toMatchObject({ balance: G('100'), pending: 0n })
        expect(await jackpotState(env)).toEqual(s0)
    }, 200000)

    it('A self-recovery’s refund cannot be paid from the bounced value: the refund’s tokens leave the count, untracked, with an untracked log; return_tokens recovers them', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const { env, players } = sc
        const [alice, bob] = players
        await put(env, alice, G('100'))
        const wallet = walletAt(env, bob.address).address
        const { startDeposit } = await import('./jackpot/scenario')
        const outs = await startDeposit(env, bob, G('40'), (tx) => tx.inMessage?.info.dest?.toString() === env.jackpot.address.toString() && opOf(tx) === JackpotOp.transferNotification)
        const prepare = outs.find((m) => m.info.dest?.toString() === wallet.toString())!
        expect((await jackpotState(env)).incomingTokens).toBe(G('40'))
        const h = await hgramOf(env, bob.address)
        const held0 = (await jackpotState(env)).heldTokens
        // the bounce comes back with too little value to pay the refund
        const r = await env.blockchain.sendMessage(bounceOf(wallet, env.jackpot.address, G('0.01'), prepare.body))
        const [log] = logsOf<UntrackedLog>(r.externals, LogTopic.untracked)
        expect(log.tokens).toBe(G('40'))
        const s = await jackpotState(env)
        expect([s.incomingTokens, s.heldTokens]).toEqual([0n, held0 - G('40')])
        expect(await hgramOf(env, bob.address)).toBe(h) // nothing paid
        expectChainSucceeded(await env.jackpot.sendReturnTokens(env.governor.getSender(), { value: G('0.3'), owner: bob.address, amount: G('40') }))
        expect(await hgramOf(env, bob.address)).toBe(h + G('40'))
    }, 200000)

    it('`w` to a frozen jGRAM wallet: the value stays in the float; revive the wallet, then withdraw', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const { env, players } = sc
        const [alice, other] = players
        await put(env, alice, G('100'))
        const addr = walletAt(env, alice.address).address
        const last = await freeze(env, addr)
        const s0 = await jackpotState(env)
        const f0 = await balanceOf(env, env.jackpot.address)
        const r = await env.jackpot.sendComment(alice.getSender(), { value: env.fees.commentWithdraw, text: 'w' })
        expect(r.transactions).toHaveTransaction({ from: addr, to: env.jackpot.address, inMessageBounced: true })
        expect(await jackpotState(env)).toEqual(s0)
        expect(await balanceOf(env, env.jackpot.address)).toBeGreaterThanOrEqual(f0)
        // revive with its exact state, then a w works
        await env.blockchain.sendMessage({ ...messageFrom(other.address, addr, G('0.5'), beginCell().endCell(), false), init: { code: last.code, data: last.data } })
        const h = await hgramOf(env, alice.address)
        expectChainSucceeded(await env.jackpot.sendComment(alice.getSender(), { value: env.fees.commentWithdraw, text: 'w' }))
        expect(await hgramOf(env, alice.address)).toBe(h + G('100'))
    }, 200000)

    it('unstake_tokens bounces: held_tokens += u and unstaking_tokens -= u', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000') })
        const { env, players } = sc
        await put(env, players[0], G('100'))
        const { setUnstaking } = await import('./jackpot/scenario')
        await setUnstaking(env, G('3'))
        const s0 = await jackpotState(env)
        const hw = (await env.jackpot.getAddresses()).wallet
        const original = beginCell().storeUint(JackpotOp.unstakeTokens, 32).storeUint(9, 64).storeCoins(G('3')).storeUint(0, 2).storeUint(0, 1).endCell()
        expectChainSucceeded(await env.blockchain.sendMessage(bounceOf(hw, env.jackpot.address, G('0.1'), original)))
        const s1 = await jackpotState(env)
        expect([s1.heldTokens, s1.unstakingTokens]).toEqual([s0.heldTokens + G('3'), 0n])
    }, 100000)

    it('deposit_cancelled, close_wallet or take_wallet_address bounces: the GRAM stays in the float, no counter changes', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000') })
        const { env, players } = sc
        await put(env, players[0], G('100'))
        const wallet = walletAt(env, players[0].address).address
        for (const op of [JackpotOp.depositCancelled, JackpotOp.closeWallet, JackpotOp.takeWalletAddress]) {
            const s0 = await jackpotState(env)
            const f0 = await balanceOf(env, env.jackpot.address)
            const original = beginCell().storeUint(op, 32).storeUint(1, 64).endCell()
            await env.blockchain.sendMessage(bounceOf(wallet, env.jackpot.address, G('0.05'), original))
            expect(await jackpotState(env)).toEqual(s0)
            expect(await balanceOf(env, env.jackpot.address)).toBeGreaterThan(f0)
        }
    }, 100000)
})

describe('The rate cancels (exact fractions)', () => {
    it('booked_principal moves by at most 2 + booked/free nano when the stored rate is half to twice the true one, and the expected prize minus the price is the same, in exact bigint fractions', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000'), fake: true })
        const { env, players } = sc
        const [alice, bob] = players
        await put(env, alice, G('100')) // P = 100 GRAM at the deploy rate
        const base = env.blockchain.snapshot()
        const t = G('50')
        const P = G('100')
        const F = (await jackpotState(env)).heldTokens
        const SC = 10n ** 30n
        // Hipo's true rate is 1.5; the stored rate is 0.75 .. 3: half to twice
        const trueTC = 150n
        const trueTT = 100n
        const rows: { c: bigint; gain: bigint }[] = []
        for (const [tc, tt] of [
            [105n, 100n],
            [150n, 100n],
            [210n, 100n],
        ]) {
            await env.blockchain.loadFrom(base)
            await pokeFake(sc, tc * 10n ** 9n, tt * 10n ** 9n)
            const dep = await depositHgram(env, bob, t, { minC: 0n })
            const c = dep.booking!.principal
            // the true price in hGRAM and the true pot in hGRAM, as fractions scaled by 10^30
            const priceS = t * SC - (c * trueTT * SC) / trueTC
            const potS = F * SC - (P * trueTT * SC) / trueTC
            const prizeS = (c * 9000n * (potS + priceS)) / (10000n * (P + c)) // (1 - 10% burn) of the pot, the deposit's share
            rows.push({ c, gain: prizeS - priceS })
        }
        const mid = rows[1]
        for (const x of rows) {
            const dc = x.c > mid.c ? x.c - mid.c : mid.c - x.c
            expect(dc).toBeLessThanOrEqual(2n * (2n + x.c / F + 1n))
            // one nano of principal moves the gain by at most 2 nano-hGRAM: the gains agree to that rounding
            const dg = x.gain > mid.gain ? x.gain - mid.gain : mid.gain - x.gain
            expect(dg).toBeLessThanOrEqual((dc + 1n) * 2n * SC)
            // and each is the t·P/F of the formula to within the rounding term
            const d = x.c > t ? x.c - t : t - x.c
            expect(d).toBeLessThanOrEqual(2n + x.c / F + 1n)
        }
    }, 300000)
})

describe('`w` with an empty comment', () => {
    it('is a top-up: nothing else happens', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000') })
        const { env, players } = sc
        await put(env, players[0], G('100'))
        const s0 = await jackpotState(env)
        const f0 = await balanceOf(env, env.jackpot.address)
        const r = await env.jackpot.sendComment(players[0].getSender(), { value: G('0.05'), text: '' })
        expectChainSucceeded(r)
        const tx = r.transactions.find((t) => t.inMessage?.info.dest?.toString() === env.jackpot.address.toString())!
        expect(tx.outMessages.size).toBe(0)
        expect(await jackpotState(env)).toEqual(s0)
        // the message's value, less the gas of its own transaction
        expect(await balanceOf(env, env.jackpot.address)).toBe(f0 + G('0.05') - tx.totalFees.coins)
    }, 100000)
})

describe('The end of the tree', () => {
    const retire = (env: Awaited<ReturnType<typeof fresh>>['env']) => env.jackpot.sendRetire(env.governor.getSender(), { value: G('0.05') })

    it('sweep returns exactly the excess to its sender: a sweep with 1 GRAM more costs the sender no more, to the nano-GRAM', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('10') })
        const { env } = sc
        await retire(env)
        const { buildTree } = await import('./jackpot/scenario')
        await buildTree(env, 65)
        const need = await sweepValue(env)
        const snap = env.blockchain.snapshot()
        const spend = async (value: bigint) => {
            await env.blockchain.loadFrom(snap)
            const b0 = await balanceOf(env, env.governor.address)
            expectChainSucceeded(await env.jackpot.sendSweep(env.governor.getSender(), { value }))
            return b0 - (await balanceOf(env, env.governor.address))
        }
        const exact = await spend(need)
        const rich = await spend(need + G('1'))
        expect(rich).toBe(exact)
    }, 300000)

    it('a node with a non-zero child sum, set by hand, refuses close_node and keeps its subtree; the rest of the tree still closes', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('10') })
        const { env } = sc
        await retire(env)
        const { buildTree } = await import('./jackpot/scenario')
        await buildTree(env, 65) // leaves (1,0) and (1,1), then (2,0), (3,0), (4,0)
        // a sum of 5 at leaf (1,0), put there by its parent's address
        const leaf = nodeAt(env, 1, 0n)
        const parent = nodeAt(env, 2, 0n).address
        const body = beginCell().storeUint(JackpotOp.update, 32).storeUint(0, 64).storeUint(1, 32).storeUint(0, 32).storeInt(5, 128).storeBit(false).endCell()
        await env.blockchain.sendMessage(messageFrom(parent, leaf.address, G('1'), body, false))
        expectChainSucceeded(await env.jackpot.sendSweep(env.governor.getSender(), { value: await sweepValue(env) }))
        const active = async (level: number, index: bigint) => (await env.blockchain.getContract(nodeAt(env, level, index).address)).accountState?.type === 'active'
        expect(await active(1, 0n)).toBe(true) // refused, keeps itself
        expect(await active(1, 1n)).toBe(false)
        expect(await active(2, 0n)).toBe(false)
        expect(await active(3, 0n)).toBe(false)
        expect(await active(4, 0n)).toBe(false)
    }, 300000)

    it('swept: after the sweep, withdraw_surplus leaves exactly 1 GRAM', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('10'), float: G('40') })
        const { env } = sc
        await retire(env)
        expectChainSucceeded(await env.jackpot.sendSweep(env.governor.getSender(), { value: await sweepValue(env) }))
        expect((await env.jackpot.getRetirement()).retired).toBe(true)
        expectChainSucceeded(await env.jackpot.sendWithdrawSurplus(env.governor.getSender(), { value: G('0.05') }))
        expect(await balanceOf(env, env.jackpot.address)).toBe(G('1'))
    }, 100000)

    it('Order: a burn and a sweep in one queue: the update reaches every node on its path before close_node, so the whole tree closes', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000') })
        const { env, players } = sc
        const [alice] = players
        await put(env, alice, G('100'))
        await retire(env)
        const burn = messageFrom(alice.address, walletAt(env, alice.address).address, env.fees.withdraw, beginCell().storeUint(JackpotOp.burn, 32).storeUint(0, 64).storeCoins(0n).storeAddress(null).storeMaybeRef(null).endCell())
        const sweepValueNow = env.fees.sweep + (await env.jackpot.getCloseCost())
        const sweep = messageFrom(env.governor.address, env.jackpot.address, sweepValueNow + G('0.5'), beginCell().storeUint(JackpotOp.sweep, 32).storeUint(0, 64).endCell())
        const queue = (env.blockchain as unknown as { defaultQueueManager: { messageQueue: unknown[] } }).defaultQueueManager.messageQueue
        const txs: BlockchainTransaction[] = []
        let pushed = false
        for await (const tx of await env.blockchain.sendMessageIter(burn)) {
            txs.push(tx)
            // the Jackpot has just handled burn_notification and sent the update: the sweep joins the queue behind it
            if (!pushed && tx.inMessage?.info.dest?.toString() === env.jackpot.address.toString() && opOf(tx) === JackpotOp.burnNotification) {
                queue.push({ type: 'message', ...sweep })
                pushed = true
            }
        }
        expect(pushed).toBe(true)
        // at every node the update came before the close, and every node is gone
        for (let level = 1; level <= 4; level++) {
            const addr = nodeAt(env, level, 0n).address
            const mine = txs.filter((t) => t.inMessage?.info.dest?.toString() === addr.toString())
            const u = mine.find((t) => opOf(t) === JackpotOp.update)!
            const c = mine.find((t) => opOf(t) === JackpotOp.closeNode)!
            expect(u.lt).toBeLessThan(c.lt)
            expect((await env.blockchain.getContract(addr)).accountState?.type).not.toBe('active')
        }
    }, 300000)
})

describe('Split, to the nano-GRAM', () => {
    // The prices of the sandbox's config: gas (21) and forwarding (25) of the basechain
    function prices(env: Awaited<ReturnType<typeof fresh>>['env']) {
        const config = Dictionary.loadDirect(Dictionary.Keys.BigInt(32), Dictionary.Values.Cell(), env.blockchain.config)
        const g = config.get(21n)!.beginParse()
        g.loadUint(8)
        const flatLimit = g.loadUintBig(64)
        const flatPrice = g.loadUintBig(64)
        g.loadUint(8)
        const gasPrice = g.loadUintBig(64)
        const f = config.get(25n)!.beginParse()
        f.loadUint(8)
        const lump = f.loadUintBig(64)
        const bitPrice = f.loadUintBig(64)
        const cellPrice = f.loadUintBig(64)
        const ceil16 = (x: bigint) => (x + 65535n) >> 16n
        const gasFee = (gas: bigint) => (gas <= flatLimit ? flatPrice : flatPrice + ceil16(gasPrice * (gas - flatLimit)))
        const fwdFee = (cells: bigint, bits: bigint) => lump + ceil16(bitPrice * bits + cellPrice * cells)
        return { gasFee, fwdFee, lump }
    }

    it('each child’s share is recomputed from the config’s gas and forwarding prices: (value − (term − fwd)) · cost_child / Σ cost, to the nano-GRAM; close_cost(n) is the top node’s cost times the margin', async () => {
        const constants = readFileSync('contracts/imports/constants.fc', 'utf8')
        const constant = (name: string) => BigInt(new RegExp(`const int ${name} = (\\d+);`).exec(constants)![1])
        const gas1 = constant('close::gas_1')
        const gasInner = constant('close::gas_inner')
        const marginNum = constant('close::margin_num')
        const marginDen = constant('close::margin_den')
        for (const n of [65, 4097, 5000]) {
            const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('10') })
            const { env } = sc
            await env.jackpot.sendRetire(env.governor.getSender(), { value: G('0.05') })
            const { buildTree } = await import('./jackpot/scenario')
            const list = await buildTree(env, n)
            const { gasFee, fwdFee } = prices(env)
            const fwd = fwdFee(2n, 1023n) // the estimate the contract uses
            const t1 = gasFee(gas1) + fwd
            const ti = gasFee(gasInner) + fwd
            const span = (level: number) => 64n ** BigInt(level)
            const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b
            const cost = (level: number, index: bigint) => {
                const base = index * span(level)
                const top = BigInt(n) < (index + 1n) * span(level) ? BigInt(n) : (index + 1n) * span(level)
                const sp = top > base ? top - base : 0n
                let c = ceilDiv(sp, 64n) * t1
                for (let l = 2; l <= level; l++) c += ceilDiv(sp, span(l)) * ti
                return c
            }
            // close_cost(n) = the top node's cost times the margin, rounded up
            const want = (cost(4, 0n) * marginNum + marginDen - 1n) / marginDen
            expect(await env.jackpot.getCloseCost()).toBe(want)
            const r = await env.jackpot.sendSweep(env.governor.getSender(), { value: env.fees.sweep + want })
            expectChainSucceeded(r)
            const byAddress = new Map(list.map((x) => [nodeAt(env, x.level, BigInt(x.index)).address.toString(), x] as const))
            let checked = 0
            const diffs = new Set<bigint>()
            for (const tx of r.transactions) {
                const info = tx.inMessage?.info
                if (info?.type !== 'internal' || opOf(tx) !== JackpotOp.closeNode) continue
                const me = byAddress.get(info.dest.toString())
                if (me == null || me.level === 1) continue
                const kids = [...tx.outMessages.values()].filter((m) => m.info.type === 'internal' && byAddress.has(m.info.dest.toString()))
                const costs = kids.map((m) => {
                    const k = byAddress.get((m.info as { dest: Address }).dest.toString())!
                    return cost(k.level, BigInt(k.index))
                })
                const sum = costs.reduce((a, x) => a + x, 0n)
                const keep = (me.level === 1 ? t1 : ti) - fwd
                const value = info.value.coins
                kids.forEach((m, j) => {
                    const got = (m.info as { value: { coins: bigint } }).value.coins
                    const share = ((value - keep) * costs[j]) / sum
                    // mode 0: the forwarding of the message comes out of the share; the real message is all in one cell
                    expect(got + 1n).toBeGreaterThan(share - 2n * fwd) // never below the share less the forwarding
                    expect(got).toBeLessThanOrEqual(share)
                    diffs.add(share - got)
                    checked++
                })
            }
            expect(checked).toBeGreaterThan(0)
            // every share arrives exactly as computed less one constant: the forwarding of the one-cell message
            expect(diffs.size).toBe(1)
        }
    }, 900000)
})
