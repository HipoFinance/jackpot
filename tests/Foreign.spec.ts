/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests read state they just made */
// Decided 2026-11-04: foreign jettons and NFTs, rescue_jetton and rescue_nft, and the Hipo setters. Each test is
// named after its criterion in docs/specs/2026-11-03-jackpot-v2-amendment-1.md.
import '@ton/test-utils'
import { compileFunc } from '@ton-community/func-js'
import { Address, Cell, beginCell, contractAddress, toNano } from '@ton/core'
import { SendMessageResult } from '@ton/sandbox'
import { readFileSync } from 'fs'
import { ForeignReturnLog, HipoWalletLog, JackpotError, JackpotOp, LogTopic, TreasuryLog, logsOf } from '../wrappers/Jackpot'
import { balanceOf, commentOf, gasOf, expectChainSucceeded, jackpotState, messageFrom, opOf, poke, walletAt } from './jackpot/setup'
import { A0, deliver, fresh, put, setNow } from './jackpot/scenario'

const G = (n: string | number) => toNano(String(n))
const notTaken = 'Hipo Jackpot: this token is not accepted'

function notification(queryId: bigint, amount: bigint, sender: Address | null): Cell {
    return beginCell()
        .storeUint(JackpotOp.transferNotification, 32)
        .storeUint(queryId, 64)
        .storeCoins(amount)
        .storeAddress(sender)
        .storeBit(false)
        .endCell()
}

function ownership(queryId: bigint, prevOwner: Address | null): Cell {
    return beginCell()
        .storeUint(JackpotOp.ownershipAssigned, 32)
        .storeUint(queryId, 64)
        .storeAddress(prevOwner)
        .storeBit(false)
        .endCell()
}

// The messages a transaction chain sent from `from` to `to`, with the op.
function sent(r: SendMessageResult, from: Address, to: Address, op: number) {
    const out = []
    for (const tx of r.transactions) {
        const info = tx.inMessage?.info
        if (info?.type !== 'internal' || info.src.toString() !== from.toString() || info.dest.toString() !== to.toString()) continue
        if (opOf(tx) === op) out.push({ tx, info, body: tx.inMessage!.body.beginParse() })
    }
    return out
}

describe('Foreign jettons and NFTs', () => {
    async function scene() {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const fakeWallet = await sc.env.blockchain.treasury('fake-wallet')
        return { ...sc, fakeWallet }
    }

    it('A return: a foreign jetton sent with fee::foreign_return comes back to its sender in full, with the comment and response_destination = the sender; the Jackpot’s balance ends where it was, the log’s fee included, and every counter is unchanged', async () => {
        const { env, players, fakeWallet } = await scene()
        await put(env, players[0], G('100'))
        const [user] = players
        const before = await balanceOf(env, env.jackpot.address)
        const state = await jackpotState(env)
        const r = await deliver(env, messageFrom(fakeWallet.address, env.jackpot.address, G('0.1'), notification(77n, G('5'), user.address), false))
        expectChainSucceeded(r)
        const [back] = sent(r, env.jackpot.address, fakeWallet.address, JackpotOp.sendTokens)
        expect(back).toBeDefined()
        const b = back.body
        b.skip(32)
        expect(b.loadUintBig(64)).toBe(77n)
        expect(b.loadCoins()).toBe(G('5'))
        expect(b.loadAddress().toString()).toBe(user.address.toString())
        expect(b.loadAddress().toString()).toBe(user.address.toString())
        expect(b.loadBit()).toBe(false) // no custom_payload
        expect(b.loadCoins()).toBe(1n)
        expect(commentOf(b.loadBit() ? b.loadRef() : beginCell().storeSlice(b).endCell())).toBe(notTaken)
        expect(back.info.bounce).toBe(true)
        expect(back.info.ihrFee).toBe(3n) // extra_flags = 3
        expect(await balanceOf(env, env.jackpot.address)).toBe(before)
        expect(await jackpotState(env)).toEqual(state)
        // the handler's gas, measured: foreign::gas is at least 1.5 times it, and the fee covers it at 400 nano-GRAM per
        // gas plus the transfer's forwarding and a TEP-74 wallet's own work (0.03 GRAM)
        const gas = gasOf(r, env.jackpot.address)[0].gas
        const constants = readFileSync('contracts/imports/constants.fc', 'utf8')
        const constant = (name: string) => BigInt(new RegExp(`const int ${name} = (\\d+);`).exec(constants)![1])
        console.log('foreign-token handler: gas', gas.toString(), 'foreign::gas', constant('foreign::gas').toString())
        expect(gas * 3n).toBeLessThanOrEqual(constant('foreign::gas') * 2n)
        expect(gas * 400n + 30_000_000n + 5_000_000n).toBeLessThanOrEqual(constant('fee::foreign_return'))
        const [log] = logsOf<ForeignReturnLog>(r.externals, LogTopic.foreignReturn)
        expect(log).toMatchObject({ amount: G('5'), sent: true })
        expect(log.from.toString()).toBe(fakeWallet.address.toString())
        expect(log.sender?.toString()).toBe(user.address.toString())
    }, 200000)

    it('A short value: a foreign jetton sent with less than fee::foreign_return stays with the Jackpot; the log is written only when the value covers its fee; the balance does not fall; rescue_jetton from the governor then sends it on, from anyone else it is refused', async () => {
        const { env, players, fakeWallet } = await scene()
        const [user, other] = players
        const before = await balanceOf(env, env.jackpot.address)
        const state = await jackpotState(env)
        const r = await deliver(env, messageFrom(fakeWallet.address, env.jackpot.address, G('0.05'), notification(1n, G('7'), user.address), false))
        expect(sent(r, env.jackpot.address, fakeWallet.address, JackpotOp.sendTokens)).toHaveLength(0)
        const [log] = logsOf<ForeignReturnLog>(r.externals, LogTopic.foreignReturn)
        expect(log.sent).toBe(false)
        expect(await balanceOf(env, env.jackpot.address)).toBeGreaterThan(before)
        expect(await jackpotState(env)).toEqual(state)
        // a value too small for the log: no log, and still no fall
        const mid = await balanceOf(env, env.jackpot.address)
        const tiny = await deliver(env, messageFrom(fakeWallet.address, env.jackpot.address, 500_000n, notification(2n, G('1'), user.address), false))
        expect(logsOf(tiny.externals, LogTopic.foreignReturn)).toHaveLength(0)
        expect(await balanceOf(env, env.jackpot.address)).toBeGreaterThanOrEqual(mid)
        // rescue: the governor only
        const denied = await env.jackpot.sendRescueJetton(other.getSender(), { value: G('0.1'), jettonWallet: fakeWallet.address, amount: G('7'), destination: user.address })
        expect(denied.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: JackpotError.accessDenied })
        const j0 = await balanceOf(env, env.jackpot.address)
        const ok = await env.jackpot.sendRescueJetton(env.governor.getSender(), { value: G('0.1'), jettonWallet: fakeWallet.address, amount: G('7'), destination: user.address, queryId: 9n })
        expectChainSucceeded(ok)
        const [move] = sent(ok, env.jackpot.address, fakeWallet.address, JackpotOp.sendTokens)
        move.body.skip(32)
        expect(move.body.loadUintBig(64)).toBe(9n)
        expect(move.body.loadCoins()).toBe(G('7'))
        expect(move.body.loadAddress().toString()).toBe(user.address.toString())
        expect(await balanceOf(env, env.jackpot.address)).toBeGreaterThanOrEqual(j0) // on the governor's value
    }, 200000)

    it('A fake: a transfer_notification naming the Jackpot as the sender, or a masterchain one, gets nothing back and moves nothing', async () => {
        const { env, fakeWallet } = await scene()
        const before = await balanceOf(env, env.jackpot.address)
        for (const sender of [env.jackpot.address, new Address(-1, Buffer.alloc(32, 5)), null]) {
            const r = await deliver(env, messageFrom(fakeWallet.address, env.jackpot.address, G('0.1'), notification(3n, G('1'), sender), false))
            expect(sent(r, env.jackpot.address, fakeWallet.address, JackpotOp.sendTokens)).toHaveLength(0)
        }
        expect(await balanceOf(env, env.jackpot.address)).toBeGreaterThanOrEqual(before)
    }, 100000)

    it('A fake wallet looping: a contract that answers every return with a new notification never drains the float; each returning step ends at the balance the Jackpot had before the message', async () => {
        const { env, players } = await scene()
        const stdlib = readFileSync('contracts/imports/stdlib.fc', 'utf8')
        const source = `#include "stdlib.fc";
() recv_internal(int balance, int value, cell msg, slice body) impure {
    if body.slice_bits() < 32 { return (); }
    if body~load_uint(32) != 0x0f8a7ea5 { return (); }
    slice cs = msg.begin_parse();
    cs~load_uint(4);
    slice src = cs~load_msg_addr();
    cell note = begin_cell().store_uint(0x7362d09c, 32).store_uint(0, 64).store_coins(1).store_slice(my_address()).store_uint(0, 1).end_cell();
    send_raw_message(begin_cell().store_uint(0x10, 6).store_slice(src).store_coins(0).store_uint(0, 107).store_slice(note.begin_parse()).end_cell(), 64);
}`
        const compiled = await compileFunc({ targets: ['loop.fc'], sources: (p: string) => (p === 'stdlib.fc' ? stdlib : source) })
        if (compiled.status === 'error') throw new Error(compiled.message)
        const init = { code: Cell.fromBase64(compiled.codeBoc), data: beginCell().endCell() }
        const looper = contractAddress(0, init)
        await env.blockchain.sendMessage({ ...messageFrom(players[0].address, looper, G('1'), beginCell().endCell(), false), init })
        const before = await balanceOf(env, env.jackpot.address)
        let steps = 0
        let returned = 0
        for await (const tx of await env.blockchain.sendMessageIter(messageFrom(looper, env.jackpot.address, G('0.1'), notification(5n, G('1'), looper), false))) {
            if (tx.inMessage?.info.dest?.toString() !== env.jackpot.address.toString()) continue
            steps++
            const balance = await balanceOf(env, env.jackpot.address)
            const back = [...tx.outMessages.values()].some((m) => m.info.type === 'internal' && m.info.dest.toString() === looper.toString())
            if (back) {
                returned++
                expect(balance).toBe(before) // a returning step ends exactly where it began
            } else {
                expect(balance).toBeGreaterThanOrEqual(before)
            }
            if (steps > 200) throw new Error('the loop did not end')
        }
        console.log('looping fake wallet: returns', returned, 'steps', steps)
        expect(returned).toBeGreaterThan(1)
        expect(await balanceOf(env, env.jackpot.address)).toBeGreaterThanOrEqual(before)
    }, 200000)

    it('A bounced return: a return refused by the foreign wallet changes no state, and the token is recovered with rescue_jetton', async () => {
        const { env, players } = await scene()
        const ghost = new Address(0, Buffer.alloc(32, 0xab)) // no account: the return bounces
        const before = await balanceOf(env, env.jackpot.address)
        const state = await jackpotState(env)
        const r = await deliver(env, messageFrom(ghost, env.jackpot.address, G('0.1'), notification(1n, G('3'), players[0].address), false))
        expect(r.transactions).toHaveTransaction({ from: ghost, to: env.jackpot.address, inMessageBounced: true })
        expect(await jackpotState(env)).toEqual(state)
        expect(await balanceOf(env, env.jackpot.address)).toBeGreaterThanOrEqual(before)
        const rescue = await env.jackpot.sendRescueJetton(env.governor.getSender(), { value: G('0.1'), jettonWallet: ghost, amount: G('3'), destination: players[0].address })
        expect(rescue.transactions).toHaveTransaction({ from: env.jackpot.address, to: ghost })
    }, 100000)

    it('The hGRAM wallet is refused: rescue_jetton naming the current hGRAM wallet throws, matched by parsed workchain and hash, and so does any address that is not a basechain addr_std; an old hGRAM wallet can be named', async () => {
        const { env, players, fakeWallet } = await scene()
        const hipoWallet = (await env.jackpot.getAddresses()).wallet
        const rescue = (jettonWallet: Address, destination = players[0].address) =>
            env.jackpot.sendRescueJetton(env.governor.getSender(), { value: G('0.1'), jettonWallet, amount: 1n, destination })
        const refused = await rescue(hipoWallet)
        expect(refused.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: JackpotError.invalidParameters })
        const master = await rescue(new Address(-1, Buffer.alloc(32, 1)))
        expect(master.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: JackpotError.invalidParameters })
        const toMaster = await rescue(fakeWallet.address, new Address(-1, Buffer.alloc(32, 1)))
        expect(toMaster.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: JackpotError.invalidParameters })
        // after a k = 1 repoint (halted), the old wallet is an ordinary jetton wallet to the Jackpot and can be named
        await env.jackpot.sendSetHalted(env.governor.getSender(), { value: G('0.05'), halted: true })
        const a = await env.jackpot.getAddresses()
        const set = await env.jackpot.sendSetHipoWallet(env.governor.getSender(), { value: G('0.05'), parent: a.parent, wallet: fakeWallet.address, walletCode: a.walletCode })
        expectChainSucceeded(set)
        const old = await rescue(hipoWallet)
        expect(old.transactions).toHaveTransaction({ from: env.jackpot.address, to: hipoWallet })
        const now = await rescue(fakeWallet.address)
        expect(now.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: JackpotError.invalidParameters })
    }, 100000)

    it('NFTs: an NFT sent with fee::foreign_return goes back to prev_owner; one sent with less, with an addr_none prev_owner, or with the Jackpot as prev_owner, is held, and rescue_nft sends it on', async () => {
        const { env, players } = await scene()
        const nft = await env.blockchain.treasury('nft-item')
        const [user, other] = players
        const before = await balanceOf(env, env.jackpot.address)
        const state = await jackpotState(env)
        const back = await deliver(env, messageFrom(nft.address, env.jackpot.address, G('0.1'), ownership(12n, user.address), false))
        const [move] = sent(back, env.jackpot.address, nft.address, JackpotOp.nftTransfer)
        move.body.skip(32)
        expect(move.body.loadUintBig(64)).toBe(12n)
        expect(move.body.loadAddress().toString()).toBe(user.address.toString())
        expect(move.body.loadAddress().toString()).toBe(user.address.toString())
        expect(move.body.loadBit()).toBe(false)
        expect(move.body.loadCoins()).toBe(1n)
        expect(move.body.loadBit()).toBe(true)
        expect(commentOf(move.body.loadRef())).toBe(notTaken)
        expect(await balanceOf(env, env.jackpot.address)).toBe(before)
        expect(await jackpotState(env)).toEqual(state)
        expect(logsOf<ForeignReturnLog>(back.externals, LogTopic.foreignReturn)[0].sent).toBe(true)
        // held: too little value, a mint, the Jackpot itself
        for (const [value, prev] of [
            [G('0.05'), user.address],
            [G('0.1'), null],
            [G('0.1'), env.jackpot.address],
        ] as const) {
            const r = await deliver(env, messageFrom(nft.address, env.jackpot.address, value, ownership(13n, prev), false))
            expect(sent(r, env.jackpot.address, nft.address, JackpotOp.nftTransfer)).toHaveLength(0)
            expect(logsOf<ForeignReturnLog>(r.externals, LogTopic.foreignReturn)[0].sent).toBe(false)
        }
        const denied = await env.jackpot.sendRescueNft(other.getSender(), { value: G('0.1'), nft: nft.address, destination: user.address })
        expect(denied.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: JackpotError.accessDenied })
        const ok = await env.jackpot.sendRescueNft(env.governor.getSender(), { value: G('0.1'), nft: nft.address, destination: user.address, queryId: 4n })
        const [rescued] = sent(ok, env.jackpot.address, nft.address, JackpotOp.nftTransfer)
        rescued.body.skip(32)
        expect(rescued.body.loadUintBig(64)).toBe(4n)
        expect(rescued.body.loadAddress().toString()).toBe(user.address.toString())
        const masterNft = await env.jackpot.sendRescueNft(env.governor.getSender(), { value: G('0.1'), nft: new Address(-1, Buffer.alloc(32, 2)), destination: user.address })
        expect(masterNft.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: JackpotError.invalidParameters })
    }, 100000)
})

describe('Hipo upgrades: the setters', () => {
    it('set_hipo_wallet and set_treasury are refused while not halted and for any address that is not a basechain addr_std without anycast; after both, for a k = 1 change, deposits arrive through the new wallet, withdrawals pay from it, pokes ask the new treasury, each writes its log, and a notification from the old wallet is sent back as foreign', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const { env, players } = sc
        const [alice, bob] = players
        await put(env, alice, G('100'))
        const newWallet = await env.blockchain.treasury('new-hipo-wallet')
        const newTreasury = await env.blockchain.treasury('new-treasury')
        const a = await env.jackpot.getAddresses()
        const setWallet = (wallet: Address | Cell = newWallet.address) =>
            wallet instanceof Address
                ? env.jackpot.sendSetHipoWallet(env.governor.getSender(), { value: G('0.05'), parent: a.parent, wallet, walletCode: a.walletCode })
                : env.jackpot.sendMessage(env.governor.getSender(), G('0.05'), wallet)
        const setTreasury = (treasury: Address) => env.jackpot.sendSetTreasury(env.governor.getSender(), { value: G('0.05'), treasury })
        const refused = (r: SendMessageResult, code: number) => { expect(r.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: code }); }
        // not halted
        refused(await setWallet(), JackpotError.invalidParameters)
        refused(await setTreasury(newTreasury.address), JackpotError.invalidParameters)
        await env.jackpot.sendSetHalted(env.governor.getSender(), { value: G('0.05'), halted: true })
        // governor only, basechain only, no anycast
        const stranger = await env.jackpot.sendSetTreasury(bob.getSender(), { value: G('0.05'), treasury: newTreasury.address })
        refused(stranger, JackpotError.accessDenied)
        const master = new Address(-1, Buffer.alloc(32, 7))
        refused(await setTreasury(master), JackpotError.invalidParameters)
        refused(await setWallet(master), JackpotError.invalidParameters)
        const anycast = beginCell().storeUint(2, 2).storeUint(1, 1).storeUint(1, 5).storeUint(1, 1).storeInt(0, 8).storeBuffer(Buffer.alloc(32, 9)).endCell()
        const anycastTreasury = beginCell().storeUint(JackpotOp.setTreasury, 32).storeUint(0, 64).storeSlice(anycast.beginParse()).endCell()
        // an anycast address is refused: the message throws
        expect((await env.jackpot.sendMessage(env.governor.getSender(), G('0.05'), anycastTreasury)).transactions).toHaveTransaction({ to: env.jackpot.address, success: false })
        const anycastWallet = beginCell().storeUint(JackpotOp.setHipoWallet, 32).storeUint(0, 64).storeAddress(a.parent).storeSlice(anycast.beginParse()).storeRef(a.walletCode).endCell()
        expect((await env.jackpot.sendMessage(env.governor.getSender(), G('0.05'), anycastWallet)).transactions).toHaveTransaction({ to: env.jackpot.address, success: false })
        // the setters, with their logs
        const oldWallet = a.wallet
        const w = await setWallet()
        expectChainSucceeded(w)
        const [wl] = logsOf<HipoWalletLog>(w.externals, LogTopic.hipoWallet)
        expect([wl.parent.toString(), wl.wallet.toString()]).toEqual([a.parent.toString(), newWallet.address.toString()])
        const t = await setTreasury(newTreasury.address)
        expectChainSucceeded(t)
        expect(logsOf<TreasuryLog>(t.externals, LogTopic.treasury)[0].treasury.toString()).toBe(newTreasury.address.toString())
        const after = await env.jackpot.getAddresses()
        expect([after.wallet.toString(), after.treasury.toString()]).toEqual([newWallet.address.toString(), newTreasury.address.toString()])
        await env.jackpot.sendSetHalted(env.governor.getSender(), { value: G('0.05'), halted: false })
        // deposits arrive through the new wallet: its notification books
        const dep = await deliver(env, messageFrom(newWallet.address, env.jackpot.address, env.fees.deposit + G('0.1'), notificationWithPayload(bob.address, G('40')), false))
        expectChainSucceeded(dep)
        expect(await balanceOf(env, walletAt(env, bob.address).address)).toBeGreaterThan(0n)
        expect((await walletAt(env, bob.address).getWalletState()).balance).toBeGreaterThan(0n)
        // withdrawals pay from it
        const pay = await walletAt(env, bob.address).sendBurn(bob.getSender(), { value: env.fees.withdraw, amount: 0n })
        expectChainSucceeded(pay)
        expect(sent(pay, env.jackpot.address, newWallet.address, JackpotOp.sendTokens)).toHaveLength(1)
        // pokes ask the new treasury
        setNow(env, A0 + 10)
        const p = await poke(env)
        expect(p.transactions).toHaveTransaction({ from: env.jackpot.address, to: newTreasury.address })
        // a notification from the old wallet is foreign now: sent back
        const foreign = await deliver(env, messageFrom(oldWallet, env.jackpot.address, G('0.1'), notification(2n, G('1'), alice.address), false))
        expect(sent(foreign, env.jackpot.address, oldWallet, JackpotOp.sendTokens)).toHaveLength(1)
    }, 300000)
})

// The notification of a deposit of `tokens` from `sender`, default options.
function notificationWithPayload(sender: Address, tokens: bigint): Cell {
    return notification(1n, tokens, sender)
}
