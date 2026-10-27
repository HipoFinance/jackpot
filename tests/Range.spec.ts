/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests read state they just made */
// The range contract: its storage reserve, and who may set it up, ask it, or top it up.
import '@ton/test-utils'
import { Address, Cell, Dictionary, Slice, toNano } from '@ton/core'
import { JackpotError, JackpotOp, treeLevels } from '../wrappers/Jackpot'
import { getConfig } from './hipo/chain'
import { Env, depositGram, nodeAt, rangeAt, setupJackpot } from './jackpot/setup'
import { checkBody, craftNode, dataHash, deliver, descendBody, msg, rangeSetupBody, updateBody } from './jackpot/adversary'

const tenYears = 10n * 365n * 24n * 3600n
const rangeStorage = toNano('0.1') // fee::range_storage
const nodeStorage = toNano('0.3') // fee::node_storage

interface StoragePrices {
    since: bigint
    bitPrice: bigint
    cellPrice: bigint
}

// Config 18: utime_since -> (bit_price_ps, cell_price_ps, mc_bit_price_ps, mc_cell_price_ps), per 2^16 s
function storagePrices(config18: Cell): StoragePrices[] {
    const value = {
        serialize: () => {
            throw new Error('read only')
        },
        parse: (s: Slice): StoragePrices => {
            s.skip(8)
            return { since: s.loadUintBig(32), bitPrice: s.loadUintBig(64), cellPrice: s.loadUintBig(64) }
        },
    }
    return Dictionary.loadDirect(Dictionary.Keys.Uint(32), value, config18).values()
}

function storageFee(prices: StoragePrices, cells: bigint, bits: bigint, seconds: bigint) {
    const perUnit = bits * prices.bitPrice + cells * prices.cellPrice
    return (perUnit * seconds + 65535n) / 65536n
}

// The dearest storage prices of recent years: mainnet's basechain before the 2025 cut.
const mainnetOld: StoragePrices = { since: 0n, bitPrice: 1n, cellPrice: 500n }

// Distinct cells and their bits under the given roots, as storage counts them.
function cellStats(roots: Cell[]) {
    const seen = new Set<string>()
    let cells = 0n
    let bits = 0n
    const walk = (c: Cell) => {
        const h = c.hash().toString('hex')
        if (seen.has(h)) return
        seen.add(h)
        cells++
        bits += BigInt(c.bits.length)
        for (const r of c.refs) walk(r)
    }
    roots.forEach(walk)
    return { cells, bits }
}

async function expectReserve(env: Env, address: Address, reserve: bigint, what: string) {
    const state = (await env.blockchain.getContract(address)).accountState
    if (state?.type !== 'active') throw new Error('not active')
    // code and data, plus a cell of 1,000 bits for the account itself
    const counted = cellStats([state.state.code!, state.state.data!])
    const cells = counted.cells + 1n
    const bits = counted.bits + 1000n
    const all = storagePrices(getConfig(env.blockchain, 18n)!)
    const current = all
        .filter((p) => p.since <= BigInt(env.blockchain.now!))
        .sort((a, b) => Number(b.since - a.since))[0]
    for (const prices of [current, mainnetOld]) {
        const fee = storageFee(prices, cells, bits, tenYears)
        console.log(
            `${what}: ${cells.toString()} cells, ${bits.toString()} bits; 10 years at ${prices.bitPrice.toString()}/${prices.cellPrice.toString()}: ${fee.toString()}`,
        )
        expect(fee).toBeLessThanOrEqual(reserve)
    }
}

describe('Range', () => {
    let env: Env

    beforeEach(async () => {
        env = await setupJackpot()
    })

    it('holds a storage reserve for at least 10 years at the configured prices', async () => {
        const alice = await env.blockchain.treasury('alice')
        await depositGram(env, alice, toNano('100'))
        const range = rangeAt(env, 0n)
        await expectReserve(env, range.address, rangeStorage, 'range')
        expect(await range.getBalance()).toBeGreaterThanOrEqual(rangeStorage)
    })

    it('has the address the Jackpot computes from code hash and depth', async () => {
        for (const b of [0n, 1n, 63n, 64n, 16777215n]) {
            expect((await env.jackpot.getRangeAddress(b)).equals(rangeAt(env, b).address)).toBe(true)
        }
    })

    it('accepts setup only from the Jackpot, and only once; check only from its level-1 node', async () => {
        const alice = await env.blockchain.treasury('alice')
        const mallory = await env.blockchain.treasury('mallory')

        // a range deployed by an outsider at the next booking's address cannot be set up by them
        const next = rangeAt(env, 0n)
        const squat = await mallory.send({
            to: next.address,
            value: toNano('0.2'),
            init: next.init,
            body: rangeSetupBody(mallory.address, toNano('1000000')),
        })
        expect(squat.transactions).toHaveTransaction({
            to: next.address,
            success: false,
            exitCode: JackpotError.accessDenied,
        })

        // the Jackpot's own setup still lands on it
        const { booking } = await depositGram(env, alice, toNano('100'))
        expect(booking!.b).toBe(0n)
        const data = await next.getRangeData()
        expect(data.owner!.equals(alice.address)).toBe(true)
        expect(data.nodeHash).toBe(BigInt('0x' + nodeAt(env, 1, 0n).address.hash.toString('hex')))

        // a second setup from anyone else is refused, and the Jackpot never sends one
        const again = await mallory.send({ to: next.address, value: toNano('0.2'), body: rangeSetupBody(mallory.address, 1n) })
        expect(again.transactions).toHaveTransaction({ to: next.address, success: false })
        expect((await next.getRangeData()).owner!.equals(alice.address)).toBe(true)

        // check is accepted only from node(1, 0): not from the owner, not from the Jackpot
        const attempt = { draw: 1n, slot: 0, j: 0, k: 0n, offset: 0n }
        for (const from of [alice.address, env.jackpot.address, nodeAt(env, 2, 0n).address]) {
            const forged = await deliver(env.blockchain, msg(from, next.address, toNano('0.1'), checkBody(attempt)))
            expect(forged.transactions).toHaveTransaction({
                to: next.address,
                success: false,
                exitCode: JackpotError.accessDenied,
            })
        }
        const real = await deliver(env.blockchain, msg(nodeAt(env, 1, 0n).address, next.address, toNano('0.1'), checkBody(attempt)))
        expect(real.transactions).toHaveTransaction({ from: next.address, to: env.jackpot.address, op: JackpotOp.hit })

        // anyone may top it up
        const before = await next.getBalance()
        await next.sendTopUp(mallory.getSender(), toNano('1'))
        expect(await next.getBalance()).toBeGreaterThan(before + toNano('0.9'))
    })
})

describe('Node', () => {
    let env: Env

    beforeEach(async () => {
        env = await setupJackpot()
    })

    it('holds a storage reserve for at least 10 years at the configured prices, full of children', async () => {
        const alice = await env.blockchain.treasury('alice')
        await depositGram(env, alice, toNano('100'))
        for (let level = 1; level <= treeLevels; level++) {
            const node = nodeAt(env, level, 0n)
            expect(await node.getBalance()).toBeGreaterThanOrEqual(nodeStorage - toNano('0.001'))
        }
        // the largest a node gets: 64 distinct children committed and held
        const values = (base: bigint) => Array.from({ length: 64 }, (_, i) => base + BigInt(i) * 1234567n)
        const full = await craftNode(env, 1, 5n, { committed: values(toNano('123456')), held: values(toNano('7')), pendingDraw: 1n })
        await expectReserve(env, full.address, nodeStorage, 'node')
    })

    it('has the address the Jackpot computes, and accepts update and descend only from its parent', async () => {
        for (const [level, index] of [
            [4, 0n],
            [3, 0n],
            [1, 0n],
            [1, 262143n],
        ] as [number, bigint][]) {
            expect((await env.jackpot.getNodeAddress(level, index)).equals(nodeAt(env, level, index).address)).toBe(true)
        }
        const alice = await env.blockchain.treasury('alice')
        const mallory = await env.blockchain.treasury('mallory')
        await depositGram(env, alice, toNano('100'))
        const hashes = () => Promise.all([1, 2, 3, 4].map((l) => dataHash(env.blockchain, nodeAt(env, l, 0n).address)))
        const before = await hashes()
        for (let level = 1; level <= treeLevels; level++) {
            const node = nodeAt(env, level, 0n)
            // from the player, and from a node that is not its parent
            const strangers = [mallory.address, level === treeLevels ? nodeAt(env, 1, 0n).address : env.jackpot.address]
            if (level < treeLevels - 1) strangers.push(nodeAt(env, level + 2, 0n).address)
            for (const from of strangers) {
                for (const body of [
                    updateBody({ tag: 0n, deferred: false, b: 0n, delta: toNano('1000000') }),
                    descendBody({ draw: 1n, slot: 0, j: 0, k: 0n, offset: 0n }),
                ]) {
                    const r = await deliver(env.blockchain, msg(from, node.address, toNano('1'), body))
                    expect(r.transactions).toHaveTransaction({ to: node.address, success: false, exitCode: JackpotError.accessDenied })
                }
            }
        }
        expect(await hashes()).toEqual(before)
    })
})
