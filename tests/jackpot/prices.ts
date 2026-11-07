/* eslint-disable @typescript-eslint/no-non-null-assertion -- the sandbox config always holds these entries */
import { Blockchain } from '@ton/sandbox'
import { beginCell, Cell, Dictionary } from '@ton/core'

// Chain prices, for the tests of the fees (spec 2026-11-06-jackpot-fees.md). Gas prices are configs 20 (masterchain)
// and 21 (basechain); forwarding prices are 24 and 25. All are stored in 1/65536 nano-GRAM.

function edit(blockchain: Blockchain, edits: Map<bigint, (cell: Cell) => Cell>) {
    const config = Dictionary.loadDirect(Dictionary.Keys.BigInt(32), Dictionary.Values.Cell(), blockchain.config)
    for (const [key, change] of edits) {
        const cell = config.get(key)
        if (cell == null) throw new Error(`no config ${String(key)}`)
        config.set(key, change(cell))
    }
    const storage = beginCell()
    config.storeDirect(storage)
    blockchain.setConfig(storage.endCell())
}

function gasPrices(cell: Cell, change: (price: bigint) => bigint): Cell {
    const old = cell.beginParse()
    const flatTag = old.loadUint(8)
    const flatLimit = old.loadUintBig(64)
    const flatPrice = old.loadUintBig(64)
    const extTag = old.loadUint(8)
    const price = old.loadUintBig(64)
    const rest = old.loadBits(old.remainingBits)
    return beginCell()
        .storeUint(flatTag, 8)
        .storeUint(flatLimit, 64)
        .storeUint(flatPrice, 64)
        .storeUint(extTag, 8)
        .storeUint(change(price), 64)
        .storeBits(rest)
        .endCell()
}

function forwardPrices(cell: Cell, change: (price: bigint) => bigint): Cell {
    const old = cell.beginParse()
    const tag = old.loadUint(8)
    const lump = old.loadUintBig(64)
    const bit = old.loadUintBig(64)
    const cellPrice = old.loadUintBig(64)
    const rest = old.loadBits(old.remainingBits)
    return beginCell()
        .storeUint(tag, 8)
        .storeUint(change(lump), 64)
        .storeUint(change(bit), 64)
        .storeUint(change(cellPrice), 64)
        .storeBits(rest)
        .endCell()
}

// Multiplies the gas price (configs 20 and 21) by num/den.
export function scaleGas(blockchain: Blockchain, num: bigint, den = 1n) {
    const f = (c: Cell) => gasPrices(c, (p) => (p * num) / den)
    edit(blockchain, new Map([[20n, f], [21n, f]]))
}

// Multiplies the forwarding prices (configs 24 and 25: lump, bit and cell) by num/den.
export function scaleForward(blockchain: Blockchain, num: bigint, den = 1n) {
    const f = (c: Cell) => forwardPrices(c, (p) => (p * num) / den)
    edit(blockchain, new Map([[24n, f], [25n, f]]))
}

// Multiplies gas and forwarding prices (configs 20, 21, 24 and 25) by num/den.
export function scalePrices(blockchain: Blockchain, num: bigint, den = 1n) {
    scaleGas(blockchain, num, den)
    scaleForward(blockchain, num, den)
}

// Sets the gas price (configs 20 and 21) to `nano` nano-GRAM per gas.
export function setGasPrices(blockchain: Blockchain, nano: bigint) {
    const f = (c: Cell) => gasPrices(c, () => nano * 65536n)
    edit(blockchain, new Map([[20n, f], [21n, f]]))
}

// Sets the forwarding prices to the pre-v16 values the old fee model was sized at: 1,000,000 nano-GRAM lump, 1,000 per bit, 100,000 per cell.
export function setOldForwardPrices(blockchain: Blockchain) {
    const f = (c: Cell) => {
        const old = c.beginParse()
        const tag = old.loadUint(8)
        old.loadUintBig(64)
        old.loadUintBig(64)
        old.loadUintBig(64)
        const rest = old.loadBits(old.remainingBits)
        return beginCell()
            .storeUint(tag, 8)
            .storeUint(1_000_000n, 64)
            .storeUint(65_536_000n, 64)
            .storeUint(6_553_600_000n, 64)
            .storeBits(rest)
            .endCell()
    }
    edit(blockchain, new Map([[24n, f], [25n, f]]))
}

// GETGASFEE on the basechain: the flat price up to the flat limit, then the gas price per gas above it.
export function gasFee(blockchain: Blockchain, gas: bigint): bigint {
    const config = Dictionary.loadDirect(Dictionary.Keys.BigInt(32), Dictionary.Values.Cell(), blockchain.config)
    const old = config.get(21n)!.beginParse()
    old.loadUint(8)
    const flatLimit = old.loadUintBig(64)
    const flatPrice = old.loadUintBig(64)
    old.loadUint(8)
    const price = old.loadUintBig(64)
    if (gas <= flatLimit) return flatPrice
    return flatPrice + ((gas - flatLimit) * price + 65535n) / 65536n
}

// GETFORWARDFEE on the basechain (config 25): the lump price plus the bit and cell prices, for a message of `cells` and
// `bits` outside its root cell.
export function forwardFee(blockchain: Blockchain, cells: bigint, bits: bigint): bigint {
    const config = Dictionary.loadDirect(Dictionary.Keys.BigInt(32), Dictionary.Values.Cell(), blockchain.config)
    const old = config.get(25n)!.beginParse()
    old.loadUint(8)
    const lump = old.loadUintBig(64)
    const bit = old.loadUintBig(64)
    const cell = old.loadUintBig(64)
    return lump + (bit * bits + cell * cells + 65535n) / 65536n
}
