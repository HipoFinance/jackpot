/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests read state they just made */
// Amendment 2 (docs/specs/2026-11-06-jackpot-fees.md): every user-side fee is priced at the chain's current prices.
// The formulas to the nano-GRAM at two price sets, the gas pins, price jumps in the middle of a chain, a wallet in storage
// debt, the undo, the minimum and the fee, deposit_ready's floor, the wallet's reserve, the unstake bound.
import '@ton/test-utils'
import { readFileSync } from 'fs'
import { Blockchain } from '@ton/sandbox'
import { Cell, Dictionary, beginCell } from '@ton/core'
import { JackpotError, JackpotOp, burnAttach, withdrawOptions } from '../wrappers/Jackpot'
import {
    Env,
    balanceOf,
    expectChainSucceeded,
    expectSolvent,
    gasOf,
    hgramOf,
    jackpotState,
    jgramOf,
    messageFrom,
    walletAt,
    withdraw,
} from './jackpot/setup'
import { atJackpot, deliver, fresh, holdUntil, put, startDeposit, toAddr } from './jackpot/scenario'
import { forwardFee, gasFee, scalePrices, setGasPrices, setOldForwardPrices } from './jackpot/prices'

const G = (s: string) => BigInt(Math.round(Number(s) * 1e9))
const year5 = 157680000n

function sizeOf(...roots: Cell[]) {
    const seen = new Set<string>()
    let bits = 0
    const walk = (c: Cell) => {
        const h = c.hash().toString('hex')
        if (seen.has(h)) return
        seen.add(h)
        bits += c.bits.length
        c.refs.forEach(walk)
    }
    roots.forEach(walk)
    return { cells: seen.size, bits }
}

function constant(name: string): bigint {
    const text = readFileSync('contracts/imports/fees.fc', 'utf8') + readFileSync('contracts/imports/constants.fc', 'utf8')
    const m = new RegExp(`const int ${name} = ([0-9_]+);`).exec(text)
    if (m == null) throw new Error(`no constant ${name}`)
    return BigInt(m[1].replace(/_/g, ''))
}

// The latest basechain storage prices (config 18), per 65536 seconds.
function storagePrices(bc: Blockchain) {
    const cfg = Dictionary.loadDirect(Dictionary.Keys.BigInt(32), Dictionary.Values.Cell(), bc.config)
    const prices = Dictionary.loadDirect(
        Dictionary.Keys.Uint(32),
        {
            serialize: () => undefined,
            parse: (src) => {
                src.skip(8 + 32)
                return { bit: src.loadUintBig(64), cell: src.loadUintBig(64) }
            },
        },
        cfg.get(18n)!,
    )
    return prices.get(Math.max(...prices.keys()))!
}

function storageFee(bc: Blockchain, cells: bigint, bits: bigint, seconds: bigint) {
    const p = storagePrices(bc)
    return (cells * p.cell + bits * p.bit) * seconds / 65536n + ((cells * p.cell + bits * p.bit) * seconds % 65536n > 0n ? 1n : 0n)
}

// The fee formulas of the spec, written again here from the spec's text.
function formulas(bc: Blockchain, wallet: { cells: bigint; bits: bigint }) {
    const gas = (g: bigint) => gasFee(bc, g)
    const fwd = (c: bigint, b: bigint) => forwardFee(bc, c, b)
    const lump = forwardFee(bc, 0n, 0n)
    const simple = (c: bigint, b: bigint) => fwd(c, b) - lump
    const H = 2n
    const GJ = 60000n, GW = 18000n, GN = 110000n, Gpre = 30000n, GS = 150000n
    const hop = gas(GN) + fwd(1n, 545n)
    const updateMin = 4n * hop
    const updateValue = H * updateMin
    const release = 3n * (gas(GW) + fwd(0n, 0n))
    const hipoSend = storageFee(bc, 2n, 658n, year5) + gas(22369n) + simple(2n, 543n)
    const hipoUnstakeGas = 9040n + 6538n + 15798n + 7757n + 5960n + 6558n + 12316n + 17738n + 7757n + 5960n + 6558n + 12316n + 17738n + 7307n + 7179n
    const hipoUnstake = gas(hipoUnstakeGas) + 8n * fwd(1n, 1023n) + 4n * fwd(4n, 2046n) + 3n * fwd(0n, 0n)
    const payout = 2n * hipoSend + 3n * (fwd(10n, 9700n) - fwd(2n, 1023n))
    const payloadFee = 8n * simple(8n, 8184n)
    const nodeOpen = 150000000n + 20000000n
    const nodeShare = nodeOpen / 64n + nodeOpen / 4096n + nodeOpen / 262144n + 3n
    const walletStorage = storageFee(bc, wallet.cells, wallet.bits, year5)
    const prepare = fwd(wallet.cells + 2n, wallet.bits + 1241n)
    const ready = fwd(2n, 1241n), log = fwd(1n, 1023n), booked = fwd(1n, 1023n), note = fwd(2n, 1023n), zero = fwd(0n, 0n)
    const a = gas(GJ) + prepare + H * (gas(GW + GJ + GW) + ready + log + booked + 3n * zero) + updateValue + nodeShare + walletStorage
    const b = gas(GJ) + prepare + H * (gas(GW + GJ) + ready + log) + release + payout
    const deposit = (a > b ? a : b)
    const burn = gas(GW) + note + H * (gas(GJ) + log + zero) + updateValue + release + payout
    const burnArrives = burn - gas(GW) - note
    const walletMinimum = gas(GW) + fwd(2n, 1023n) + 3n * (gas(Gpre) + fwd(3n, 1176n) + gas(GW) + zero)
    // the burn the Jackpot sends carries a comment: one cell, 256 bits, and a forward amount of 1
    const wValue = prepare + H * (gas(GW) + fwd(3n, 1279n)) + burnArrives + 1n + 8n * simple(1n, 256n)
    return {
        hop, updateMin, updateValue, release, hipoSend, hipoUnstake, payout, payloadFee, deposit, burn, walletMinimum,
        walletStorage, nodeShare, wValue, w: gas(GJ) + wValue,
        poke: gas(22000n) + fwd(1n, 1023n) + H * (gas(40000n) + 2n * fwd(1n, 1023n)),
        submit: gas(GS) + fwd(1n, 1023n) + 2n * zero,
        refill: gas(GJ) + fwd(1n, 1023n) + H * hipoUnstake,
        tep89: gas(28000n) + fwd(1n, 1023n),
    }
}

describe('Fees: the formulas', () => {
    async function check(config: 'sandbox' | 'old forwarding at 400 nano-GRAM per gas') {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000') })
        const { env, players } = sc
        await put(env, players[0], G('100'))
        const wallet = walletAt(env, players[0].address)
        if (config !== 'sandbox') {
            setGasPrices(env.blockchain, 400n)
            setOldForwardPrices(env.blockchain)
        }
        const acc = (await env.blockchain.getContract(wallet.address)).accountState
        if (acc?.type !== 'active') throw new Error('no wallet')
        const size = sizeOf(acc.state.code!, acc.state.data!)
        const f = formulas(env.blockchain, { cells: constant('wallet::cells'), bits: constant('wallet::bits') })
        const fees = await env.jackpot.getJackpotFees()
        const parts = await env.jackpot.getFeeParts()
        console.log(config, JSON.stringify({ size, ...fees, ...parts }, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)))
        expect(fees.deposit).toBe(f.deposit)
        expect(fees.withdraw).toBe(f.burn)
        expect(fees.poke).toBe(f.poke)
        expect(fees.submit).toBe(f.submit)
        expect(fees.refill).toBe(f.refill)
        expect(fees.tep89).toBe(f.tep89)
        expect(fees.payoutFee).toBe(f.payout)
        expect(fees.payload).toBe(f.payloadFee)
        expect(fees.walletStorage).toBe(f.walletStorage)
        expect(fees.commentWithdraw).toBe(f.w)
        expect(parts.hop).toBe(f.hop)
        expect(parts.updateMin).toBe(f.updateMin)
        expect(parts.updateValue).toBe(f.updateValue)
        expect(parts.release).toBe(f.release)
        expect(parts.hipoSend).toBe(f.hipoSend)
        expect(parts.hipoUnstake).toBe(f.hipoUnstake)
        expect(parts.wValue).toBe(f.wValue)
        expect(fees.unstake).toBe(2n * f.hipoUnstake)
        // the wallet's minimum, with no storage debt: the getter never counts due_payment
        expect(await wallet.getWalletMinimumInternal()).toBe(f.walletMinimum)
    }

    it('get_jackpot_fees, get_fee_parts and get_wallet_minimum_internal equal the formulas to the nano-GRAM at the sandbox config', async () => {
        await check('sandbox')
    }, 200000)

    it('and at 400 nano-GRAM per gas with the old forwarding prices', async () => {
        await check('old forwarding at 400 nano-GRAM per gas')
    }, 200000)
})

describe('Fees: the gas pins', () => {
    it('the built wallet has the cells and bits the minimum was priced for; the Jackpot reaches its fee check in burn_notification within 30,000 gas', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000') })
        const { env, players } = sc
        await put(env, players[0], G('100'))
        const w = (await env.blockchain.getContract(walletAt(env, players[0].address).address)).accountState
        if (w?.type !== 'active') throw new Error('no wallet')
        const size = sizeOf(w.state.code!, w.state.data!)
        expect(BigInt(size.cells)).toBe(constant('wallet::cells'))
        expect(BigInt(size.bits)).toBe(constant('wallet::bits'))
        // a burn that reaches the Jackpot short: it throws at the fee check
        const wallet = walletAt(env, players[0].address)
        const r = await wallet.sendBurn(players[0].getSender(), { value: (await wallet.getWalletMinimumInternal()) + 1_000_000n, amount: G('10') })
        const g = gasOf(r, env.jackpot.address).find((x) => x.op === JackpotOp.burnNotification)!
        console.log('burn_notification up to its fee check:', g.gas.toString(), 'gas')
        expect(g.gas).toBeLessThanOrEqual(constant('bound::pre'))
        expect(r.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: JackpotError.insufficientFee })
    }, 200000)

    it('every handler measured stays within its bound divided by 1.5', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const { env, players } = sc
        const rows: [string, bigint, bigint][] = []
        const gas = (r: Awaited<ReturnType<typeof withdraw>>, op: number, who: 'jackpot' | 'wallet') => {
            const addr = who === 'jackpot' ? env.jackpot.address : walletAt(env, players[0].address).address
            return gasOf(r, addr).filter((x) => x.op === op).reduce((m, x) => (x.gas > m ? x.gas : m), 0n)
        }
        const d1 = await put(env, players[0], G('100'))
        rows.push(['transfer_notification', gas(d1.result, JackpotOp.transferNotification, 'jackpot'), constant('bound::jackpot')])
        rows.push(['deposit_ready', gas(d1.result, JackpotOp.depositReady, 'jackpot'), constant('bound::jackpot')])
        rows.push(['prepare_deposit', gas(d1.result, JackpotOp.prepareDeposit, 'wallet'), constant('bound::wallet')])
        rows.push(['deposit_booked', gas(d1.result, JackpotOp.depositBooked, 'wallet'), constant('bound::wallet')])
        const b = await withdraw(env, players[0], G('10'))
        rows.push(['burn', gas(b, JackpotOp.burn, 'wallet'), constant('bound::wallet')])
        rows.push(['burn_notification', gas(b, JackpotOp.burnNotification, 'jackpot'), constant('bound::jackpot')])
        // the node hop's worst case is pinned in Gas.spec (73,226 gas measured, bound 110,000)
        for (const [name, used, bound] of rows) console.log('GASROW', name, used.toString(), 'of', bound.toString())
        for (const [, used, bound] of rows) expect(used * 3n).toBeLessThanOrEqual(bound * 2n)
        expect(constant('bound::node')).toBeGreaterThanOrEqual((73226n * 3n) / 2n)
    }, 300000)
})

// The prices rise by num/den between two transactions of one chain.
const jumps: [string, bigint, bigint][] = [['1.5', 3n, 2n], ['2', 2n, 1n], ['3', 3n, 1n], ['3.5', 7n, 2n]]

async function agreeAfter(env: Env, player: { address: import('@ton/core').Address }, walletLives = true) {
    await expectSolvent(env)
    const s = await jackpotState(env)
    expect(s.incomingTokens).toBe(0n)
    expect(s.tickets).toBe(s.principal)
    const account = (await env.blockchain.getContract(walletAt(env, player.address).address)).accountState
    if (walletLives && account?.type === 'active') {
        expect((await walletAt(env, player.address).getWalletState()).pending).toBe(0n)
    }
}

describe('Fees: price jumps in the middle of a chain', () => {
    for (const [name, num, den] of jumps) {
        it(`a deposit with the prices ${name} times higher after each leg: it books and pays, or ends in a clean refusal`, async () => {
            for (const leg of ['transfer_notification', 'prepare_deposit', 'deposit_ready'] as const) {
                const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
                const { env, players } = sc
                await put(env, players[1], G('100')) // position 0 exists
                const p = players[0]
                const before = await balanceOf(env, env.jackpot.address)
                const h0 = await hgramOf(env, p.address)
                const stop =
                    leg === 'transfer_notification'
                        ? atJackpot(env, JackpotOp.transferNotification)
                        : leg === 'prepare_deposit'
                          ? toAddr(walletAt(env, p.address).address)
                          : atJackpot(env, JackpotOp.depositReady)
                const outs = await startDeposit(env, p, G('50'), stop)
                scalePrices(env.blockchain, num, den)
                for (const m of outs) await deliver(env, m)
                await agreeAfter(env, p, leg !== 'transfer_notification' || num <= 2n * den)
                const j = await jgramOf(env, p.address)
                const h1 = await hgramOf(env, p.address)
                // booked, or refused with the tokens back
                expect(j > 0n || h1 === h0).toBe(true)
                if (num <= 2n * den) {
                    expect(j).toBeGreaterThan(0n)
                    expect(await balanceOf(env, env.jackpot.address)).toBeGreaterThanOrEqual(before - 3n * G('0.01'))
                }
            }
        }, 600000)

        it(`a burn with the prices ${name} times higher between the wallet and the Jackpot: it pays, or the wallet restores the balance`, async () => {
            const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
            const { env, players } = sc
            await put(env, players[1], G('100'))
            await put(env, players[0], G('100'))
            const wallet = walletAt(env, players[0].address)
            const j0 = await jgramOf(env, players[0].address)
            const h0 = await hgramOf(env, players[0].address)
            const outs = await holdUntil(
                env,
                messageFrom(players[0].address, wallet.address, env.fees.withdraw, beginCell().storeUint(JackpotOp.burn, 32).storeUint(1, 64).storeCoins(G('10')).storeAddress(null).storeMaybeRef(null).endCell()),
                toAddr(wallet.address),
            )
            scalePrices(env.blockchain, num, den)
            for (const m of outs) await deliver(env, m)
            await agreeAfter(env, players[0])
            const j1 = await jgramOf(env, players[0].address)
            const h1 = await hgramOf(env, players[0].address)
            // paid: the balance fell by 10 and the hGRAM rose; refused: both unchanged
            expect((j1 === j0 - G('10') && h1 > h0) || (j1 === j0 && h1 === h0)).toBe(true)
            if (num <= 3n * den) expect(j1 === j0 - G('10') || j1 === j0).toBe(true)
        }, 600000)
    }
})

// A wallet with an old last_paid and storage debt just below the freeze limit (0.1 GRAM).
async function indebt(env: Env, owner: { address: import('@ton/core').Address }, debt: bigint, balance: bigint) {
    const address = walletAt(env, owner.address).address
    const acc = (await env.blockchain.getContract(address)).account
    await env.blockchain.setShardAccount(address, {
        ...acc,
        account: {
            ...acc.account!,
            storage: { ...acc.account!.storage, balance: { coins: balance } },
            storageStats: { ...acc.account!.storageStats, lastPaid: (env.blockchain.now ?? 0) - 1000, duePayment: debt },
        },
    })
}

describe('Fees: a wallet in storage debt', () => {
    it('an owner burn carrying exactly wallet_minimum_internal is refused by the Jackpot, and the wallet restores the balance', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000') })
        const { env, players } = sc
        const [a] = players
        await put(env, a, G('100'))
        const wallet = walletAt(env, a.address)
        await indebt(env, a, G('0.09'), G('0.01'))
        const minimum = await wallet.getWalletMinimumInternal()
        // the getter runs without a storage phase, so it shows the minimum with no debt; the wallet adds its debt to it
        const value = minimum + G('0.09')
        const outs = await holdUntil(
            env,
            messageFrom(a.address, wallet.address, value, beginCell().storeUint(JackpotOp.burn, 32).storeUint(1, 64).storeCoins(G('10')).storeAddress(null).storeMaybeRef(null).endCell()),
            toAddr(wallet.address),
        )
        // the price steps up between the wallet's handler and the Jackpot's fee check, so the Jackpot refuses
        scalePrices(env.blockchain, 4n, 1n)
        for (const m of outs) {
            const r = await deliver(env, m)
            expect(r.transactions).toHaveTransaction({ from: wallet.address, to: env.jackpot.address, success: false })
            expect(r.transactions).toHaveTransaction({ from: env.jackpot.address, to: wallet.address, inMessageBounced: true })
        }
        expect(await jgramOf(env, a.address)).toBe(G('100'))
        expect((await wallet.getWalletState()).pending).toBe(0n)
    }, 200000)

    it('a burn from the Jackpot below the wallet minimum for its comment, or above the no-debt minimum but below the one with the debt, is forwarded to the owner and nothing is burned', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000') })
        const { env, players } = sc
        const [a] = players
        await put(env, a, G('100'))
        const wallet = walletAt(env, a.address)
        const body = beginCell().storeUint(JackpotOp.burn, 32).storeUint(9, 64).storeCoins(0n).storeAddress(null).storeMaybeRef(null).endCell()
        const getter = await wallet.getWalletMinimumInternal()
        // the Jackpot's burn carries a comment (one cell, 256 bits): its minimum is the getter's plus that forwarding
        const comment = forwardFee(env.blockchain, 3n, 1279n) - forwardFee(env.blockchain, 2n, 1023n)
        const snap = env.blockchain.snapshot()
        const notBurned = async (value: bigint, label: string) => {
            const owner0 = await balanceOf(env, a.address)
            const r = await deliver(env, messageFrom(env.jackpot.address, wallet.address, value, body))
            expect({ label, ok: r.transactions.some((t) => t.inMessage?.info.dest?.toString() === wallet.address.toString() && t.description.type === 'generic' && t.description.computePhase.type === 'vm' && t.description.computePhase.success) }).toEqual({ label, ok: true })
            expect(r.transactions).not.toHaveTransaction({ from: wallet.address, to: env.jackpot.address })
            expect({ label, jgram: await jgramOf(env, a.address) }).toEqual({ label, jgram: G('100') })
            expect(await balanceOf(env, a.address)).toBeGreaterThan(owner0)
        }
        // no debt: one nano-GRAM short of the minimum for the comment
        await notBurned(getter + comment - 1n, 'comment size')
        await env.blockchain.loadFrom(snap)
        // in debt of 0.09 GRAM: above the no-debt minimum, below the one that counts the debt
        await indebt(env, a, G('0.09'), G('0.01'))
        await notBurned(getter + comment + G('0.04'), 'debt')
        await env.blockchain.loadFrom(snap)
        // and at the minimum for the comment with no debt, it is burned
        const ok = await deliver(env, messageFrom(env.jackpot.address, wallet.address, getter + comment + 50_000_000n, body))
        expect(ok.transactions).toHaveTransaction({ from: wallet.address, to: env.jackpot.address })
    }, 200000)
})

describe('Fees: burnAttach', () => {
    it('a burn carrying burnAttach from a wallet in debt goes through; one carrying the getter minimum plus the fee alone does not', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000') })
        const { env, players } = sc
        const [a] = players
        await put(env, a, G('100'))
        const wallet = walletAt(env, a.address)
        await indebt(env, a, G('0.09'), G('0.01'))
        const acc = (await env.blockchain.getContract(wallet.address)).account.account!
        const now = env.blockchain.now ?? 0
        const attach = burnAttach(
            env.fees.withdraw,
            await wallet.getWalletMinimumInternal(),
            0n,
            { balance: acc.storage.balance.coins, duePayment: acc.storageStats.duePayment ?? 0n, lastPaid: acc.storageStats.lastPaid },
            now,
        )
        expect(attach).toBeGreaterThan(env.fees.withdraw)
        const snap = env.blockchain.snapshot()
        // the wallet's minimum in the transaction counts the debt: the getter's value alone is refused by the wallet
        const short = await wallet.sendBurn(a.getSender(), { value: await wallet.getWalletMinimumInternal(), amount: G('10') })
        expect(short.transactions).toHaveTransaction({ to: wallet.address, success: false })
        await env.blockchain.loadFrom(snap)
        expectChainSucceeded(await wallet.sendBurn(a.getSender(), { value: attach, amount: G('10') }))
        expect(await jgramOf(env, a.address)).toBe(G('90'))
    }, 200000)
})

describe('Fees: burnAttach with a payload', () => {
    it('a cap-size payload from a wallet in debt of 0.09 GRAM, at 400 nano-GRAM per gas with the old forwarding prices, goes through at burnAttach', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000') })
        const { env, players } = sc
        const [a] = players
        await put(env, a, G('100'))
        setGasPrices(env.blockchain, 400n)
        setOldForwardPrices(env.blockchain)
        const wallet = walletAt(env, a.address)
        await indebt(env, a, G('0.09'), G('0.01'))
        const acc = (await env.blockchain.getContract(wallet.address)).account.account!
        const forward = G('0.01')
        const burnFee = await env.jackpot.getBurnFee(forward, 8, 8 * 1023)
        const payloadFee = (await env.jackpot.getJackpotFees()).payload
        const attach = burnAttach(
            burnFee,
            await wallet.getWalletMinimumInternal(),
            payloadFee,
            { balance: acc.storage.balance.coins, duePayment: acc.storageStats.duePayment ?? 0n, lastPaid: acc.storageStats.lastPaid },
            env.blockchain.now ?? 0,
        )
        const options = withdrawOptions({ forwardTonAmount: forward, forwardPayload: chain(8) })
        expectChainSucceeded(await wallet.sendBurn(a.getSender(), { value: attach, amount: G('10'), options }))
        expect(await jgramOf(env, a.address)).toBe(G('90'))
    }, 300000)
})

describe('Fees: the undo, the minimum and the fee', () => {
    function bounceBooked(env: Env, owner: import('@ton/core').Address, value: bigint) {
        const reply = beginCell().storeAddress(owner).storeAddress(owner).storeCoins(1n).storeMaybeRef(null).storeAddress(owner).endCell()
        const original = beginCell().storeUint(JackpotOp.depositBooked, 32).storeUint(5, 64).storeCoins(G('10')).storeUint(0, 32).storeRef(reply).endCell()
        const m = messageFrom(walletAt(env, owner).address, env.jackpot.address, value, beginCell().storeUint(0xfffffffe, 32).storeRef(original).endCell(), false)
        return { ...m, info: { ...(m.info as object), bounced: true } as typeof m.info }
    }

    it('the smallest bounce deposit_booked can carry is undone in full; the float falls by at most update_value + release + gas(G_J); the undo reaches set_gas_limit within 20,000 gas', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000') })
        const { env, players } = sc
        await put(env, players[0], G('100'))
        const s0 = await jackpotState(env)
        const parts = await env.jackpot.getFeeParts()
        // the smallest bounce: its forwarding and H wallet handlers; the gas available is below 20,000 + the rest
        const value = gasFee(env.blockchain, 20000n)
        const before = await balanceOf(env, env.jackpot.address)
        const r = await env.blockchain.sendMessage(bounceBooked(env, players[0].address, value))
        expectChainSucceeded(r)
        const s1 = await jackpotState(env)
        expect([s1.principal, s1.tickets]).toEqual([s0.principal - G('10'), s0.tickets - G('10')])
        const fall = before - (await balanceOf(env, env.jackpot.address))
        expect(fall).toBeLessThanOrEqual(parts.updateValue + parts.release + gasFee(env.blockchain, constant('bound::jackpot')))
    }, 200000)

    it('the smallest undo with an 8-cell, cap-size payload in the reply is undone: booked_min adds its forwarding', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000') })
        const { env, players } = sc
        await put(env, players[0], G('100'))
        const s0 = await jackpotState(env)
        let payload = beginCell().storeBuffer(Buffer.alloc(127, 7)).storeUint(0x7f, 7).endCell()
        for (let i = 1; i < 8; i++) payload = beginCell().storeBuffer(Buffer.alloc(127, 7 + i)).storeUint(0x7f, 7).storeRef(payload).endCell()
        const reply = beginCell().storeAddress(players[0].address).storeAddress(players[0].address).storeCoins(1n).storeMaybeRef(payload).storeAddress(players[0].address).endCell()
        const original = beginCell().storeUint(JackpotOp.depositBooked, 32).storeUint(5, 64).storeCoins(G('10')).storeUint(0, 32).storeRef(reply).endCell()
        const m = messageFrom(walletAt(env, players[0].address).address, env.jackpot.address, gasFee(env.blockchain, 20000n), beginCell().storeUint(0xfffffffe, 32).storeRef(original).endCell(), false)
        const r = await env.blockchain.sendMessage({ ...m, info: { ...(m.info as object), bounced: true } as typeof m.info })
        expectChainSucceeded(r)
        const s1 = await jackpotState(env)
        expect([s1.principal, s1.tickets]).toEqual([s0.principal - G('10'), s0.tickets - G('10')])
    }, 200000)

    it('a burn with a value between the wallet minimum and the burn fee bounces, and the wallet restores the balance', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000') })
        const { env, players } = sc
        const [a] = players
        await put(env, a, G('100'))
        const wallet = walletAt(env, a.address)
        const minimum = await wallet.getWalletMinimumInternal()
        const value = (minimum + env.fees.withdraw) / 2n
        const r = await wallet.sendBurn(a.getSender(), { value, amount: G('10') })
        expect(r.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: JackpotError.insufficientFee })
        expect(await jgramOf(env, a.address)).toBe(G('100'))
        // and at the fee it goes through
        expectChainSucceeded(await wallet.sendBurn(a.getSender(), { value: env.fees.withdraw, amount: G('10') }))
        expect(await jgramOf(env, a.address)).toBe(G('90'))
    }, 200000)
})

describe('Fees: deposit_ready, the wallet reserve, the unstake bound', () => {
    it('deposit_ready below update_min + booked_min is refused with low_value and refunded; with room for them it books', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const { env, players } = sc
        await put(env, players[1], G('100'))
        const [a] = players
        const parts = await env.jackpot.getFeeParts()
        const outs = await startDeposit(env, a, G('30'), toAddr(walletAt(env, a.address).address))
        const ready = outs.find((m) => m.info.dest?.toString() === env.jackpot.address.toString())!
        const withValue = (coins: bigint) => ({ ...ready, info: { ...(ready.info as object), value: { coins } } as typeof ready.info })
        const snap = env.blockchain.snapshot()
        const low = await deliver(env, withValue(parts.updateMin + parts.bookedMin))
        expect(low.transactions).toHaveTransaction({ to: env.jackpot.address, success: true })
        expect(await jgramOf(env, a.address)).toBe(0n)
        await env.blockchain.loadFrom(snap)
        const ok = await deliver(env, withValue(parts.updateMin + parts.bookedMin + gasFee(env.blockchain, 60000n) + 3n * forwardFee(env.blockchain, 2n, 1023n)))
        expectChainSucceeded(ok)
        expect(await jgramOf(env, a.address)).toBeGreaterThan(0n)
    }, 300000)

    it('a booking leaves the new wallet holding wallet_storage at the current price', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const { env, players } = sc
        await put(env, players[1], G('100'))
        await put(env, players[0], G('50'))
        const wallet = walletAt(env, players[0].address)
        expect(await balanceOf(env, wallet.address)).toBe(env.fees.walletStorage)
    }, 200000)

    it('the run-time unstake stays at or below fee::unstake_bound up to 400 nano-GRAM per gas', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000') })
        const { env } = sc
        setGasPrices(env.blockchain, 400n)
        const fees = await env.jackpot.getJackpotFees()
        console.log('unstake at 400 nano-GRAM per gas', fees.unstake.toString())
        expect(fees.unstake).toBeLessThanOrEqual(constant('fee::unstake_bound'))
        // and with the old forwarding prices as well
        setOldForwardPrices(env.blockchain)
        expect((await env.jackpot.getJackpotFees()).unstake).toBeLessThanOrEqual(constant('fee::unstake_bound'))
    }, 200000)
})

describe('Fees: the submit on the production build', () => {
    it('the submit with the recorded drand round uses at most 150,000 / 1.5 gas, and the keeper ends ahead at the published fee', async () => {
        const { toNano } = await import('@ton/core')
        const { boundaryOf, depositHgram, drawRounds, makeBoundary, mintHgram, setupJackpot, submitRound } = await import('./jackpot/setup')
        const round = drawRounds[0]
        const env = await setupJackpot({ time: boundaryOf(round) - 3600, config: { minGap: 3600, minDeposit: toNano('1') } })
        for (const n of ['pa', 'pb']) {
            const p = await env.blockchain.treasury(n)
            await mintHgram(env, p, toNano('1000'))
            await depositHgram(env, p, toNano('300'), { minC: 0n })
        }
        await makeBoundary(env, { at: boundaryOf(round), gram: toNano('40') })
        const k0 = await balanceOf(env, env.keeper.address)
        const r = await submitRound(env, round)
        expectChainSucceeded(r)
        const g = gasOf(r, env.jackpot.address).find((x) => x.op === JackpotOp.submitRandomness)!.gas
        console.log('GASROW submit (production drand check)', g.toString(), 'of', constant('bound::submit').toString())
        expect(g * 3n).toBeLessThanOrEqual(constant('bound::submit') * 2n)
        // the keeper spent less than the fee: it nets the reward less its gas
        expect((await balanceOf(env, env.keeper.address)) - k0).toBeGreaterThan(0n)
    }, 300000)
})

// A payload chain of `cells` cells of 1,023 bits each (the cap is 8): its size outside the root is (cells, 1,023 · cells).
function chain(cells: number): Cell | null {
    if (cells === 0) return null
    let c = beginCell().storeBuffer(Buffer.alloc(127, 1)).storeUint(0x7f, 7).endCell()
    for (let i = 2; i <= cells; i++) c = beginCell().storeBuffer(Buffer.alloc(127, i)).storeUint(0x7f, 7).storeRef(c).endCell()
    return c
}

describe('Fees: the first booking', () => {
    it('the top node’s StateInit has the size its forwarding is priced for', async () => {
        const { nodeCode } = await (await import('./jackpot/setup')).codes()
        const { Node } = await import('../wrappers/Node')
        const sc = await fresh({ minDeposit: 1n, players: 0 })
        const init = Node.createFromConfig({ jackpot: sc.env.jackpot.address, level: 4, index: 0n }, nodeCode).init!
        const size = sizeOf(init.code, init.data)
        // the init cell, the code and data, and the update's body of 545 bits
        expect(BigInt(size.cells) + 1n).toBe(constant('node::cells'))
        expect(BigInt(size.bits) + 545n).toBe(constant('node::bits'))
    }, 100000)

    for (const [n, d] of [[11n, 10n], [5n, 4n], [3n, 2n], [7n, 4n], [2n, 1n]] as const) {
        it(`a first-ever deposit (position 0 not taken) at the published fee books when the prices rise ${(Number(n) / Number(d)).toString()} times after the transfer notification or after prepare_deposit`, async () => {
            for (const leg of ['transfer_notification', 'prepare_deposit'] as const) {
                const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000') })
                const { env, players } = sc
                const p = players[0]
                const wallet = walletAt(env, p.address)
                const stop = leg === 'transfer_notification' ? atJackpot(env, JackpotOp.transferNotification) : toAddr(wallet.address)
                const outs = await startDeposit(env, p, G('50'), stop)
                scalePrices(env.blockchain, n, d)
                for (const m of outs) await deliver(env, m)
                const s = await jackpotState(env)
                expect(await jgramOf(env, p.address)).toBe(s.principal)
                expect(s.principal).toBeGreaterThan(0n)
                expect(s.tickets).toBe(s.principal)
                expect((await wallet.getWalletState()).pending).toBe(0n)
                await expectSolvent(env)
            }
        }, 600000)
    }

    it('deposit_ready on a fresh Jackpot: below update_min + booked_min is refused, with room for them it books', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000') })
        const { env, players } = sc
        const [a] = players
        const parts = await env.jackpot.getFeeParts()
        const outs = await startDeposit(env, a, G('30'), toAddr(walletAt(env, a.address).address))
        const ready = outs.find((m) => m.info.dest?.toString() === env.jackpot.address.toString())!
        const withValue = (coins: bigint) => ({ ...ready, info: { ...(ready.info as object), value: { coins } } as typeof ready.info })
        const snap = env.blockchain.snapshot()
        const low = await deliver(env, withValue(parts.updateMin + parts.bookedMin))
        expect(low.transactions).toHaveTransaction({ to: env.jackpot.address, success: true })
        expect(await jgramOf(env, a.address)).toBe(0n)
        await env.blockchain.loadFrom(snap)
        const ok = await deliver(env, withValue(parts.updateMin + parts.bookedMin + gasFee(env.blockchain, 60000n) + 3n * forwardFee(env.blockchain, 2n, 1023n)))
        expectChainSucceeded(ok)
        expect(await jgramOf(env, a.address)).toBeGreaterThan(0n)
    }, 300000)
})

describe('Fees: a burn at its published fee', () => {
    for (const config of ['sandbox', '400 nano-GRAM per gas with the old forwarding prices'] as const) {
        it(`with 0, 1, 3, 4, 6 and 8 payload cells, with and without a response address and a forward amount, at ${config}: paid`, async () => {
            const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
            const { env, players } = sc
            await put(env, players[1], G('100'))
            await put(env, players[0], G('100'))
            if (config !== 'sandbox') {
                setGasPrices(env.blockchain, 400n)
                setOldForwardPrices(env.blockchain)
            }
            const wallet = walletAt(env, players[0].address)
            const snap = env.blockchain.snapshot()
            for (const cells of [0, 1, 3, 4, 6, 8]) {
                for (const response of [false, true]) {
                    for (const forward of [0n, G('0.01')]) {
                        await env.blockchain.loadFrom(snap)
                        const payload = chain(cells)
                        const fee = await env.jackpot.getBurnFee(forward, cells, cells * 1023)
                        const h0 = await hgramOf(env, players[0].address)
                        const options = payload != null || forward > 0n ? withdrawOptions({ forwardTonAmount: forward, forwardPayload: payload }) : null
                        const r = await wallet.sendBurn(players[0].getSender(), {
                            value: fee,
                            amount: G('10'),
                            responseDestination: response ? players[1].address : null,
                            options,
                        })
                        const label = `${config} cells ${String(cells)} response ${String(response)} forward ${forward.toString()}`
                        expect({ label, ok: (await jgramOf(env, players[0].address)) === G('90') }).toEqual({ label, ok: true })
                        expect({ label, paid: (await hgramOf(env, players[0].address)) > h0 }).toEqual({ label, paid: true })
                        expect(r.transactions).not.toHaveTransaction({ to: env.jackpot.address, success: false })
                    }
                }
            }
        }, 900000)
    }
})

describe('Fees: the gas pins of the longer paths', () => {
    it('a full burn and a partial burn with a cap payload, a w burn and TEP-89 stay within their bounds divided by 1.5; G_pre with an 8-cell payload stays under 30,000', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const { env, players } = sc
        await put(env, players[1], G('100'))
        await put(env, players[0], G('100'))
        const wallet = walletAt(env, players[0].address)
        const within = (name: string, gas: bigint, bound: bigint) => {
            console.log('GASROW', name, gas.toString(), 'of', bound.toString())
            expect(gas * 3n).toBeLessThanOrEqual(bound * 2n)
        }
        const maxOf = (r: Awaited<ReturnType<typeof withdraw>>, address: import('@ton/core').Address, op: number) =>
            gasOf(r, address).filter((g) => g.op === op).reduce((m, g) => (g.gas > m ? g.gas : m), 0n)
        const options = withdrawOptions({ forwardTonAmount: G('0.01'), forwardPayload: chain(8) })
        const fee = await env.jackpot.getBurnFee(G('0.01'), 8, 8 * 1023)
        const snap = env.blockchain.snapshot()
        for (const amount of [G('10'), 0n]) {
            await env.blockchain.loadFrom(snap)
            const r = await wallet.sendBurn(players[0].getSender(), { value: fee, amount, options })
            within(`burn_notification (cap payload, amount ${amount.toString()})`, maxOf(r, env.jackpot.address, JackpotOp.burnNotification), constant('bound::jackpot'))
            within(`wallet burn (cap payload, amount ${amount.toString()})`, maxOf(r, wallet.address, JackpotOp.burn), constant('bound::wallet'))
        }
        await env.blockchain.loadFrom(snap)
        const w = await env.jackpot.sendComment(players[0].getSender(), { value: env.fees.commentWithdraw, text: 'w' })
        within('burn_notification (a w burn)', maxOf(w, env.jackpot.address, JackpotOp.burnNotification), constant('bound::jackpot'))
        for (const include of [false, true]) {
            const t = await env.jackpot.sendProvideWalletAddress(players[1].getSender(), { value: env.fees.tep89, owner: players[0].address, includeAddress: include })
            expect(t.transactions).toHaveTransaction({ to: env.jackpot.address, success: true })
            within(`provide_wallet_address (include ${String(include)})`, gasOf(t, env.jackpot.address)[0].gas, constant('bound::tep89'))
        }
        // a short burn with the cap payload reaches its fee check, and throws, within G_pre
        await env.blockchain.loadFrom(snap)
        const short = await wallet.sendBurn(players[0].getSender(), { value: (await wallet.getWalletMinimumInternal()) + G('0.03'), amount: G('10'), options })
        const pre = maxOf(short, env.jackpot.address, JackpotOp.burnNotification)
        console.log('GASROW G_pre with an 8-cell payload', pre.toString(), 'of', constant('bound::pre').toString())
        expect(pre).toBeLessThanOrEqual(constant('bound::pre'))
        expect(short.transactions).toHaveTransaction({ to: env.jackpot.address, success: false, exitCode: JackpotError.insufficientFee })
    }, 600000)
})
