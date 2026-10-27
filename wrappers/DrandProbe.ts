// Wrapper for the test-only contracts/drand_probe.fc.

import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Sender,
    SendMode,
    TupleBuilder,
} from '@ton/core'

export const DrandProbeOp = {
    verify: 1,
    verifyWithKey: 2,
} as const

export class DrandProbe implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromCode(code: Cell, workchain = 0): DrandProbe {
        const data = beginCell().storeUint(0, 64).storeUint(0, 256).endCell()
        const init = { code, data }
        return new DrandProbe(contractAddress(workchain, init), init)
    }

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body: beginCell().endCell() })
    }

    // signature and witness go in as raw cells, so tests can send malformed ones.
    async sendVerify(
        provider: ContractProvider,
        via: Sender,
        value: bigint,
        opts: { round: number | bigint; signature: Cell; witness: Cell; publicKey?: Cell },
    ) {
        const body = beginCell()
            .storeUint(opts.publicKey == null ? DrandProbeOp.verify : DrandProbeOp.verifyWithKey, 32)
            .storeUint(opts.round, 64)
            .storeRef(opts.signature)
            .storeRef(opts.witness)
        if (opts.publicKey != null) {
            body.storeRef(opts.publicKey)
        }
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body: body.endCell() })
    }

    async getResult(provider: ContractProvider): Promise<{ round: bigint; seed: bigint }> {
        const { stack } = await provider.get('get_result', [])
        return { round: stack.readBigNumber(), seed: stack.readBigNumber() }
    }

    async getRoundAt(provider: ContractProvider, time: number | bigint): Promise<bigint> {
        const args = new TupleBuilder()
        args.writeNumber(time)
        const { stack } = await provider.get('round_at', args.build())
        return stack.readBigNumber()
    }
}

// A cell holding just these bytes, as the probe expects for a signature or a public key.
export function bytesCell(bytes: Buffer): Cell {
    return beginCell().storeBuffer(bytes).endCell()
}
