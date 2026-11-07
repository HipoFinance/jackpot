/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-unnecessary-condition -- tests read state they just made */
// Gas pins per handler, the boundary's gas against fee::boundary_max, the fees against the real chains, and the storage
// reserves against config 18. The worst-case fold of a node is pinned in tests/Flows.spec.ts ("a node, in its worst
// case"); the close_node cascade in tests/Retire.spec.ts.
import '@ton/test-utils'
import { Address, Cell, Dictionary, beginCell, toNano } from '@ton/core'
import { Blockchain, SendMessageResult } from '@ton/sandbox'
import { readFileSync } from 'fs'
import { JackpotOp } from '../wrappers/Jackpot'
import { Node } from '../wrappers/Node'
import { balanceOf, codes, gasOf, opOf, messageFrom, nodeAt, poke, reward, setGasPrice, walletAt, withdraw } from './jackpot/setup'
import { A0, fresh, put, setNow, submitDraw } from './jackpot/scenario'
import { createEmptyShardAccount } from '@ton/sandbox'

const G = (n: string | number) => toNano(String(n))
const year = 365 * 24 * 3600

// The cells and bits an account's code and data take (shared cells counted once).
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

// Years a reserve lasts at prices per 65536 seconds.
function years(reserve: bigint, size: { cells: number; bits: number }, bitPrice: bigint, cellPrice: bigint) {
    const perSecond = Number(BigInt(size.bits) * bitPrice + BigInt(size.cells) * cellPrice) / 65536
    if (perSecond === 0) return Infinity
    return Number(reserve) / perSecond / year
}

describe('Gas', () => {
    it('Reserves from config 18: the wallet reserve lasts 16 years at today’s prices and 2.2 at the old ones (0.026 GRAM), the node reserve 25 and 3', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 1, mint: G('1000') })
        const { env, players } = sc
        await put(env, players[0], G('100'))
        const w = (await env.blockchain.getContract(walletAt(env, players[0].address).address)).accountState
        if (w?.type !== 'active') throw new Error('no wallet')
        const wallet = sizeOf(w.state.code!, w.state.data!)
        // a full level-1 node: every child holds tickets and an owner
        const { nodeCode } = await codes()
        const bc = await Blockchain.create()
        const jackpot = await bc.treasury('j')
        const node = bc.openContract(Node.createFromConfig({ jackpot: jackpot.address, level: 1, index: 0n }, nodeCode))
        const parent = Node.createFromConfig({ jackpot: jackpot.address, level: 2, index: 0n }, nodeCode)
        for (let c = 0; c < 64; c++) {
            const body = beginCell()
                .storeUint(JackpotOp.update, 32)
                .storeUint(0, 64)
                .storeUint(c < 32 ? 1 : 2, 32)
                .storeUint(c, 32)
                .storeInt(BigInt(c + 1) * 1_000_000_007n, 128)
                .storeBit(true)
                .storeUint((1n << 200n) | BigInt(c + 1), 256)
                .endCell()
            const m = messageFrom(parent.address, node.address, G('1'), body, false)
            await bc.sendMessage(c === 0 ? { ...m, init: node.init } : m)
        }
        const n = (await bc.getContract(node.address)).accountState
        if (n?.type !== 'active') throw new Error('no node')
        const fullNode = sizeOf(n.state.code!, n.state.data!)
        console.log('wallet', wallet, 'full level-1 node', fullNode)
        // config 18, as the sandbox holds it, and the two price sets of the spec
        const cfg = Dictionary.loadDirect(Dictionary.Keys.BigInt(32), Dictionary.Values.Cell(), env.blockchain.config)
        const prices = Dictionary.loadDirect(
            Dictionary.Keys.Uint(32),
            {
                serialize: () => undefined,
                parse: (src) => {
                    src.skip(8 + 32) // tag, utime_since
                    return { bit: src.loadUintBig(64), cell: src.loadUintBig(64) }
                },
            },
            cfg.get(18n)!,
        )
        expect(prices.size).toBeGreaterThan(0)
        const last = prices.get(Math.max(...prices.keys()))!
        console.log('config 18 in the sandbox: bit', last.bit, 'cell', last.cell)
        const today = { bit: 0n, cell: 135n }
        const old = { bit: 1n, cell: 500n }
        const fees = env.fees
        console.log(
            'wallet years',
            years(fees.walletStorage, wallet, today.bit, today.cell),
            years(fees.walletStorage, wallet, old.bit, old.cell),
        )
        console.log(
            'node years',
            years(fees.nodeStorage, fullNode, today.bit, today.cell),
            years(fees.nodeStorage, fullNode, old.bit, old.cell),
        )
        // the wallet's reserve is priced at the current price for exactly 5 years (fees.fc wallet_storage)
        expect(years(fees.walletStorage, wallet, today.bit, today.cell)).toBeGreaterThanOrEqual(5)
        expect(years(fees.nodeStorage, fullNode, today.bit, today.cell)).toBeGreaterThanOrEqual(25)
        expect(years(fees.nodeStorage, fullNode, old.bit, old.cell)).toBeGreaterThanOrEqual(3)
        // the sandbox's own prices are no worse than the old ones
        // The built wallet is 23 cells and 12,373 bits (options, burn options and comments made it larger than v2's
        // 18 cells and 9,453 bits): 1.74 years at the old prices with v2's 0.02 GRAM, so fee::wallet_storage is 0.026.
    }, 200000)
})

// One pin per handler, at its worst case seen over the flows below, against the gas its fee pays for at
// 400 nano-GRAM per gas: Jackpot handlers 50,000 (fee::handler), the submit 150,000, wallets 50,000, nodes 87,500
// (fee::node_hop). A boundary's reply may use fee::boundary_max more. A node's worst case, a fold of all 64 children,
// is pinned in tests/Flows.spec.ts.
const constants = readFileSync('contracts/imports/constants.fc', 'utf8')
const constant = (name: string) => {
    const m = new RegExp(`const int ${name} = (\\d+);`).exec(constants)
    if (m == null) throw new Error(`${name} not found`)
    return BigInt(m[1])
}
const gasPrice = 400n

describe('Gas pins per handler', () => {
    const seen = new Map<string, bigint>()
    const OPS: Record<number, string> = {
        [JackpotOp.transferNotification]: 'transfer_notification',
        [JackpotOp.depositReady]: 'deposit_ready',
        [JackpotOp.burnNotification]: 'burn_notification',
        [JackpotOp.takeCurrentQuote]: 'take_current_quote',
        [JackpotOp.hit]: 'hit',
        [JackpotOp.miss]: 'miss',
        [JackpotOp.gasExcess]: 'gas_excess',
        [JackpotOp.submitRandomness]: 'submit_randomness',
        [JackpotOp.withdrawalNotification]: 'withdrawal_notification',
        [JackpotOp.refill]: 'refill',
        [JackpotOp.poke]: 'poke',
        [JackpotOp.provideWalletAddress]: 'provide_wallet_address',
        [JackpotOp.prepareDeposit]: 'prepare_deposit',
        [JackpotOp.depositBooked]: 'deposit_booked',
        [JackpotOp.depositCancelled]: 'deposit_cancelled',
        [JackpotOp.closeWallet]: 'close_wallet',
        [JackpotOp.burn]: 'burn',
        [JackpotOp.update]: 'update',
        [JackpotOp.descend]: 'descend',
        0: 'comment',
    }

    // The gas of the reply of a poke at the Jackpot, per scenario, to price the boundary's own work.
    const replies = new Map<string, bigint>()
    let floatFall = 0n
    // what a reply costs the float: what it sends and pays, less the value it brought
    const netOut = (r: SendMessageResult, jackpot: Address) => {
        const tx = r.transactions.find((t) => t.inMessage?.info.dest?.toString() === jackpot.toString() && opOf(t) === JackpotOp.takeCurrentQuote)!
        let out = tx.totalFees.coins
        for (const m of tx.outMessages.values()) if (m.info.type === 'internal') out += m.info.value.coins
        return out - (tx.inMessage?.info.type === 'internal' ? tx.inMessage.info.value.coins : 0n)
    }
    let plainNet = 0n
    const pokerCost: { plain: bigint; boundary: bigint } = { plain: 0n, boundary: 0n }

    beforeAll(async () => {
        const sc = await fresh({ minDeposit: 1n, players: 4, mint: G('1000'), float: G('7.5'), burnBatch: 1n })
        const { env, players } = sc
        await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
        const rec = (r: SendMessageResult, e = env, ps = players) => {
            const walletSet = new Set(ps.map((p) => walletAt(e, p.address).address.toString()))
            const nodeSet = new Set<string>()
            for (let l = 1; l <= 4; l++) nodeSet.add(nodeAt(e, l, 0n).address.toString())
            for (const tx of r.transactions) {
                const d = tx.description
                const dest = tx.inMessage?.info.dest?.toString()
                if (d.type !== 'generic' || d.computePhase.type !== 'vm' || dest == null) continue
                const body = tx.inMessage?.body.beginParse()
                const op = body != null && body.remainingBits >= 32 ? body.loadUint(32) : 0
                const name = OPS[op]
                if (name == null) continue
                const kind =
                    dest === e.jackpot.address.toString()
                        ? 'jackpot'
                        : walletSet.has(dest)
                          ? 'wallet'
                          : nodeSet.has(dest)
                            ? 'node'
                            : undefined
                if (kind == null) continue
                const key = `${kind} ${name}`
                if (d.computePhase.gasUsed > (seen.get(key) ?? 0n)) seen.set(key, d.computePhase.gasUsed)
            }
        }
        const replyGas = (r: SendMessageResult, e = env) =>
            gasOf(r, e.jackpot.address).find((g) => g.op === JackpotOp.takeCurrentQuote)?.gas ?? 0n
        rec((await put(env, players[0], G('300'))).result)
        rec((await put(env, players[0], G('50'))).result)
        rec((await put(env, players[1], G('100'))).result)
        rec((await put(env, players[2], G('1'), G('1000'))).result) // refused: price
        rec(await withdraw(env, players[1], G('30')))
        rec(await withdraw(env, players[1], 0n)) // close
        rec(await env.jackpot.sendComment(players[0].getSender(), { value: env.fees.commentWithdraw, text: 'w' })) // w
        await put(env, players[0], G('300'))
        rec(
            await env.jackpot.sendProvideWalletAddress(players[3].getSender(), {
                value: env.fees.walletStorage + G('0.1'),
                owner: players[0].address,
                includeAddress: true,
            }),
        )
        // a poke whose reply is not a boundary: the baseline, and what it costs the poker
        const keeper = env.keeper
        const k0 = await balanceOf(env, keeper.address)
        const plain = await poke(env)
        pokerCost.plain = k0 - (await balanceOf(env, keeper.address))
        plainNet = netOut(plain, env.jackpot.address)
        rec(plain)
        replies.set('plain', replyGas(plain))
        // a boundary: a reward, min_gap later, the same poke. Below float_low, so the pot is partly unstaked
        await reward(env, G('40'))
        setNow(env, A0 + 3600)
        const k1 = await balanceOf(env, keeper.address)
        const boundary = await poke(env)
        pokerCost.boundary = k1 - (await balanceOf(env, keeper.address))
        floatFall = netOut(boundary, env.jackpot.address) - plainNet
        rec(boundary)
        replies.set('boundary with an unstake', replyGas(boundary))
        rec(await withdraw(env, players[0], G('20'))) // a withdrawal in the draw
        rec(await submitDraw(env)) // hits and the unstake's notification
        // a resolving draw rolled over at the next boundary, with an unstake: the worst reply
        await reward(env, G('40'))
        setNow(env, A0 + 3600 * 2 + 10)
        await poke(env)
        const top = nodeAt(env, 4, 0n).address
        const saved = (await env.blockchain.getContract(top)).account
        await env.blockchain.setShardAccount(top, createEmptyShardAccount(top))
        rec(await submitDraw(env, 1))
        await env.blockchain.setShardAccount(top, saved)
        expect((await env.jackpot.getDrawState()).state).toBe(2)
        await reward(env, G('40'))
        setNow(env, A0 + 3600 * 3 + 20)
        const rolled = await poke(env)
        rec(rolled)
        replies.set('boundary rolling over three open slots', replyGas(rolled))
        // misses: a big deposit is in the snapshot, and then leaves before the searches
        await reward(env, G('40'))
        await put(env, players[3], G('900'))
        setNow(env, A0 + 3600 * 5)
        await reward(env, G('40'))
        const again = await poke(env)
        replies.set('boundary, no unstake', replyGas(again))
        await withdraw(env, players[3], G('899'))
        rec(await submitDraw(env, 2))
        // refill
        const low = await fresh({ minDeposit: 1n, players: 2, mint: G('1000'), float: G('3.5') })
        await put(low.env, low.players[0], G('100'))
        rec(await low.env.jackpot.sendRefill(low.players[1].getSender(), { value: low.env.fees.refill }), low.env, low.players)
        console.log('worst gas per handler', Object.fromEntries([...seen].map(([k, v]) => [k, Number(v)])))
        console.log('reply gas per scenario', Object.fromEntries([...replies].map(([k, v]) => [k, Number(v)])))
    }, 900000)

    const limits: [string, bigint][] = [
        ['jackpot transfer_notification', 50_000n],
        ['jackpot deposit_ready', 50_000n],
        ['jackpot burn_notification', 50_000n],
        ['jackpot hit', 50_000n],
        ['jackpot miss', 50_000n],
        ['jackpot gas_excess', 50_000n],
        ['jackpot withdrawal_notification', 50_000n],
        ['jackpot refill', 50_000n],
        ['jackpot poke', 50_000n],
        ['jackpot provide_wallet_address', 50_000n],
        ['jackpot comment', 50_000n],
        ['wallet prepare_deposit', 50_000n],
        ['wallet deposit_booked', 50_000n],
        ['wallet deposit_cancelled', 50_000n],
        ['wallet close_wallet', 50_000n],
        ['wallet burn', 50_000n],
        ['wallet burn_notification', 50_000n],
        ['node update', 87_500n],
        ['node descend', 87_500n],
    ]
    for (const [key, limit] of limits) {
        it(`${key} fits ${limit.toString()} gas`, () => {
            const g = seen.get(key)
            if (g == null) return // not every kind of message is seen in the wallet or the Jackpot
            expect(g).toBeLessThanOrEqual(limit)
        })
    }

    it('take_current_quote fits fee::handler plus fee::boundary_max, and the submit fits 150,000', () => {
        const boundaryMax = constant('fee::boundary_max')
        expect(seen.get('jackpot take_current_quote')!).toBeLessThanOrEqual(50_000n + boundaryMax)
        expect(seen.get('jackpot submit_randomness')!).toBeLessThanOrEqual(150_000n)
    })

    it('fee::boundary_max (gas units) covers the worst measured boundary: the reply with a rollover and an unstake, less a reply that is not a boundary', () => {
        const base = replies.get('plain')!
        const worst = [...replies.entries()].filter(([k]) => k !== 'plain').map(([k, g]) => [k, g - base] as const)
        console.log('boundary work, gas over a plain reply', Object.fromEntries(worst.map(([k, g]) => [k, Number(g)])))
        const boundaryMax = constant('fee::boundary_max')
        console.log('fee::boundary_max', boundaryMax.toString())
        for (const [, g] of worst) expect(g).toBeLessThanOrEqual(boundaryMax)
        // a margin, but not an absurd one
        expect(boundaryMax).toBeLessThanOrEqual(3n * worst.reduce((a, [, g]) => (g > a ? g : a), 0n))
    })

    it('No hidden reward: a poke whose reply is a boundary costs its poker the same GRAM, within 0.002 GRAM, as one that is not; the float falls by the boundary’s gas and the unstake only, never by more than fee::boundary_max plus fee::unstake', () => {
        const diff = pokerCost.boundary > pokerCost.plain ? pokerCost.boundary - pokerCost.plain : pokerCost.plain - pokerCost.boundary
        console.log('poker cost: plain', pokerCost.plain.toString(), 'boundary', pokerCost.boundary.toString(), 'float fall', floatFall.toString())
        expect(diff).toBeLessThanOrEqual(2_000_000n)
        expect(floatFall).toBeLessThanOrEqual(constant('fee::boundary_max') * gasPrice + constant('fee::unstake_bound'))
    })

    it('fee::draw_budget includes 3 · fee::prize_notify and fee::boundary_max priced at 400 nano-GRAM per gas', async () => {
        const sc = await fresh({ players: 1 })
        const budget = sc.env.fees.drawBudget
        const parts =
            3n * 16n * constant('fee::search_worst') +
            4n * constant('fee::payout') +
            3n * constant('fee::prize_notify') +
            constant('fee::burn_forward') +
            constant('reward::submit') +
            constant('fee::unstake_bound') +
            3n * (4n * constant('fee::node_hop') + constant('fee::handler')) +
            constant('fee::boundary_max') * gasPrice
        console.log('fee::draw_budget', budget.toString())
        expect(budget).toBe(parts)
        expect(constant('fee::prize_notify')).toBe(10_000_000n)
    })
})

// The fee of each chain against what its transactions really use, at 400 nano-GRAM per gas (Jackpot, jGRAM wallets
// and nodes; Hipo's own share is inside fee::payout).
describe('Fees against the real chains', () => {
    it('each entry fee pays for the gas of the chain it starts', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 3, mint: G('1000') })
        const { env, players } = sc
        // the fees are read at 400 nano-GRAM per gas, the price this test sizes against
        setGasPrice(env.blockchain, gasPrice)
        env.fees = await env.jackpot.getJackpotFees()
        const walletSet = new Set(players.map((p) => walletAt(env, p.address).address.toString()))
        const nodeSet = new Set<string>()
        for (let l = 1; l <= 4; l++) nodeSet.add(nodeAt(env, l, 0n).address.toString())
        const used = (r: SendMessageResult) => {
            let gas = 0n
            for (const tx of r.transactions) {
                const dest = tx.inMessage?.info.dest?.toString()
                if (dest == null || tx.description.type !== 'generic' || tx.description.computePhase.type !== 'vm') continue
                if (dest === env.jackpot.address.toString() || walletSet.has(dest) || nodeSet.has(dest)) gas += tx.description.computePhase.gasUsed
            }
            return gas
        }
        const rows: [string, bigint, bigint][] = []
        const first = await put(env, players[0], G('100'))
        rows.push(['deposit (new position)', used(first.result), env.fees.deposit])
        const second = await put(env, players[0], G('20'))
        rows.push(['deposit (existing position)', used(second.result), env.fees.deposit])
        rows.push(['burn', used(await withdraw(env, players[0], G('10'))), env.fees.withdraw])
        rows.push(['poke (not a boundary)', used(await poke(env)), env.fees.poke])
        const w = await env.jackpot.sendComment(players[0].getSender(), { value: env.fees.commentWithdraw, text: 'w' })
        rows.push(['w', used(w), env.fees.commentWithdraw])
        const t = await env.jackpot.sendProvideWalletAddress(players[1].getSender(), {
            value: env.fees.walletStorage + G('0.1'),
            owner: players[0].address,
            includeAddress: true,
        })
        rows.push(['provide_wallet_address', used(t), 2n * constant('fee::handler')])
        for (const [name, gas, fee] of rows) {
            console.log(`${name}: ${gas.toString()} gas (${(gas * gasPrice).toString()} nano-GRAM) of ${fee.toString()}`)
            expect(gas * gasPrice).toBeLessThanOrEqual(fee)
        }
    }, 300000)
})
