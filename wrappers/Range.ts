import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core'
import { JackpotOp } from './Jackpot'

export interface RangeConfig {
    jackpot: Address
    epoch?: number
    start: bigint
}

// The init data that fixes a range's address: (jackpot, epoch, start). Owner and length come with setup.
export function rangeConfigToCell(config: RangeConfig): Cell {
    return beginCell()
        .storeAddress(config.jackpot)
        .storeUint(config.epoch ?? 0, 32)
        .storeUint(config.start, 128)
        .endCell()
}

export interface RangeData {
    jackpot: Address
    epoch: number
    start: bigint
    setUp: boolean
    owner: Address | null
    length: bigint
    live: bigint
}

export class Range implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new Range(address)
    }

    static createFromConfig(config: RangeConfig, code: Cell, workchain = 0) {
        const data = rangeConfigToCell(config)
        const init = { code, data }
        return new Range(contractAddress(workchain, init), init)
    }

    async sendMessage(provider: ContractProvider, via: Sender, value: bigint, body: Cell, bounce = true) {
        await provider.internal(via, { value, bounce, sendMode: SendMode.PAY_GAS_SEPARATELY, body })
    }

    // x = 0 withdraws the whole live part
    async sendWithdraw(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; amount: bigint; queryId?: bigint },
    ) {
        const body = beginCell()
            .storeUint(JackpotOp.withdraw, 32)
            .storeUint(opts.queryId ?? 0n, 64)
            .storeCoins(opts.amount)
            .endCell()
        await this.sendMessage(provider, via, opts.value, body)
    }

    async sendTopUp(provider: ContractProvider, via: Sender, value: bigint) {
        await this.sendMessage(
            provider,
            via,
            value,
            beginCell().storeUint(JackpotOp.topUp, 32).storeUint(0, 64).endCell(),
        )
    }

    async getRangeData(provider: ContractProvider): Promise<RangeData> {
        const { stack } = await provider.get('get_range_data', [])
        const jackpot = stack.readAddress()
        const epoch = stack.readNumber()
        const start = stack.readBigNumber()
        const setUp = stack.readBoolean()
        const owner = stack.readAddressOpt()
        return { jackpot, epoch, start, setUp, owner, length: stack.readBigNumber(), live: stack.readBigNumber() }
    }

    async getBalance(provider: ContractProvider): Promise<bigint> {
        return (await provider.getState()).balance
    }
}
