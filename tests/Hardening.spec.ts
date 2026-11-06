/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests read state they just made */
// The fix round after the audits, in the amended design: one query_id used by many messages, and the wallet that must
// not close while a full burn is in flight. The v2 parts about record ids, set_period, claim and the tick are gone with
// the records and the clock.
import '@ton/test-utils'
import { Cell, beginCell, toNano } from '@ton/core'
import { JackpotOp } from '../wrappers/Jackpot'
import { expectChainSucceeded, hgramOf, jackpotState, jgramOf, messageFrom, walletAt } from './jackpot/setup'
import { atJackpot, deliver, fresh, holdUntil, put, startDeposit, toAddr } from './jackpot/scenario'

const G = (n: string | number) => toNano(String(n))

const burnBody = (qid: bigint, x: bigint): Cell =>
    beginCell()
        .storeUint(JackpotOp.burn, 32)
        .storeUint(qid, 64)
        .storeCoins(x)
        .storeAddress(null)
        .storeMaybeRef(null)
        .endCell()

describe('Fix 1: one query_id, many messages', () => {
    it('two players burning under the same query_id 0, overlapping, are each paid once', async () => {
        const sc = await fresh({ players: 2, minDeposit: 1n })
        const {
            env,
            players: [a, b],
        } = sc
        await put(env, a, G('1000'))
        await put(env, b, G('1000'))
        const a0 = await hgramOf(env, a.address)
        const b0 = await hgramOf(env, b.address)
        for (const p of [a, b]) {
            await walletAt(env, p.address).sendBurn(p.getSender(), {
                value: env.fees.withdraw,
                amount: 0n,
                queryId: 0n,
            })
        }
        expect(await hgramOf(env, a.address)).toBe(a0 + G('1000'))
        expect(await hgramOf(env, b.address)).toBe(b0 + G('1000'))
        const s = await jackpotState(env)
        expect([s.principal, s.tickets, s.heldTokens]).toEqual([0n, 0n, 0n])
    }, 200000)

    it('the same owner burning twice under one query_id is paid both times', async () => {
        const sc = await fresh({ players: 1, minDeposit: 1n })
        const {
            env,
            players: [a],
        } = sc
        await put(env, a, G('1000'))
        const a0 = await hgramOf(env, a.address)
        for (const amount of [G('10'), G('20')]) {
            await walletAt(env, a.address).sendBurn(a.getSender(), { value: env.fees.withdraw, amount, queryId: 5n })
        }
        expect(await hgramOf(env, a.address)).toBe(a0 + G('30'))
    }, 200000)

    it('two deposits under one query_id, both in flight, are both booked', async () => {
        const sc = await fresh({ players: 2, minDeposit: 1n })
        const {
            env,
            players: [a, b],
        } = sc
        await put(env, a, G('100'))
        const w = (p: typeof a) => toAddr(walletAt(env, p.address).address)
        const r1 = (await startDeposit(env, a, G('30'), w(a)))[0]
        const r2 = (await startDeposit(env, b, G('40'), w(b)))[0] // both transfers carry query_id 0
        expect((await jackpotState(env)).incomingTokens).toBe(G('70'))
        expectChainSucceeded(await deliver(env, r2))
        expectChainSucceeded(await deliver(env, r1))
        const s = await jackpotState(env)
        expect(s.incomingTokens).toBe(0n)
        expect(await jgramOf(env, a.address)).toBeGreaterThan(G('129'))
        expect(await jgramOf(env, b.address)).toBeGreaterThan(G('39'))
    }, 200000)

    it('a burn under the query_id of a deposit in flight leaves the deposit whole', async () => {
        const sc = await fresh({ players: 2, minDeposit: 1n })
        const {
            env,
            players: [att, vic],
        } = sc
        await put(env, att, G('100'))
        const r = (await startDeposit(env, vic, G('1000'), toAddr(walletAt(env, vic.address).address)))[0]
        const a0 = await hgramOf(env, att.address)
        await walletAt(env, att.address).sendBurn(att.getSender(), {
            value: env.fees.withdraw,
            amount: G('10'),
            queryId: 0n,
        })
        expectChainSucceeded(await deliver(env, r))
        const s = await jackpotState(env)
        expect(s.incomingTokens).toBe(0n)
        expect(await jgramOf(env, vic.address)).toBeGreaterThan(G('999'))
        expect(await hgramOf(env, att.address)).toBe(a0 + G('10'))
    }, 200000)
})

describe('Fix 2: the wallet does not close while a full burn is in flight', () => {
    async function setup() {
        const sc = await fresh({ minDeposit: G('1'), players: 2, mint: G('2000') })
        const {
            env,
            players: [a],
        } = sc
        await put(env, a, G('100'))
        return { sc, env, a, w: walletAt(env, a.address) }
    }

    it('a deposit_cancelled that lands while burn_notification is in flight does not close the wallet; a bounce of burn_notification then restores x and pending', async () => {
        const { env, a, w } = await setup()
        // a deposit below the minimum: the Jackpot refuses it at deposit_ready and sends deposit_cancelled
        const toWallet = await startDeposit(env, a, G('0.5'), toAddr(w.address))
        const ready = toWallet[0]
        const note = (
            await holdUntil(
                env,
                messageFrom(a.address, w.address, env.fees.withdraw, burnBody(7n, 0n)),
                toAddr(w.address),
            )
        )[0]
        expect((await w.getWalletState()).balance).toBe(0n)
        expect((await w.getWalletState()).pending).toBe(2n)
        await deliver(env, ready) // the refusal: deposit_cancelled
        expect((await env.blockchain.getContract(w.address)).accountState?.type).toBe('active')
        expect((await w.getWalletState()).pending).toBe(1n)
        // the burn_notification fails at the Jackpot (too little value for its sends) and bounces whole
        const poor = {
            ...note,
            info: { ...(note.info as object), value: { coins: G('0.03') } } as typeof note.info,
        }
        await deliver(env, poor)
        const st = await w.getWalletState()
        expect([st.balance, st.pending]).toEqual([G('100'), 0n])
        expect(await jgramOf(env, a.address)).toBe(G('100'))
    }, 300000)

    it('burn all, a booking arrives, burn all again, both closes arrive: the wallet closes only after the last', async () => {
        const { env, a, w } = await setup()
        const ready = (await startDeposit(env, a, G('50'), toAddr(w.address)))[0]
        const heldBurn = async (qid: bigint) => {
            const outs = await holdUntil(
                env,
                messageFrom(a.address, w.address, env.fees.withdraw, burnBody(qid, 0n)),
                atJackpot(env, JackpotOp.burnNotification),
            )
            const close = outs.find((m) => m.body.beginParse().loadUint(32) === JackpotOp.closeWallet)!
            for (const m of outs) if (m !== close) await deliver(env, m)
            return close
        }
        const close1 = await heldBurn(1n)
        await deliver(env, ready) // the deposit books: deposit_booked arrives
        expect((await w.getWalletState()).balance).toBeGreaterThan(0n)
        const close2 = await heldBurn(2n)
        expect((await w.getWalletState()).balance).toBe(0n)
        await deliver(env, close1)
        expect((await env.blockchain.getContract(w.address)).accountState?.type).toBe('active')
        await deliver(env, close2)
        expect((await env.blockchain.getContract(w.address)).accountState?.type).not.toBe('active')
        const s = await jackpotState(env)
        expect([s.principal, s.tickets]).toEqual([0n, 0n])
    }, 300000)
})
