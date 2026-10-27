/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests read state they just made */
// The range contract: its storage reserve, and who may set it up, ask it, or top it up.
import '@ton/test-utils'
import { beginCell, Cell, Dictionary, Slice, toNano } from '@ton/core'
import { JackpotError, JackpotOp } from '../wrappers/Jackpot'
import { Range } from '../wrappers/Range'
import { getConfig } from './hipo/chain'
import { Env, depositGram, rangeAt, setupJackpot } from './jackpot/setup'

const tenYears = 10n * 365n * 24n * 3600n
const rangeStorage = toNano('0.1') // fee::range_storage

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

describe('Range', () => {
    let env: Env

    beforeEach(async () => {
        env = await setupJackpot()
    })

    it('holds a storage reserve for at least 10 years at the configured prices', async () => {
        const alice = await env.blockchain.treasury('alice')
        await depositGram(env, alice, toNano('100'))
        const range = rangeAt(env, 0n)
        const account = (await env.blockchain.getContract(range.address)).account.account!
        const { cells, bits } = account.storageStats.used

        const all = storagePrices(getConfig(env.blockchain, 18n)!)
        const current = all
            .filter((p) => p.since <= BigInt(env.blockchain.now!))
            .sort((a, b) => Number(b.since - a.since))[0]
        // also against mainnet's basechain prices before the 2025 cut, the dearest in recent years
        const mainnetOld: StoragePrices = { since: 0n, bitPrice: 1n, cellPrice: 500n }
        for (const prices of [current, mainnetOld]) {
            const fee = storageFee(prices, cells, bits, tenYears)
            console.log(
                `range: ${cells.toString()} cells, ${bits.toString()} bits; 10 years at ${prices.bitPrice.toString()}/${prices.cellPrice.toString()}: ${fee.toString()}`,
            )
            expect(fee).toBeLessThanOrEqual(rangeStorage)
        }
        expect(await range.getBalance()).toBeGreaterThanOrEqual(rangeStorage)
    })

    it('accepts setup only from the Jackpot, and only once', async () => {
        const alice = await env.blockchain.treasury('alice')
        const mallory = await env.blockchain.treasury('mallory')
        const setup = (owner = mallory.address, length = toNano('1000000')) =>
            beginCell()
                .storeUint(JackpotOp.rangeSetup, 32)
                .storeUint(0, 64)
                .storeAddress(owner)
                .storeCoins(length)
                .endCell()

        // a range deployed by an outsider at the next booking's address cannot be set up by them
        const next = env.blockchain.openContract(
            Range.createFromConfig({ jackpot: env.jackpot.address, start: 0n }, env.rangeCode),
        )
        const squat = await mallory.send({ to: next.address, value: toNano('0.2'), init: next.init, body: setup() })
        expect(squat.transactions).toHaveTransaction({
            to: next.address,
            success: false,
            exitCode: JackpotError.accessDenied,
        })

        // the Jackpot's own setup still lands on it
        const { booking } = await depositGram(env, alice, toNano('100'))
        expect(booking!.start).toBe(0n)
        const data = await next.getRangeData()
        expect(data.owner!.equals(alice.address)).toBe(true)

        // a second setup from anyone else is refused, and the Jackpot never sends one
        const again = await mallory.send({ to: next.address, value: toNano('0.2'), body: setup() })
        expect(again.transactions).toHaveTransaction({ to: next.address, success: false })
        expect((await next.getRangeData()).owner!.equals(alice.address)).toBe(true)

        // check is accepted only from the Jackpot
        const check = beginCell()
            .storeUint(JackpotOp.check, 32)
            .storeUint(0, 64)
            .storeUint(1, 32)
            .storeUint(0, 8)
            .storeUint(0, 8)
            .storeUint(0, 128)
            .storeUint(0, 128)
            .endCell()
        const forged = await alice.send({ to: next.address, value: toNano('0.1'), body: check })
        expect(forged.transactions).toHaveTransaction({
            to: next.address,
            success: false,
            exitCode: JackpotError.accessDenied,
        })

        // anyone may top it up
        const before = await next.getBalance()
        await next.sendTopUp(mallory.getSender(), toNano('1'))
        expect(await next.getBalance()).toBeGreaterThan(before + toNano('0.9'))
    })
})
