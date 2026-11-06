import { Address, beginCell, Cell, Contract, contractAddress, ContractProvider, TupleReader } from '@ton/core'

export interface NodeConfig {
    jackpot: Address
    level: number
    index: bigint
}

// The init data that fixes a node's address: (jackpot, level, index).
export function nodeConfigToCell(config: NodeConfig): Cell {
    return beginCell().storeAddress(config.jackpot).storeUint(config.level, 8).storeUint(config.index, 32).endCell()
}

export interface NodeData {
    jackpot: Address
    level: number
    index: bigint
    initialized: boolean
    tag: bigint
    committed: bigint[] // 64 sums, empty before the first update
    added: bigint[]
    removed: bigint[]
    owners: bigint[] // 64 owner address hashes, level 1 only
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
            tag: stack.readBigNumber(),
            committed: readInts(stack.readTuple()),
            added: readInts(stack.readTuple()),
            removed: readInts(stack.readTuple()),
            owners: readInts(stack.readTuple()),
        }
    }

    async getBalance(provider: ContractProvider): Promise<bigint> {
        return (await provider.getState()).balance
    }
}
