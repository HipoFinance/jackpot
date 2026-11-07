/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/prefer-find -- tests read state they just made */
// The Races table, the closed and frozen wallets, and the bounces of a deposit. A chain is stopped half way
// (tests/jackpot/scenario.ts holdUntil) and its held messages are delivered in both orders.
import '@ton/test-utils'
import { Address, BitString, Cell, beginCell, toNano } from '@ton/core'
import { BlockchainTransaction, SandboxContract, TreasuryContract } from '@ton/sandbox'
import { JackpotOp, LogTopic, SlotResult, UntrackedLog, logsOf } from '../wrappers/Jackpot'
import {
    Env,
    depositHgram,
    expectChainSucceeded,
    expectSolvent,
    hgramOf,
    jackpotState,
    jgramOf,
    messageFrom,
    nodeAt,
    setGasPrice,
    slotsIn,
    walletAt,
    withdraw,
} from './jackpot/setup'
import { gasFee, forwardFee } from './jackpot/prices'
import { Scene, deliver, fresh, holdUntil, put, startDeposit, submitDraw, toAddr, toBoundary } from './jackpot/scenario'

const G = (n: string | number) => toNano(String(n))
type Player = SandboxContract<TreasuryContract>

// Wallets, tree and principal agree, and the jetton adds up.
async function agree(env: Env, players: Player[]) {
    await expectSolvent(env)
    const s = await jackpotState(env)
    let sum = 0n
    for (const p of players) sum += await jgramOf(env, p.address)
    expect(sum).toBe(s.principal)
    expect((await env.jackpot.getJettonData()).totalSupply).toBe(s.principal)
    const top = await env.blockchain.getContract(nodeAt(env, 4, 0n).address)
    if (top.accountState?.type === 'active') {
        const n = await nodeAt(env, 4, 0n).getNodeData()
        const tree = n.committed.reduce((a, x, i) => a + x + n.added[i] - n.removed[i], 0n)
        expect(tree).toBe(s.principal)
    }
    expect(s.incomingTokens).toBe(0n)
}

function burnBody(x: bigint, queryId = 0n): Cell {
    return beginCell()
        .storeUint(JackpotOp.burn, 32)
        .storeUint(queryId, 64)
        .storeCoins(x)
        .storeAddress(null)
        .storeMaybeRef(null)
        .endCell()
}

function startBurn(sc: Scene, p: Player, x: bigint, stop: Parameters<typeof holdUntil>[2]) {
    return holdUntil(
        sc.env,
        messageFrom(p.address, walletAt(sc.env, p.address).address, sc.env.fees.withdraw, burnBody(x)),
        stop,
    )
}

const opOfBody = (body: Cell): number => {
    const s = body.beginParse()
    return s.remainingBits >= 32 ? s.loadUint(32) : 0
}
const isOp = (op: number) => (tx: BlockchainTransaction) => tx.inMessage != null && opOfBody(tx.inMessage.body) === op
const atJackpotOp = (env: Env, op: number) => (tx: BlockchainTransaction) =>
    toAddr(env.jackpot.address)(tx) && isOp(op)(tx)

describe('Races', () => {
    for (const order of ['first delivered first', 'first delivered last'] as const) {
        const reverse = order === 'first delivered last'

        it(`Two deposits, wallet has b (${order}): both deposit_ready(b); both book; pending falls to 0`, async () => {
            const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
            const { env, players } = sc
            const [a] = players
            await put(env, a, G('100'))
            const r1 = (await startDeposit(env, a, G('30'), toAddr(walletAt(env, a.address).address)))[0]
            const r2 = (await startDeposit(env, a, G('20'), toAddr(walletAt(env, a.address).address)))[0]
            expect((await walletAt(env, a.address).getWalletState()).pending).toBe(2n)
            for (const m of reverse ? [r2, r1] : [r1, r2]) expectChainSucceeded(await deliver(env, m))
            const w = await walletAt(env, a.address).getWalletState()
            expect(w).toMatchObject({ pending: 0n, position: 0n })
            expect(w.balance).toBeGreaterThan(G('149'))
            await agree(env, players)
        }, 120000)

        it(`Two deposits, new wallet (${order}): the second is refused wallet_busy and refunded, or books if the first finished; nothing bounces`, async () => {
            const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
            const { env, players } = sc
            const [a] = players
            const r1 = (await startDeposit(env, a, G('30'), toAddr(walletAt(env, a.address).address)))[0]
            const held0 = await hgramOf(env, a.address)
            if (!reverse) {
                // the second prepare_deposit reaches the opening wallet first
                const second = await depositHgram(env, a, G('20'), { minC: 0n })
                expect(second.booking).toBeUndefined()
                expect(
                    second.result.transactions.some(
                        (t) => t.inMessage?.info.type === 'internal' && t.inMessage.info.bounced,
                    ),
                ).toBe(false)
                expect(await hgramOf(env, a.address)).toBe(held0) // the second deposit came back whole
                expectChainSucceeded(await deliver(env, r1))
            } else {
                expectChainSucceeded(await deliver(env, r1))
                const second = await depositHgram(env, a, G('20'), { minC: 0n })
                expect(second.booking).toBeDefined()
            }
            expect((await walletAt(env, a.address).getWalletState()).pending).toBe(0n)
            await agree(env, players)
        }, 120000)

        it(`Full burn while a deposit is in flight (${order}): pending > 0, so the close does nothing; the booking lands on the same b`, async () => {
            const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
            const { env, players } = sc
            const [a] = players
            await put(env, a, G('100'))
            const r1 = (await startDeposit(env, a, G('30'), toAddr(walletAt(env, a.address).address)))[0]
            if (!reverse) {
                expectChainSucceeded(await withdraw(env, a, 0n))
                expect((await walletAt(env, a.address).getWalletState()).balance).toBe(0n)
                expectChainSucceeded(await deliver(env, r1))
            } else {
                expectChainSucceeded(await deliver(env, r1))
                expectChainSucceeded(await withdraw(env, a, 0n))
            }
            const st = await env.blockchain.getContract(walletAt(env, a.address).address)
            if (!reverse) {
                expect(st.accountState?.type).toBe('active')
                const w = await walletAt(env, a.address).getWalletState()
                expect([w.position, w.pending]).toEqual([0n, 0n])
                expect(w.balance).toBeGreaterThan(G('29'))
            } else {
                expect(st.accountState?.type).not.toBe('active')
            }
            await agree(env, players)
        }, 120000)

        it(`prepare_deposit arrives after a close (${order}): a fresh deployment and a new position, or the old b if it came first`, async () => {
            const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
            const { env, players } = sc
            const [a] = players
            await put(env, a, G('100'))
            const notified = (
                await startDeposit(env, a, G('30'), (tx) => toAddr(env.jackpot.address)(tx) && isOp(0x7362d09c)(tx))
            ).find((m) => opOfBody(m.body) === JackpotOp.prepareDeposit)!
            if (!reverse) {
                expectChainSucceeded(await withdraw(env, a, 0n)) // the wallet is deleted
                expect(
                    (await env.blockchain.getContract(walletAt(env, a.address).address)).accountState?.type,
                ).not.toBe('active')
                expectChainSucceeded(await deliver(env, notified))
                const w = await walletAt(env, a.address).getWalletState()
                expect(w.position).toBe(1n) // a new one; position 0 is dead
                expect(w.pending).toBe(0n)
            } else {
                // the burn has reached the Jackpot, and its close_wallet is still on the way
                const out = await startBurn(sc, a, 0n, atJackpotOp(env, JackpotOp.burnNotification))
                const close = out.find((m) => opOfBody(m.body) === JackpotOp.closeWallet)!
                // the rest of the burn (the tree update, the payout) goes on; only the close is held back
                for (const m of out) if (m !== close) expectChainSucceeded(await deliver(env, m))
                expectChainSucceeded(await deliver(env, notified)) // the old position is still the wallet's
                expectChainSucceeded(await deliver(env, close)) // pending was above 0, so nothing closes
                const w = await walletAt(env, a.address).getWalletState()
                expect(w.position).toBe(0n)
                expect(w.balance).toBeGreaterThan(0n)
            }
            await agree(env, players)
        }, 120000)
    }

    for (const searchFirst of [true, false]) {
        it(`A burn in flight when the draw runs (${searchFirst ? 'search first' : 'burn_notification first'}): the Jackpot has not seen it, so the ticket counts and can hit; if seen first, it misses`, async () => {
            const sc = await fresh({ minDeposit: 1n, players: 3, mint: G('1000') })
            const { env, players } = sc
            await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
            for (const p of players) await put(env, p, G('100'))
            await toBoundary(env, G('30'))
            const snap = env.blockchain.snapshot()
            const base = slotsIn(await submitDraw(env)).filter((x) => x.result === SlotResult.hit)
            const winner = players.find((p) => p.address.toString() === base[0].owner!.toString())!
            await env.blockchain.loadFrom(snap)
            // the winner's wallet has taken the balance; the Jackpot has not heard of it
            const held = (await startBurn(sc, winner, 0n, toAddr(walletAt(env, winner.address).address)))[0]
            let draw
            if (searchFirst) {
                draw = slotsIn(await submitDraw(env))
                expectChainSucceeded(await deliver(env, held))
            } else {
                expectChainSucceeded(await deliver(env, held))
                draw = slotsIn(await submitDraw(env))
            }
            const first = draw.filter((x) => x.slot === base[0].slot)[0]
            expect(first.position).toBe(base[0].position)
            expect(first.result).toBe(searchFirst ? SlotResult.hit : SlotResult.miss)
            if (searchFirst) expect(first.owner!.toString()).toBe(winner.address.toString())
            await agree(env, players)
        }, 200000)
    }
})

describe('Closed and frozen wallets', () => {
    it('a wallet fully withdrawn is deleted and its GRAM reaches the owner; it can deposit again at a new position, and the old one is never picked', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const { env, players } = sc
        await put(env, players[0], G('100'))
        await withdraw(env, players[0], 0n)
        const wallet = await env.blockchain.getContract(walletAt(env, players[0].address).address)
        expect(wallet.accountState?.type).not.toBe('active')
        expect(wallet.balance).toBe(0n)
        const again = await put(env, players[0], G('50'))
        expect(again.booking!.b).toBe(1n)
        await agree(env, players)
    }, 120000)

    async function freeze(env: Env, addr: Address) {
        const c = await env.blockchain.getContract(addr)
        const acc = c.account
        const state = acc.account!.storage.state
        if (state.type !== 'active') throw new Error('not active')
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
        return { code: state.state.code!, data: state.state.data! }
    }

    it('a wallet frozen with a balance above 0: prepare_deposit bounces, the tokens return whole; revived with its exact state, it withdraws', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const { env, players } = sc
        await put(env, players[0], G('100'))
        const address = walletAt(env, players[0].address).address
        const last = await freeze(env, address)
        const h = await hgramOf(env, players[0].address)
        const dep = await depositHgram(env, players[0], G('30'), { minC: 0n })
        expect(dep.booking).toBeUndefined()
        // the full-body bounce brought the context back; the refund is paid by the bounce itself
        expect(dep.result.transactions).toHaveTransaction({
            from: address,
            to: env.jackpot.address,
            inMessageBounced: true,
        })
        expect(await hgramOf(env, players[0].address)).toBe(h)
        expect((await jackpotState(env)).incomingTokens).toBe(0n)
        // revive: its exact last state, and GRAM for the debt
        const r = await env.blockchain.sendMessage({
            ...messageFrom(players[1].address, address, G('0.5'), beginCell().endCell(), false),
            init: { code: last.code, data: last.data },
        })
        expectChainSucceeded(r)
        expect((await env.blockchain.getContract(address)).accountState?.type).toBe('active')
        const w = await withdraw(env, players[0], G('40'))
        expectChainSucceeded(w)
        expect(await jgramOf(env, players[0].address)).toBe(G('60'))
        await agree(env, players)
    }, 120000)

    it('a wallet frozen with a deposit_ready on its way: the next prepare_deposit bounces, and the booking is undone by its own bounce', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const { env, players } = sc
        const [a] = players
        await put(env, a, G('100'))
        const address = walletAt(env, a.address).address
        const r1 = (await startDeposit(env, a, G('30'), toAddr(address)))[0] // pending 1, deposit_ready held
        await freeze(env, address)
        const h = await hgramOf(env, a.address)
        const second = await depositHgram(env, a, G('20'), { minC: 0n })
        expect(second.booking).toBeUndefined()
        expect(await hgramOf(env, a.address)).toBe(h) // the bounce returned the second
        expect((await jackpotState(env)).incomingTokens).toBe(G('30'))
        // the first deposit_ready arrives: the Jackpot books, deposit_booked bounces off the frozen wallet, the booking is undone
        const principal0 = (await jackpotState(env)).principal
        const undone = await deliver(env, r1)
        expectChainSucceeded(undone)
        const s = await jackpotState(env)
        expect(s.incomingTokens).toBe(0n)
        expect(s.principal).toBe(principal0)
        expect(s.tickets).toBe(principal0)
        // the owner has the 30 back, less at most the entry price (here: none, there is no pot)
        // the refund is paid from what the bounce carries; when that is short of the payout fee, the tokens leave the count
        // untracked and return_tokens recovers them (the undo itself stands either way)
        if ((await hgramOf(env, a.address)) < h + G('30') - 2n) {
            const [log] = logsOf<UntrackedLog>(undone.externals, LogTopic.untracked)
            expect(log.tokens).toBeGreaterThan(0n)
            expectChainSucceeded(await env.jackpot.sendReturnTokens(env.governor.getSender(), { value: G('0.3'), owner: a.address, amount: log.tokens }))
        }
        expect(await hgramOf(env, a.address)).toBeGreaterThanOrEqual(h + G('30') - 2n)
        await expectSolvent(env)
    }, 120000)

    it('Bounce value: the smallest bounced deposit_booked, at 400 nano-GRAM per gas and with an 8-cell, 1,023-bit payload, is undone: the counters are right and the tokens are untracked, not lost', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const { env, players } = sc
        await put(env, players[0], G('100'))
        setGasPrice(env.blockchain, 400n)
        const s0 = await jackpotState(env)
        // the cap: 8 cells of 1,023 bits, a chain
        let payload = beginCell().storeBuffer(Buffer.alloc(127, 7)).storeBits(new BitString(Buffer.alloc(1, 0xfe), 0, 7)).endCell()
        for (let i = 1; i < 8; i++) {
            payload = beginCell().storeBuffer(Buffer.alloc(127, 7 + i)).storeBits(new BitString(Buffer.alloc(1, 0xfe), 0, 7)).storeRef(payload).endCell()
        }
        const reply = beginCell()
            .storeAddress(players[0].address)
            .storeAddress(players[0].address)
            .storeCoins(G('0.05'))
            .storeMaybeRef(payload)
            .storeAddress(players[0].address)
            .endCell()
        const original = beginCell()
            .storeUint(JackpotOp.depositBooked, 32)
            .storeUint(78, 64)
            .storeCoins(G('10'))
            .storeUint(0, 32)
            .storeRef(reply)
            .endCell()
        // the smallest bounce deposit_booked can carry: its forwarding and H wallet handlers (the undo raises its own gas
        // limit and pays its update and cancel from the Jackpot's balance)
        const floor = forwardFee(env.blockchain, 1n, 1023n) + 2n * gasFee(env.blockchain, 18000n)
        const msg = messageFrom(
            walletAt(env, players[0].address).address,
            env.jackpot.address,
            floor,
            beginCell().storeUint(0xfffffffe, 32).storeRef(original).endCell(),
            false,
        )
        const h = await hgramOf(env, players[0].address)
        const r = await env.blockchain.sendMessage({ ...msg, info: { ...(msg.info as object), bounced: true } as typeof msg.info })
        expectChainSucceeded(r)
        const s1 = await jackpotState(env)
        expect([s1.principal, s1.tickets]).toEqual([s0.principal - G('10'), s0.tickets - G('10')])
        expect((await nodeAt(env, 1, 0n).getNodeData()).removed[0]).toBe(G('10'))
        // the refund needs the payout fee; this bounce carries less, so the tokens are untracked and logged
        expect(logsOf<UntrackedLog>(r.externals, LogTopic.untracked)[0].tokens).toBeGreaterThan(0n)
        expect(await hgramOf(env, players[0].address)).toBe(h)
        expect(s1.heldTokens - (await hgramOf(env, env.jackpot.address))).toBeLessThanOrEqual(0n)
    }, 120000)

    it('a bounced deposit_booked, made by hand: principal, tickets and the tree return; the tokens go to the response destination', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const { env, players } = sc
        await put(env, players[0], G('100'))
        const s0 = await jackpotState(env)
        const wallet = walletAt(env, players[0].address).address
        const reply = beginCell()
            .storeAddress(players[0].address)
            .storeAddress(players[0].address)
            .storeCoins(1n)
            .storeMaybeRef(null)
            .storeAddress(players[0].address)
            .endCell()
        const original = beginCell()
            .storeUint(JackpotOp.depositBooked, 32)
            .storeUint(77, 64)
            .storeCoins(G('10'))
            .storeUint(0, 32)
            .storeRef(reply)
            .endCell()
        const msg = messageFrom(
            wallet,
            env.jackpot.address,
            G('0.3'),
            beginCell().storeUint(0xfffffffe, 32).storeRef(original).endCell(),
            false,
        )
        const h = await hgramOf(env, players[0].address)
        const r = await env.blockchain.sendMessage({
            ...msg,
            info: { ...(msg.info as object), bounced: true } as typeof msg.info,
        })
        expectChainSucceeded(r)
        const s1 = await jackpotState(env)
        expect(s1.principal).toBe(s0.principal - G('10'))
        expect(s1.tickets).toBe(s0.tickets - G('10'))
        expect((await nodeAt(env, 1, 0n).getNodeData()).removed[0]).toBe(G('10'))
        expect(await hgramOf(env, players[0].address)).toBeGreaterThan(h)
    }, 120000)
})
