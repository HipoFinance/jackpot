import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core'
import { JackpotOp } from './Jackpot'

export interface RangeConfig {
    jackpot: Address
    b: bigint
    nodeHash: bigint // the address hash of its level-1 node
}

// The init data that fixes a range's address: (jackpot, b, node_hash). Owner and length come with the setup.
export function rangeConfigToCell(config: RangeConfig): Cell {
    return beginCell().storeAddress(config.jackpot).storeUint(config.b, 32).storeUint(config.nodeHash, 256).endCell()
}

export interface RangeData {
    jackpot: Address
    b: bigint
    setUp: boolean
    owner: Address | null
    length: bigint
    live: bigint
    nodeHash: bigint
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

    // x = 0 withdraws the whole live part. In a draw's window, a range the draw can pick owes the
    // surcharge (Jackpot get_surcharge) on top of the fee.
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
        const b = stack.readBigNumber()
        const setUp = stack.readBoolean()
        const owner = stack.readAddressOpt()
        return {
            jackpot,
            b,
            setUp,
            owner,
            length: stack.readBigNumber(),
            live: stack.readBigNumber(),
            nodeHash: stack.readBigNumber(),
        }
    }

    async getBalance(provider: ContractProvider): Promise<bigint> {
        return (await provider.getState()).balance
    }
}
