import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, SendMode } from '@ton/core'
import { JackpotOp } from './Jackpot'

export interface WalletConfig {
    jackpot: Address
    owner: Address
}

// The init data that fixes a jGRAM wallet's address: (jackpot, owner).
export function walletConfigToCell(config: WalletConfig): Cell {
    return beginCell().storeAddress(config.jackpot).storeAddress(config.owner).endCell()
}

export interface WalletState {
    jackpot: Address
    owner: Address
    setUp: boolean
    balance: bigint
    hasPosition: boolean
    position: bigint
    pending: bigint
}

export class Wallet implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new Wallet(address)
    }

    static createFromConfig(config: WalletConfig, code: Cell, workchain = 0) {
        const data = walletConfigToCell(config)
        const init = { code, data }
        return new Wallet(contractAddress(workchain, init), init)
    }

    // TEP-74 burn; amount = 0 withdraws the whole balance. options: withdraw_options, absent = paid to the owner.
    async sendBurn(
        provider: ContractProvider,
        via: Sender,
        opts: {
            value: bigint
            amount: bigint
            queryId?: bigint
            responseDestination?: Address | null
            options?: Cell | null
        },
    ) {
        const body = beginCell()
            .storeUint(JackpotOp.burn, 32)
            .storeUint(opts.queryId ?? 0n, 64)
            .storeCoins(opts.amount)
            .storeAddress(opts.responseDestination ?? null)
            .storeMaybeRef(opts.options ?? null)
            .endCell()
        await provider.internal(via, { value: opts.value, bounce: true, sendMode: SendMode.PAY_GAS_SEPARATELY, body })
    }

    // a jetton transfer, which the wallet refuses
    async sendTransfer(provider: ContractProvider, via: Sender, opts: { value: bigint; amount: bigint; to: Address }) {
        const body = beginCell()
            .storeUint(JackpotOp.sendTokens, 32)
            .storeUint(0, 64)
            .storeCoins(opts.amount)
            .storeAddress(opts.to)
            .storeAddress(via.address ?? null)
            .storeBit(false)
            .storeCoins(0)
            .storeBit(false)
            .endCell()
        await provider.internal(via, { value: opts.value, bounce: true, sendMode: SendMode.PAY_GAS_SEPARATELY, body })
    }

    async sendTopUp(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            bounce: false,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            body: beginCell().storeUint(JackpotOp.topUp, 32).storeUint(0, 64).endCell(),
        })
    }

    // TEP-74
    async getWalletData(provider: ContractProvider) {
        const { stack } = await provider.get('get_wallet_data', [])
        return {
            balance: stack.readBigNumber(),
            owner: stack.readAddress(),
            jetton: stack.readAddress(),
            code: stack.readCell(),
        }
    }

    // what the wallet requires of an owner's burn with no payload, at the current price, with NO storage debt (a getter
    // runs without a storage phase); in a transaction the wallet also counts its debt, so see burnAttach
    async getWalletMinimumInternal(provider: ContractProvider): Promise<bigint> {
        const { stack } = await provider.get('get_wallet_minimum_internal', [])
        return stack.readBigNumber()
    }

    async getWalletState(provider: ContractProvider): Promise<WalletState> {
        const { stack } = await provider.get('get_wallet_state', [])
        return {
            jackpot: stack.readAddress(),
            owner: stack.readAddress(),
            setUp: stack.readBoolean(),
            balance: stack.readBigNumber(),
            hasPosition: stack.readBoolean(),
            position: stack.readBigNumber(),
            pending: stack.readBigNumber(),
        }
    }
}
