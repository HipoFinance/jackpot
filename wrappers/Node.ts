import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, TupleReader } from '@ton/core'

export interface NodeConfig {
    jackpot: Address
    level: number
    index: bigint
    rangeCode: Cell
}

// The init data that fixes a node's address: (jackpot, level, index, range code hash and depth).
export function nodeConfigToCell(config: NodeConfig): Cell {
    return beginCell()
        .storeAddress(config.jackpot)
        .storeUint(config.level, 8)
        .storeUint(config.index, 32)
        .storeBuffer(config.rangeCode.hash())
        .storeUint(config.rangeCode.depth(), 16)
        .endCell()
}

export interface NodeData {
    jackpot: Address
    level: number
    index: bigint
    initialized: boolean
    pendingDraw: bigint
    committed: bigint[] // 64 sums, empty before the first update
    held: bigint[] // 64 withdrawals held back for pendingDraw
}

function readInts(t: TupleReader): bigint[] {
    const out: bigint[] = []
    while (t.remaining > 0) out.push(t.readBigNumber())
    return out
}

export class Node implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new Node(address)
    }

    static createFromConfig(config: NodeConfig, code: Cell, workchain = 0) {
        const data = nodeConfigToCell(config)
        const init = { code, data }
        return new Node(contractAddress(workchain, init), init)
    }

    async getNodeData(provider: ContractProvider): Promise<NodeData> {
        const { stack } = await provider.get('get_node_data', [])
        return {
            jackpot: stack.readAddress(),
            level: stack.readNumber(),
            index: stack.readBigNumber(),
            initialized: stack.readBoolean(),
            pendingDraw: stack.readBigNumber(),
            committed: readInts(stack.readTuple()),
            held: readInts(stack.readTuple()),
        }
    }

    async getBalance(provider: ContractProvider): Promise<bigint> {
        return (await provider.getState()).balance
    }
}
