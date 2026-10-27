// Chain-config helpers copied from the Hipo contract repo's tests/helper.ts (setConfig, createVset,
// updateFeeConfig), unchanged in logic.
import { Blockchain } from '@ton/sandbox'
import { Builder, Cell, Dictionary, DictionaryValue, Slice, beginCell } from '@ton/core'

export function createVset(since: bigint, until: bigint, total?: bigint, main?: bigint, list?: Builder | Cell): Cell {
    return beginCell()
        .storeUint(0x12, 8)
        .storeUint(since, 32)
        .storeUint(until, 32)
        .storeUint(total ?? 1n, 16)
        .storeUint(main ?? 1n, 16)
        .storeMaybeRef(list)
        .endCell()
}

export function setConfig(blockchain: Blockchain, index: bigint, value: Cell | null) {
    const config = Dictionary.loadDirect(Dictionary.Keys.BigInt(32), Dictionary.Values.Cell(), blockchain.config)
    if (value == null) {
        config.delete(index)
    } else {
        config.set(index, value)
    }
    const storage = beginCell()
    config.storeDirect(storage)
    blockchain.setConfig(storage.endCell())
}

export function getConfig(blockchain: Blockchain, index: bigint): Cell | undefined {
    const config = Dictionary.loadDirect(Dictionary.Keys.BigInt(32), Dictionary.Values.Cell(), blockchain.config)
    return config.get(index)
}

interface Fee {
    utimeSince: bigint
    bitPricePs: bigint
    cellPricePs: bigint
    mcBitPricePs: bigint
    mcCellPricePs: bigint
}

const feeDictionaryValue: DictionaryValue<Fee> = {
    serialize: function (src: Fee, builder: Builder) {
        builder
            .storeUint(0xcc, 8)
            .storeUint(src.utimeSince, 32)
            .storeUint(src.bitPricePs, 64)
            .storeUint(src.cellPricePs, 64)
            .storeUint(src.mcBitPricePs, 64)
            .storeUint(src.mcCellPricePs, 64)
    },
    parse: function (src: Slice): Fee {
        src.skip(8)
        return {
            utimeSince: src.loadUintBig(32),
            bitPricePs: src.loadUintBig(64),
            cellPricePs: src.loadUintBig(64),
            mcBitPricePs: src.loadUintBig(64),
            mcCellPricePs: src.loadUintBig(64),
        }
    },
}

export function updateFeeConfig(blockchain: Blockchain) {
    const config = Dictionary.loadDirect(Dictionary.Keys.BigInt(32), Dictionary.Values.Cell(), blockchain.config)

    const fees = Dictionary.loadDirect(Dictionary.Keys.BigInt(32), feeDictionaryValue, config.get(18n) ?? Cell.EMPTY)
    const newFee: Fee = {
        utimeSince: 1777500000n,
        bitPricePs: 0n,
        cellPricePs: 135n,
        mcBitPricePs: 1000n,
        mcCellPricePs: 500000n,
    }
    fees.set(1777500000n, newFee)
    const newFeeBuilder = beginCell()
    fees.storeDirect(newFeeBuilder)
    config.set(18n, newFeeBuilder.endCell())

    const config21 = beginCell()
        .storeUint(0xd1, 8)
        .storeUint(100, 64)
        .storeUint(6667, 64)
        .storeUint(0xde, 8)
        .storeUint(4369067, 64)
        .storeUint(1000000, 64)
        .storeUint(1000000, 64)
        .storeUint(10000, 64)
        .storeUint(10000000, 64)
        .storeUint(100000000, 64)
        .storeUint(1000000000, 64)
        .endCell()
    config.set(21n, config21)

    const config25 = beginCell()
        .storeUint(0xea, 8)
        .storeUint(66667, 64)
        .storeUint(4369067, 64)
        .storeUint(436906667, 64)
        .storeUint(98304, 32)
        .storeUint(21845, 16)
        .storeUint(21845, 16)
        .endCell()
    config.set(25n, config25)

    const newConfigBuilder = beginCell()
    config.storeDirect(newConfigBuilder)
    blockchain.setConfig(newConfigBuilder.endCell())
}
