/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-unnecessary-condition -- tests read state they just made */
// Amendment 1, "Composable" and "Comments": the options of a deposit and a withdrawal, the refusals and their
// reasons, the payload cap, the prize notification, TEP-89, the jetton metadata and the `w` comment. Each test is
// named after its acceptance criterion.
import '@ton/test-utils'
import { compileFunc } from '@ton-community/func-js'
import { Address, Cell, Dictionary, beginCell, contractAddress, toNano } from '@ton/core'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import {
    JackpotError,
    JackpotOp,
    LogTopic,
    Reason,
    RefusedLog,
    depositOptions,
    logsOf,
    maxPayloadCells,
    withdrawOptions,
} from '../wrappers/Jackpot'
import {
    balanceOf,
    commentOf,
    depositHgram,
    excessesTo,
    expectChainSucceeded,
    expectSolvent,
    hgramOf,
    jackpotState,
    jgramOf,
    messageFrom,
    notificationsTo,
    opOf,
    setGasPrice,
    walletAt,
} from './jackpot/setup'
import { fresh, holdUntil, put, setNow, submitDraw, toAddr, toBoundary, A0, pokeFake } from './jackpot/scenario'

const G = (n: string | number) => toNano(String(n))

// A payload of `n` cells in a chain, each with some bits.
function chain(n: number, tag = 0xa5): Cell {
    let c = beginCell().storeUint(tag, 8).storeUint(n, 8).endCell()
    for (let i = 1; i < n; i++)
        c = beginCell()
            .storeUint(tag + i, 8)
            .storeRef(c)
            .endCell()
    return c
}

// The reason and payload of a deposit_refused, the forward payload of a refund.
function refusal(payload: Cell) {
    const s = payload.beginParse()
    expect(s.loadUint(32)).toBe(JackpotOp.depositRefused)
    return { reason: s.loadUint(8), payload: s.loadMaybeRef() }
}

describe('Composable: deposits', () => {
    it('Deposit with options: the beneficiary is notified with the caller’s query_id, the booked principal, the depositor and the payload bit for bit; the response destination gets gas_excess', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 3, mint: G('2000') })
        const { env, players } = sc
        const [alice, bob, carol] = players
        const payload = chain(3)
        const inner = G('0.05')
        const { result, booking } = await depositHgram(env, alice, G('100'), {
            forward: env.fees.deposit + inner + env.fees.payload,
            queryId: 777n,
            options: {
                minPrincipal: 0n,
                beneficiary: bob.address,
                responseDestination: carol.address,
                forwardTonAmount: inner,
                forwardPayload: payload,
            },
        })
        expectChainSucceeded(result)
        expect(booking!.owner.toString()).toBe(bob.address.toString())
        expect(booking!.depositor.toString()).toBe(alice.address.toString())
        const notes = notificationsTo(result, bob.address)
        expect(notes).toHaveLength(1)
        expect(notes[0].from.toString()).toBe(walletAt(env, bob.address).address.toString())
        expect(notes[0].queryId).toBe(777n)
        expect(notes[0].amount).toBe(booking!.principal)
        expect(notes[0].sender!.toString()).toBe(alice.address.toString())
        expect(notes[0].payload.hash().toString('hex')).toBe(payload.hash().toString('hex'))
        expect(notes[0].value).toBe(inner)
        expect(excessesTo(result, carol.address).map((x) => x.queryId)).toEqual([777n])
        expect(await jgramOf(env, bob.address)).toBe(booking!.principal)
        expect(await jgramOf(env, alice.address)).toBe(0n)
        await expectSolvent(env)
    }, 200000)

    // Each reason ends with the tokens back whole at the response destination, in the options' form or the default's.
    it('Refusals: for each reason code the response destination gets deposit_tokens whole, with the caller’s query_id and deposit_refused(reason, payload), or 1 nano-GRAM and the reason’s comment; the books end as before', async () => {
        const sc = await fresh({ minDeposit: G('2'), players: 3, mint: G('2000') })
        const { env, players } = sc
        const [alice, bob] = players
        await put(env, bob, G('300')) // a deposit already in, so that the books are not empty
        const payload = chain(2, 0x31)
        const inner = G('0.02')
        const texts: Record<number, string> = {
            [Reason.halted]: 'paused',
            [Reason.retired]: 'closed for deposits',
            [Reason.price]: 'entry price above your limit',
            [Reason.belowMinDeposit]: 'below the minimum deposit',
            [Reason.badOptions]: 'options could not be read',
            [Reason.lowValue]: 'too little GRAM attached',
            [Reason.walletUnavailable]: 'your Jackpot wallet could not take it',
        }
        interface Case {
            name: string
            reason: number
            tokens: bigint
            options?: Partial<Parameters<typeof depositOptions>[0]>
            raw?: Cell
            forward?: bigint
        }
        const cases: Case[] = [
            { name: 'below_min_deposit', reason: Reason.belowMinDeposit, tokens: G('1'), options: {} },
            { name: 'price', reason: Reason.price, tokens: G('50'), options: { minPrincipal: G('1000') } },
            {
                name: 'bad_options',
                reason: Reason.badOptions,
                tokens: G('50'),
                raw: beginCell()
                    .storeBit(true)
                    .storeRef(beginCell().storeUint(JackpotOp.depositOptions, 32).storeUint(5, 3).endCell())
                    .endCell(),
            },
            {
                name: 'bad_options (the beneficiary is the Jackpot)',
                reason: Reason.badOptions,
                tokens: G('50'),
                options: { beneficiary: env.jackpot.address },
            },
            {
                name: 'bad_options (a masterchain response destination)',
                reason: Reason.badOptions,
                tokens: G('50'),
                options: { responseDestination: new Address(-1, Buffer.alloc(32, 7)) },
            },
            {
                name: 'bad_options (a payload of 9 cells)',
                reason: Reason.badOptions,
                tokens: G('50'),
                options: { forwardPayload: chain(maxPayloadCells + 1) },
            },
            {
                name: 'low_value',
                reason: Reason.lowValue,
                tokens: G('50'),
                options: {},
                forward: env.fees.deposit - 1n,
            },
        ]
        const refused = async (c: Case, form: 'options' | 'default' | 'raw', queryId: bigint) => {
            const before = await jackpotState(env)
            const hBefore = await hgramOf(env, alice.address)
            const fwd = c.forward ?? env.fees.deposit + inner + env.fees.payload
            const dep = await depositHgram(env, alice, c.tokens, {
                queryId,
                forward: fwd,
                ...(form === 'raw'
                    ? { payload: c.raw }
                    : form === 'options'
                      ? {
                            options: {
                                minPrincipal: 0n,
                                forwardTonAmount: inner,
                                forwardPayload: payload,
                                ...c.options,
                            },
                        }
                      : {}),
            })
            expect({ name: c.name, form, booked: dep.booking != null }).toEqual({ name: c.name, form, booked: false })
            const after = await jackpotState(env)
            expect([after.principal, after.tickets, after.incomingTokens]).toEqual([
                before.principal,
                before.tickets,
                before.incomingTokens,
            ])
            expect(await hgramOf(env, alice.address)).toBe(hBefore) // whole, at the depositor
            const note = notificationsTo(dep.result, alice.address)[0]
            expect({ name: c.name, form, noted: note != null }).toEqual({ name: c.name, form, noted: true })
            expect(note.queryId).toBe(queryId)
            expect(note.amount).toBe(c.tokens)
            expect(note.sender!.toString()).toBe(env.jackpot.address.toString())
            return note
        }
        // options form: deposit_refused(reason, payload) with the caller's forward amount
        const expectOptionsRefusal = (note: Awaited<ReturnType<typeof refused>>, c: Case, withPayload: boolean) => {
            const r = refusal(note.payload)
            expect(r.reason).toBe(c.reason)
            if (!withPayload) expect(r.payload).toBeNull()
            else expect(r.payload!.hash().toString('hex')).toBe(payload.hash().toString('hex'))
            expect(note.value).toBe(c.reason === Reason.badOptions ? 1n : inner) // options that cannot be read carry no amount: 1 nano-GRAM
        }
        for (const c of cases) {
            if (c.raw != null) continue
            const note = await refused(c, 'options', 4242n)
            expectOptionsRefusal(note, c, c.reason !== Reason.badOptions)
        }
        // a garbled option: the refusal still carries the reason and none of the caller's payload
        {
            const c = cases[2]
            const note = await refused(c, 'raw', 17n)
            expectOptionsRefusal(note, c, false)
        }
        // default form: 1 nano-GRAM and the reason's comment
        for (const c of [cases[0], cases[6]]) {
            const note = await refused(c, 'default', 55n)
            expect(note.value).toBe(1n)
            expect(commentOf(note.payload)).toBe(`Hipo Jackpot: deposit returned (${texts[c.reason]})`)
        }
        // halted
        await env.jackpot.sendSetHalted(env.governor.getSender(), { value: G('0.05'), halted: true })
        {
            const note = await refused(
                { name: 'halted', reason: Reason.halted, tokens: G('20'), options: {} },
                'options',
                9n,
            )
            expect(refusal(note.payload).reason).toBe(Reason.halted)
            const d = await refused({ name: 'halted', reason: Reason.halted, tokens: G('20') }, 'default', 10n)
            expect(commentOf(d.payload)).toBe('Hipo Jackpot: deposit returned (paused)')
        }
        await env.jackpot.sendSetHalted(env.governor.getSender(), { value: G('0.05'), halted: false })
        // wallet_unavailable: the player's jGRAM wallet is frozen, so prepare_deposit bounces
        {
            await put(env, alice, G('40'))
            const addr = walletAt(env, alice.address).address
            const acc = (await env.blockchain.getContract(addr)).account
            const state = acc.account!.storage.state
            if (state.type !== 'active') throw new Error('no wallet')
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
            const note = await refused(
                { name: 'wallet_unavailable', reason: Reason.walletUnavailable, tokens: G('20'), options: {} },
                'options',
                11n,
            )
            expect(refusal(note.payload).reason).toBe(Reason.walletUnavailable)
            await env.blockchain.setShardAccount(addr, acc)
        }
        // retired
        await env.jackpot.sendRetire(env.governor.getSender(), { value: G('0.05') })
        {
            const note = await refused(
                { name: 'retired', reason: Reason.retired, tokens: G('20'), options: {} },
                'options',
                12n,
            )
            expect(refusal(note.payload).reason).toBe(Reason.retired)
            const d = await refused({ name: 'retired', reason: Reason.retired, tokens: G('20') }, 'default', 13n)
            expect(commentOf(d.payload)).toBe('Hipo Jackpot: deposit returned (closed for deposits)')
        }
    }, 600000)

    it('Refusals: rate_falling, after a fall the stored rate has seen', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000'), fake: true })
        const { env, players } = sc
        await pokeFake(sc, G('110'), G('100'))
        await put(env, players[0], G('100'))
        setNow(env, A0 + 3600)
        await pokeFake(sc, G('100'), G('100'))
        const before = await jackpotState(env)
        expect(before.falling).toBe(true)
        const dep = await depositHgram(env, players[1], G('30'), {
            queryId: 31n,
            forward: env.fees.deposit + G('0.02'),
            options: { minPrincipal: 0n, forwardTonAmount: G('0.02') },
        })
        const note = notificationsTo(dep.result, players[1].address)[0]
        expect(note.queryId).toBe(31n)
        expect(refusal(note.payload).reason).toBe(Reason.rateFalling)
        expect(logsOf<RefusedLog>(dep.result.externals, LogTopic.refused)[0].reason).toBe(Reason.rateFalling)
        const after = await jackpotState(env)
        expect([after.principal, after.tickets, after.incomingTokens]).toEqual([
            before.principal,
            before.tickets,
            before.incomingTokens,
        ])
    }, 200000)

    it('Payload cap: 8 cells pass; 9 are refused with bad_options on a deposit and throw at the wallet on a burn; at the cap the Jackpot’s balance does not fall in any user chain', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const { env, players } = sc
        const [alice, bob] = players
        const inner = G('0.02')
        await put(env, bob, G('20')) // the position and its nodes exist: their reserves come from the float, once
        const jackpot0 = await balanceOf(env, env.jackpot.address)
        const ok = await depositHgram(env, alice, G('100'), {
            forward: env.fees.deposit + inner + env.fees.payload,
            options: {
                minPrincipal: 0n,
                beneficiary: bob.address,
                forwardTonAmount: inner,
                forwardPayload: chain(maxPayloadCells),
            },
        })
        expectChainSucceeded(ok.result)
        expect(ok.booking).toBeDefined()
        expect(notificationsTo(ok.result, bob.address)[0].payload.hash().toString('hex')).toBe(
            chain(maxPayloadCells).hash().toString('hex'),
        )
        // the node openings of a new position come from the deposit's own value: the balance holds
        expect(await balanceOf(env, env.jackpot.address)).toBeGreaterThanOrEqual(jackpot0)
        const tooBig = await depositHgram(env, alice, G('10'), {
            forward: env.fees.deposit + inner + env.fees.payload,
            options: { minPrincipal: 0n, forwardTonAmount: inner, forwardPayload: chain(maxPayloadCells + 1) },
        })
        expect(tooBig.booking).toBeUndefined()
        const refund = notificationsTo(tooBig.result, alice.address)[0]
        expect(refusal(refund.payload).reason).toBe(Reason.badOptions)
        // a burn: 8 cells pass, 9 throw at the wallet
        const before = await balanceOf(env, env.jackpot.address)
        const burn = (cells: number) =>
            walletAt(env, bob.address).sendBurn(bob.getSender(), {
                value: env.fees.withdraw + inner + env.fees.payload,
                amount: G('10'),
                options: withdrawOptions({ forwardTonAmount: inner, forwardPayload: chain(cells) }),
            })
        const good = await burn(maxPayloadCells)
        expectChainSucceeded(good)
        expect(notificationsTo(good, bob.address)[0].payload.hash().toString('hex')).toBe(
            chain(maxPayloadCells).hash().toString('hex'),
        )
        expect(await balanceOf(env, env.jackpot.address)).toBeGreaterThanOrEqual(before)
        const bad = await burn(maxPayloadCells + 1)
        expect(bad.transactions).toHaveTransaction({
            to: walletAt(env, bob.address).address,
            success: false,
        })
        expect(await jgramOf(env, bob.address)).toBe(G('20') + ok.booking!.principal - G('10'))
    }, 300000)
})

describe('Composable: fees count forwarding', () => {
    // 8 cells of 1,023 bits: the cap, at its heaviest
    function heavy(): Cell {
        let c = beginCell().storeBuffer(Buffer.alloc(127, 1)).storeUint(0x7f, 7).endCell()
        for (let i = 2; i <= 8; i++) {
            c = beginCell().storeBuffer(Buffer.alloc(127, i)).storeUint(0x7f, 7).storeRef(c).endCell()
        }
        return c
    }

    it('F7: at the minimum value and 400 nano-GRAM per gas, a cap-size payload goes through a deposit into a new wallet and a burn; the Jackpot’s balance does not fall', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const { env, players } = sc
        const [alice, bob] = players
        await put(env, alice, G('100')) // position 0 exists, so a new wallet opens no node
        setGasPrice(env.blockchain, 400n)
        const inner = G('0.02')
        const payload = heavy()
        const before = await balanceOf(env, env.jackpot.address)
        const dep = await depositHgram(env, bob, G('50'), {
            forward: env.fees.deposit + inner + env.fees.payload,
            value: env.fees.deposit + inner + env.fees.payload + G('0.1'),
            options: { minPrincipal: 0n, forwardTonAmount: inner, forwardPayload: payload },
        })
        expectChainSucceeded(dep.result)
        expect(dep.booking).toBeDefined()
        expect(notificationsTo(dep.result, bob.address)[0].payload.hash().toString('hex')).toBe(payload.hash().toString('hex'))
        expect(await balanceOf(env, env.jackpot.address)).toBeGreaterThanOrEqual(before)
        const mid = await balanceOf(env, env.jackpot.address)
        const burn = await walletAt(env, bob.address).sendBurn(bob.getSender(), {
            value: env.fees.withdraw + inner + env.fees.payload,
            amount: G('10'),
            options: withdrawOptions({ forwardTonAmount: inner, forwardPayload: payload }),
        })
        expectChainSucceeded(burn)
        const note = notificationsTo(burn, bob.address)[0]
        expect(note.payload.hash().toString('hex')).toBe(payload.hash().toString('hex'))
        expect(await balanceOf(env, env.jackpot.address)).toBeGreaterThanOrEqual(mid)
        // and the same for a full burn, which closes the wallet
        const full = await walletAt(env, bob.address).sendBurn(bob.getSender(), {
            value: env.fees.withdraw + inner + env.fees.payload,
            amount: 0n,
            options: withdrawOptions({ forwardTonAmount: inner, forwardPayload: payload }),
        })
        expectChainSucceeded(full)
        expect(await balanceOf(env, env.jackpot.address)).toBeGreaterThanOrEqual(mid)
        await expectSolvent(env)
    }, 300000)
})

describe('Composable: withdrawals', () => {
    it('Withdrawal by burn: no custom_payload pays the owner; withdraw_options notifies with the caller’s query_id and sends the rest to the response destination; nothing reaches the Jackpot after its send_tokens; a stranger’s burn throws', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 3, mint: G('2000') })
        const { env, players } = sc
        const [alice, bob, carol] = players
        await put(env, alice, G('300'))
        // a standard burn: paid to the owner, no notification
        const h0 = await hgramOf(env, alice.address)
        const plain = await walletAt(env, alice.address).sendBurn(alice.getSender(), {
            value: env.fees.withdraw,
            amount: G('50'),
            queryId: 5n,
        })
        expectChainSucceeded(plain)
        expect(await hgramOf(env, alice.address)).toBe(h0 + G('50'))
        expect(notificationsTo(plain, alice.address)).toHaveLength(0)
        // with options
        const payload = chain(2, 0x77)
        const inner = G('0.03')
        const h1 = await hgramOf(env, alice.address)
        const r = await walletAt(env, alice.address).sendBurn(alice.getSender(), {
            value: env.fees.withdraw + inner + env.fees.payload,
            amount: G('60'),
            queryId: 99n,
            responseDestination: carol.address,
            options: withdrawOptions({ forwardTonAmount: inner, forwardPayload: payload }),
        })
        expectChainSucceeded(r)
        const [note] = notificationsTo(r, alice.address)
        expect(note.queryId).toBe(99n)
        expect(note.amount).toBe(G('60'))
        expect(note.sender!.toString()).toBe(env.jackpot.address.toString())
        expect(note.payload.hash().toString('hex')).toBe(payload.hash().toString('hex'))
        expect(note.value).toBe(inner)
        expect(await hgramOf(env, alice.address)).toBe(h1 + G('60'))
        expect(excessesTo(r, carol.address).map((x) => x.queryId)).toEqual([99n])
        // no message reaches the Jackpot after its send_tokens: the last transaction at the Jackpot is the burn_notification
        const atJackpot = r.transactions.filter(
            (t) => t.inMessage?.info.dest?.toString() === env.jackpot.address.toString(),
        )
        expect(atJackpot.map((t) => opOf(t))).toEqual([JackpotOp.burnNotification])
        // a burn from anyone but the owner and the Jackpot throws
        const stranger = await walletAt(env, alice.address).sendBurn(bob.getSender(), {
            value: env.fees.withdraw,
            amount: G('10'),
        })
        expect(stranger.transactions).toHaveTransaction({
            to: walletAt(env, alice.address).address,
            success: false,
        })
        expect(await jgramOf(env, alice.address)).toBe(G('190'))
    }, 300000)

    it('Withdrawal by burn: a payout short of value for its forward fields goes without them', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000') })
        const { env, players } = sc
        const [alice] = players
        await put(env, alice, G('100'))
        const w = walletAt(env, alice.address)
        const fwd = G('0.3')
        const [note] = await holdUntil(
            env,
            messageFrom(
                alice.address,
                w.address,
                env.fees.withdraw + fwd + env.fees.payload,
                beginCell()
                    .storeUint(JackpotOp.burn, 32)
                    .storeUint(3, 64)
                    .storeCoins(G('20'))
                    .storeAddress(null)
                    .storeMaybeRef(withdrawOptions({ forwardTonAmount: fwd, forwardPayload: chain(1) }))
                    .endCell(),
            ),
            toAddr(w.address),
        )
        // delivered with the value of a bare withdrawal: enough for the tree and the payout, not for the forward fields
        const poor = {
            ...note,
            info: { ...(note.info as object), value: { coins: env.fees.withdraw } } as typeof note.info,
        }
        const h0 = await hgramOf(env, alice.address)
        const r = await env.blockchain.sendMessage(poor)
        expectChainSucceeded(r)
        expect(await hgramOf(env, alice.address)).toBe(h0 + G('20'))
        expect(notificationsTo(r, alice.address)).toHaveLength(0)
    }, 200000)
})

describe('Composable: prizes', () => {
    // A contract that records the amount and the forward payload of the last transfer_notification it gets.
    async function winnerCode(): Promise<Cell> {
        const stdlib = readFileSync('contracts/imports/stdlib.fc', 'utf8')
        const source = `#include "stdlib.fc";
() recv_internal(int balance, int value, cell msg, slice body) impure {
    if body.slice_bits() < 32 { return (); }
    if body~load_uint(32) != 0x7362d09c { return (); }
    body~skip_bits(64);
    int amount = body~load_coins();
    slice sender = body~load_msg_addr();
    slice payload = body~load_int(1) ? body~load_ref().begin_parse() : body;
    throw_unless(77, payload~load_uint(32) == 0);
    set_data(begin_cell().store_coins(amount).store_slice(sender).store_ref(begin_cell().store_slice(payload).end_cell()).end_cell());
}`
        const r = await compileFunc({
            targets: ['winner.fc'],
            sources: (p: string) => (p === 'stdlib.fc' ? stdlib : source),
        })
        if (r.status === 'error') throw new Error(r.message)
        return Cell.fromBase64(r.codeBoc)
    }

    it('Prizes: each winner’s hGRAM wallet sends exactly fee::prize_notify with the comment "Hipo Jackpot prize: draw <tag>, <place>"; a test contract as winner parses it within that gas', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('2000') })
        const { env, players } = sc
        const [alice] = players
        await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
        // the winner is a contract: the one depositor, as the beneficiary of a deposit
        const init = { code: await winnerCode(), data: beginCell().endCell() }
        const winner = contractAddress(0, init)
        await env.blockchain.sendMessage({
            ...messageFrom(alice.address, winner, G('1'), beginCell().endCell(), false),
            init,
        })
        const inner = 0n
        const dep = await depositHgram(env, alice, G('100'), {
            forward: env.fees.deposit,
            options: { minPrincipal: 0n, beneficiary: winner, forwardTonAmount: inner },
        })
        expect(dep.booking!.owner.toString()).toBe(winner.toString())
        await toBoundary(env, G('40'))
        const tagNow = (await jackpotState(env)).tag
        const r = await submitDraw(env)
        expectChainSucceeded(r)
        const notes = notificationsTo(r, winner)
        expect(notes).toHaveLength(3)
        const places = ['1st', '2nd', '3rd']
        notes.forEach((n, i) => {
            expect(n.value).toBe(G('0.01')) // fee::prize_notify
            expect(n.sender!.toString()).toBe(env.jackpot.address.toString())
            expect(commentOf(n.payload)).toBe(`Hipo Jackpot prize: draw ${tagNow.toString()}, ${places[i]}`)
        })
        // the contract parsed each one within the gas the notify value pays for: 25,000 gas at 400 nano-GRAM
        const gas = r.transactions
            .filter(
                (t) =>
                    t.inMessage?.info.dest?.toString() === winner.toString() &&
                    opOf(t) === JackpotOp.transferNotification,
            )
            .map((t) =>
                t.description.type === 'generic' && t.description.computePhase.type === 'vm'
                    ? t.description.computePhase.gasUsed
                    : 0n,
            )
        expect(gas).toHaveLength(3)
        for (const g of gas) expect(g).toBeLessThanOrEqual(25_000n)
        const stored = (await env.blockchain.getContract(winner)).accountState
        expect(stored?.type).toBe('active')
    }, 400000)
})

describe('Composable: TEP-89 and metadata', () => {
    it('TEP-89: take_wallet_address equals get_wallet_address for a basechain owner, is addr_none for a masterchain one, and includes the owner only when asked', async () => {
        const sc = await fresh({ players: 2 })
        const { env, players } = sc
        const [alice, bob] = players
        const ask = async (owner: Address, include: boolean) => {
            const r = await env.jackpot.sendProvideWalletAddress(alice.getSender(), {
                value: env.fees.walletStorage + G('0.1'),
                owner,
                includeAddress: include,
                queryId: 21n,
            })
            const tx = r.transactions.find(
                (t) =>
                    t.inMessage?.info.dest?.toString() === alice.address.toString() &&
                    opOf(t) === JackpotOp.takeWalletAddress,
            )!
            expect(tx).toBeDefined()
            const s = tx.inMessage!.body.beginParse()
            s.skip(32)
            expect(s.loadUintBig(64)).toBe(21n)
            const wallet = s.loadMaybeAddress()
            const ownerRef = s.loadBit() ? s.loadRef().beginParse().loadAddress() : null
            return { wallet, ownerRef }
        }
        const a = await ask(bob.address, true)
        expect(a.wallet!.toString()).toBe((await env.jackpot.getWalletAddress(bob.address)).toString())
        expect(a.ownerRef!.toString()).toBe(bob.address.toString())
        const b = await ask(bob.address, false)
        expect(b.wallet!.toString()).toBe(a.wallet!.toString())
        expect(b.ownerRef).toBeNull()
        const master = new Address(-1, Buffer.alloc(32, 9))
        const c = await ask(master, true)
        expect(c.wallet).toBeNull()
        expect(c.ownerRef!.toString()).toBe(master.toString())
        // too little value throws
        const poor = await env.jackpot.sendProvideWalletAddress(alice.getSender(), {
            value: 1_000_000n,
            owner: bob.address,
            includeAddress: false,
        })
        expect(poor.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.insufficientFee,
        })
    }, 200000)

    it('Jetton metadata: get_jetton_data reads name "Hipo Jackpot GRAM", symbol jGRAM, 9 decimals and the description; mintable is false after retire', async () => {
        const sc = await fresh({ players: 1 })
        const { env } = sc
        const read = async () => {
            const data = await env.jackpot.getJettonData()
            const s = data.content.beginParse()
            expect(s.loadUint(8)).toBe(0)
            const dict = Dictionary.load(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell(), s)
            const field = (key: string) => {
                const c = dict.get(BigInt('0x' + createHash('sha256').update(key).digest('hex')))!
                const cs = c.beginParse()
                expect(cs.loadUint(8)).toBe(0)
                return cs.loadStringTail()
            }
            return {
                data,
                name: field('name'),
                symbol: field('symbol'),
                decimals: field('decimals'),
                description: field('description'),
            }
        }
        const m = await read()
        expect(m.name).toBe('Hipo Jackpot GRAM')
        expect(m.symbol).toBe('jGRAM')
        expect(m.decimals).toBe('9')
        expect(m.description).toBe('Non-transferable. Your principal in Hipo Jackpot; withdraw to get hGRAM back.')
        // mintable while open, false once retired
        expect(m.data.mintable).toBe(true)
        await env.jackpot.sendRetire(env.governor.getSender(), { value: G('0.05') })
        expect((await read()).data.mintable).toBe(false)
    }, 100000)
})

describe('Comments', () => {
    it('`w` and `W` withdraw everything with the comment "Hipo Jackpot withdrawal" and close the wallet; a `w` from an address with no wallet returns its GRAM less fees and leaves no account; a `w` below the fee and any other comment throw', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 3, mint: G('2000') })
        const { env, players } = sc
        const [alice, bob, nobody] = players
        await put(env, alice, G('100'))
        await put(env, bob, G('100'))
        for (const [who, text] of [
            [alice, 'w'],
            [bob, 'W'],
        ] as const) {
            const h0 = await hgramOf(env, who.address)
            const r = await env.jackpot.sendComment(who.getSender(), { value: env.fees.commentWithdraw, text })
            expectChainSucceeded(r)
            expect(await hgramOf(env, who.address)).toBe(h0 + G('100'))
            const [note] = notificationsTo(r, who.address)
            expect(note.value).toBe(1n)
            expect(commentOf(note.payload)).toBe('Hipo Jackpot withdrawal')
            expect((await env.blockchain.getContract(walletAt(env, who.address).address)).accountState?.type).not.toBe(
                'active',
            )
        }
        expect((await jackpotState(env)).principal).toBe(0n)
        // no wallet: the GRAM comes back less fees, and no account is left
        const g0 = await balanceOf(env, nobody.address)
        const r = await env.jackpot.sendComment(nobody.getSender(), { value: env.fees.commentWithdraw, text: 'w' })
        expectChainSucceeded(r)
        const lost = g0 - (await balanceOf(env, nobody.address))
        expect(lost).toBeGreaterThanOrEqual(0n)
        expect(lost).toBeLessThan(env.fees.commentWithdraw / 2n)
        expect((await env.blockchain.getContract(walletAt(env, nobody.address).address)).accountState?.type).not.toBe(
            'active',
        )
        // below the fee, and other comments, throw
        const poor = await env.jackpot.sendComment(nobody.getSender(), {
            value: env.fees.commentWithdraw - 1n,
            text: 'w',
        })
        expect(poor.transactions).toHaveTransaction({
            to: env.jackpot.address,
            success: false,
            exitCode: JackpotError.insufficientFee,
        })
        for (const text of ['d', 'ww', 'withdraw']) {
            const bad = await env.jackpot.sendComment(nobody.getSender(), { value: env.fees.commentWithdraw, text })
            expect(bad.transactions).toHaveTransaction({
                to: env.jackpot.address,
                success: false,
                exitCode: JackpotError.badComment,
            })
        }
    }, 300000)
})
