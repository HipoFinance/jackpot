import { createHash } from 'crypto'
import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Dictionary,
    ExternalAddress,
    Sender,
    SendMode,
    Slice,
    toNano,
    TupleBuilder,
} from '@ton/core'

// Op codes: crc32 of "jackpot::<name>", see contracts/schema.tlb.
export const JackpotOp = {
    poke: 0x5444df0f,
    depositOptions: 0x8785a274,
    depositRefused: 0xa763e68f,
    prepareDeposit: 0x4ac19f29,
    depositReady: 0xc8682b07,
    depositBooked: 0x42e3c02d,
    depositCancelled: 0xa3d4c7cf,
    closeWallet: 0x0cba59a9,
    withdrawOptions: 0x63a28f24,
    burn: 0x595f07bc,
    burnNotification: 0x7bdd97de,
    closeNode: 0x07e3e272,
    provideWalletAddress: 0x2c76b973,
    takeWalletAddress: 0xd1735400,
    submitRandomness: 0x52cc77c3,
    refill: 0xa16904fa,
    hit: 0x5c850e0e,
    miss: 0x847501f7,
    update: 0x4bb1957e,
    descend: 0x3b4030a5,
    lost: 0xa6208f83,
    upgradeCode: 0x1870f697,
    setHipoWallet: 0x8ceea056,
    returnTokens: 0x842c3822,
    settleUnstake: 0x81d4ed7a,
    setBurnShare: 0xdf23bdaf,
    setMinPot: 0x19ee5cbe,
    setBurnBatch: 0xc82e7221,
    setMinDeposit: 0x0cf62e2f,
    setRiseMin: 0xa13346fa,
    setMinGap: 0x996900dc,
    setContent: 0xeb4dbc1b,
    setHalter: 0x271f8ef1,
    setHalted: 0xd3cb3ba0,
    clearFalling: 0xdf19084f,
    withdrawSurplus: 0x9a30705b,
    retire: 0xf6e41c95,
    setSuccessor: 0xefd50f41,
    withdrawFor: 0x2742c19b,
    closeSubtree: 0x4cf9e825,
    sweep: 0xca7fef55,
    setTreasury: 0xf0be6c1c,
    rescueJetton: 0xa24305cd,
    rescueNft: 0xd672136a,
    ownershipAssigned: 0x05138d91,
    nftTransfer: 0x5fcc3d14,

    // Hipo's
    sendTokens: 0x0f8a7ea5,
    transferNotification: 0x7362d09c,
    gasExcess: 0xd53276db,
    provideCurrentQuote: 0xad83913f,
    takeCurrentQuote: 0x0a420458,
    unstakeTokens: 0x595f07bc,
    withdrawalNotification: 0xf0fa223b,
    topUp: 0x5372158c,
} as const

// A full-body bounce, the network's: new_bounce_body#fffffffe.
export const newBounce = 0xfffffffe
export const oldBounce = 0xffffffff

export const JackpotError = {
    insufficientFee: 101,
    insufficientFunds: 102,
    accessDenied: 103,
    halted: 106,
    invalidOp: 107,
    invalidParameters: 109,
    rateFalling: 402,
    notWaitingForRandomness: 404,
    tooLate: 405,
    notSetUp: 411,
    opening: 412,
    unknownVersion: 413,
    drawChanged: 415,
    notTransferable: 416,
    floatTooLow: 417,
    refillNotNeeded: 418,
    forgedBounce: 419,
    notRetired: 420,
    notSwept: 421,
    cannotSweep: 422,
    badComment: 423,
    tooManyOwners: 424,
} as const

export const DrawState = { none: 0, waiting: 1, resolving: 2 } as const

// The ops of the logs: crc32("jackpot::<name>").
export const LogTopic = {
    booking: 0x3b7e3b47,
    withdrawal: 0x9cef1f7e,
    refused: 0xa9f1b394,
    bookingUndone: 0xac38ff53,
    boundary: 0xcb9aaaba,
    skip: 0x7bf99681,
    randomness: 0xa02c7ffb,
    slot: 0x9d87edd2,
    unstake: 0xa5fc9f67,
    untracked: 0xf4763a43,
    settings: 0x1c421ecd,
    retired: 0xa6a4f6b3,
    successor: 0x5de56438,
    swept: 0xe9b4624d,
    hipoWallet: 0x064510fb,
    treasury: 0x5025a5bc,
    foreignReturn: 0x63eaf860,
} as const

// Why a deposit is refused.
export const Reason = {
    halted: 1,
    retired: 2,
    rateFalling: 3,
    belowMinDeposit: 4,
    price: 5,
    walletBusy: 6,
    treeFull: 7,
    badOptions: 8,
    lowValue: 9,
    walletUnavailable: 10,
} as const

export const SlotResult = { hit: 0, miss: 1, rolledOver: 2, expired: 3, returned: 4, lost: 5 } as const

// Protocol constants of contracts/imports/constants.fc.
export const attemptsPerSlot = 16
export const treeLevels = 4
export const storageVersion = 1
export const drandDelay = 60 // D
export const submitCutoff = 1800 // S
export const floatLow = toNano('8') // G_lo
export const floatHigh = toNano('15') // G_hi
export const maxPayloadCells = 8
export const maxWithdrawFor = 100
export const rewardSubmit = toNano('0.02') // r_s
export const handlerFee = toNano('0.02') // fee::handler

// Decisions of the spec, used as the initial parameters.
export const defaults = {
    burnShare: 1000n,
    minPot: toNano('1'),
    burnBatch: toNano('50'),
    minDeposit: toNano('10'),
    riseMin: 50, // parts per million
    minGap: 32768,
}

export interface JackpotConfig {
    treasury: Address
    parent: Address
    walletCode: Cell // Hipo's wallet code, as the parent stores it
    jettonWalletCode: Cell // the jGRAM wallet's code
    nodeCode: Cell
    burner: Address
    governor: Address
    halter: Address
    // The Jackpot's own hGRAM wallet. Leave it out: the contract derives it from its own address.
    wallet?: Address | null
    burnShare?: bigint
    minPot?: bigint
    burnBatch?: bigint
    minDeposit?: bigint
    riseMin?: number
    minGap?: number
    // Hipo's rate at deploy: the stored rate and the boundary rate
    quoteCoins: bigint
    quoteTokens: bigint
    // the deploy time
    lastBoundary: number
    content?: Cell
}

// TEP-64 on-chain metadata: name "Hipo Jackpot GRAM", symbol jGRAM, 9 decimals.
export function defaultContent(): Cell {
    const dict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell())
    const entry = (key: string, value: string) =>
        dict.set(
            BigInt('0x' + createHash('sha256').update(key).digest('hex')),
            beginCell().storeUint(0, 8).storeStringTail(value).endCell(),
        )
    entry('name', 'Hipo Jackpot GRAM')
    entry('symbol', 'jGRAM')
    entry('decimals', '9')
    entry('description', 'Non-transferable. Your principal in Hipo Jackpot; withdraw to get hGRAM back.')
    return beginCell().storeUint(0, 8).storeDict(dict).endCell()
}

// The retirement cell: retired, successor, successor_deposit_fee, swept.
export function retirementCell(retired: boolean, successor: Address | null, fee: bigint, swept: boolean): Cell {
    return beginCell().storeBit(retired).storeAddress(successor).storeCoins(fee).storeBit(swept).endCell()
}

// The deploy data: storage version 0, which the first message checks and rewrites (contracts/jackpot.fc).
export function jackpotConfigToCell(config: JackpotConfig): Cell {
    const params = beginCell()
        .storeUint(config.burnShare ?? defaults.burnShare, 16)
        .storeCoins(config.minPot ?? defaults.minPot)
        .storeCoins(config.burnBatch ?? defaults.burnBatch)
        .storeCoins(config.minDeposit ?? defaults.minDeposit)
        .endCell()
    const boundary = beginCell()
        .storeUint(config.lastBoundary, 32)
        .storeUint(config.quoteCoins, 128) // the boundary rate
        .storeUint(config.quoteTokens, 128)
        .storeUint(config.riseMin ?? defaults.riseMin, 32)
        .storeUint(config.minGap ?? defaults.minGap, 32)
        .storeUint(0, 32) // next min gap
        .storeUint(0, 32) // last unstake
        .endCell()
    const extra = beginCell()
        .storeCoins(0) // burn owed
        .storeCoins(0) // carried
        .storeCoins(0) // unstaking
        .storeUint(0, 32) // next position
        .storeUint(0, 32) // tag
        .storeRef(params)
        .storeRef(boundary)
        .storeRef(config.content ?? defaultContent())
        .endCell()
    const misc = beginCell().storeCoins(0).storeCoins(0).storeCoins(0).endCell()
    const draw = beginCell()
        .storeUint(0, 2)
        .storeCoins(0) // snapshot tickets
        .storeUint(0, 256) // seed
        .storeUint(0, 32) // slots
        .storeUint(0, 256) // mc_hash
        .storeRef(misc)
        .endCell()
    const hipo = beginCell().storeAddress(config.parent).storeRef(config.walletCode).endCell()
    const roles = beginCell()
        .storeAddress(config.burner)
        .storeAddress(config.governor)
        .storeAddress(config.halter)
        .endCell()
    const addresses = beginCell()
        .storeAddress(config.treasury)
        .storeAddress(config.wallet ?? null)
        .storeRef(config.jettonWalletCode)
        .storeRef(config.nodeCode)
        .storeRef(hipo)
        .storeRef(roles)
        .endCell()
    return beginCell()
        .storeUint(0, 8) // version: the deploy data
        .storeCoins(0) // held tokens
        .storeCoins(0) // incoming tokens
        .storeCoins(0) // reserved tokens
        .storeCoins(0) // principal
        .storeCoins(0) // tickets
        .storeUint(config.quoteCoins, 128)
        .storeUint(config.quoteTokens, 128)
        .storeUint(0, 32) // query counter
        .storeBit(false) // halted
        .storeBit(false) // falling
        .storeRef(extra)
        .storeRef(draw)
        .storeRef(addresses)
        .storeRef(retirementCell(false, null, 0n, false))
        .endCell()
}

export interface JackpotState {
    heldTokens: bigint
    incomingTokens: bigint
    reservedTokens: bigint
    principal: bigint
    tickets: bigint
    nextPosition: bigint
    tag: bigint
    unstakingTokens: bigint
    carried: bigint
    quoteCoins: bigint
    quoteTokens: bigint
    halted: boolean
    falling: boolean
    burnShare: bigint
    minPot: bigint
    burnBatch: bigint
    burnOwed: bigint
    minDeposit: bigint
    nodeFloat: bigint
}

export interface BoundaryView {
    lastBoundary: number
    boundaryCoins: bigint
    boundaryTokens: bigint
    riseMin: number
    minGap: number
    nextMinGap: number
    earliestNextBoundary: number
    drandRound: bigint
}

export interface DrawStateView {
    state: number
    tag: bigint
    snapshotTickets: bigint
    round: bigint
    seed: bigint
    prizes: [bigint, bigint, bigint]
    openSlots: number
    attempts: [number, number, number]
    mcHash: bigint
}

export interface JackpotFees {
    deposit: bigint
    withdraw: bigint
    commentWithdraw: bigint
    submit: bigint
    poke: bigint
    refill: bigint
    unstake: bigint
    sweep: bigint
    return: bigint
    payload: bigint
    drawBudget: bigint
    floatLow: bigint
    floatHigh: bigint
    walletStorage: bigint
    nodeStorage: bigint
    // a payout with a cap-size payload, a move's options or a refund's deposit_refused
    payoutFee: bigint
    // provide_wallet_address
    tep89: bigint
}

// The parts the fees are built from, at the current price (get_fee_parts): for tests and monitoring.
export interface FeeParts {
    hop: bigint
    updateMin: bigint
    updateValue: bigint
    release: bigint
    hipoSend: bigint
    hipoUnstake: bigint
    bookedMin: bigint
    nodeShare: bigint
    wValue: bigint
    burnArrives: bigint
}

// What an app attaches to a burn: `burnFee` must already include the forward amount and the payload's fee, as
// jackpot.getBurnFee(forwardAmount, cells, bits) does. It is never less than the wallet's own minimum
// (wallet.getWalletMinimumInternal(), which counts no storage debt) plus the payload's forwarding (`payloadFee`, eight
// times fwd_simple(payload), and one fwd_simple more for the wallet's own hop) plus the wallet's debt, and a small margin.
// The debt is read from the wallet's account: its balance, due_payment and last_paid. `storagePrice` is {bit, cell} per
// 65536 seconds (config 18; the default is an upper bound for the basechain), and the wallet's size is the built wallet's.
export interface WalletAccount {
    balance: bigint
    duePayment: bigint
    lastPaid: number
}

export function burnAttach(
    burnFee: bigint,
    walletMinimum: bigint,
    payloadFee = 0n,
    account?: WalletAccount,
    now = Math.floor(Date.now() / 1000),
    storagePrice = { bit: 1n, cell: 500n },
    walletSize = { cells: 28n, bits: 13153n },
    margin = 1_000_000n,
): bigint {
    let debt = 0n
    if (account != null) {
        const elapsed = BigInt(Math.max(0, now - account.lastPaid))
        const fee = ((walletSize.cells * storagePrice.cell + walletSize.bits * storagePrice.bit) * elapsed + 65535n) / 65536n
        const owed = account.duePayment + fee - account.balance
        debt = owed > 0n ? owed : 0n
    }
    // payloadFee is 8 · fwd_simple(payload): the wallet checks its minimum for the payload plus that, and one hop more
    const floor = walletMinimum + payloadFee + payloadFee / 8n + debt
    return (burnFee > floor ? burnFee : floor) + margin
}

export class Jackpot implements Contract {
    constructor(
        readonly address: Address,
        readonly init?: { code: Cell; data: Cell },
    ) {}

    static createFromAddress(address: Address) {
        return new Jackpot(address)
    }

    static createFromConfig(config: JackpotConfig, code: Cell, workchain = 0) {
        const data = jackpotConfigToCell(config)
        const init = { code, data }
        return new Jackpot(contractAddress(workchain, init), init)
    }

    async sendMessage(provider: ContractProvider, via: Sender, value: bigint, body: Cell, bounce = true) {
        await provider.internal(via, { value, bounce, sendMode: SendMode.PAY_GAS_SEPARATELY, body })
    }

    // The first message checks the deploy data.
    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await this.sendMessage(provider, via, value, op(JackpotOp.topUp).endCell())
    }

    async sendTopUp(provider: ContractProvider, via: Sender, value: bigint) {
        await this.sendMessage(provider, via, value, op(JackpotOp.topUp).endCell())
    }

    // anyone: asks Hipo for its rate, and makes a boundary if the reply says so
    async sendPoke(provider: ContractProvider, via: Sender, opts: { value: bigint; queryId?: bigint }) {
        await this.sendMessage(provider, via, opts.value, op(JackpotOp.poke, opts.queryId).endCell())
    }

    // A plain message with a text comment: `w` withdraws everything.
    async sendComment(provider: ContractProvider, via: Sender, opts: { value: bigint; text: string }) {
        const body = beginCell().storeUint(0, 32).storeStringTail(opts.text).endCell()
        await this.sendMessage(provider, via, opts.value, body)
    }

    async sendProvideWalletAddress(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; owner: Address; includeAddress: boolean; queryId?: bigint },
    ) {
        const body = op(JackpotOp.provideWalletAddress, opts.queryId)
            .storeAddress(opts.owner)
            .storeBit(opts.includeAddress)
        await this.sendMessage(provider, via, opts.value, body.endCell())
    }

    async sendSubmitRandomness(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; signature: Cell; witness: Cell; queryId?: bigint },
    ) {
        const body = op(JackpotOp.submitRandomness, opts.queryId).storeRef(opts.signature).storeRef(opts.witness)
        await this.sendMessage(provider, via, opts.value, body.endCell())
    }

    async sendRefill(provider: ContractProvider, via: Sender, opts: { value: bigint; queryId?: bigint }) {
        await this.sendMessage(provider, via, opts.value, op(JackpotOp.refill, opts.queryId).endCell())
    }

    async sendSweep(provider: ContractProvider, via: Sender, opts: { value: bigint; queryId?: bigint }) {
        await this.sendMessage(provider, via, opts.value, op(JackpotOp.sweep, opts.queryId).endCell())
    }

    // governance

    async sendUpgradeCode(provider: ContractProvider, via: Sender, opts: { value: bigint; code: Cell }) {
        await this.sendMessage(provider, via, opts.value, op(JackpotOp.upgradeCode).storeRef(opts.code).endCell())
    }

    async sendSetHipoWallet(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; parent: Address; wallet: Address; walletCode: Cell },
    ) {
        const body = op(JackpotOp.setHipoWallet)
            .storeAddress(opts.parent)
            .storeAddress(opts.wallet)
            .storeRef(opts.walletCode)
        await this.sendMessage(provider, via, opts.value, body.endCell())
    }

    async sendReturnTokens(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; owner: Address; amount: bigint; inFlight?: boolean },
    ) {
        const body = op(JackpotOp.returnTokens)
            .storeAddress(opts.owner)
            .storeCoins(opts.amount)
            .storeBit(opts.inFlight ?? false)
        await this.sendMessage(provider, via, opts.value, body.endCell())
    }

    // credit true: unstaking -= amount and held_tokens += amount; false: unstaking -= amount only
    async sendSettleUnstake(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; amount: bigint; credit?: boolean },
    ) {
        const body = op(JackpotOp.settleUnstake).storeCoins(opts.amount).storeBit(opts.credit ?? true)
        await this.sendMessage(provider, via, opts.value, body.endCell())
    }

    // halted only, a basechain address
    async sendSetTreasury(provider: ContractProvider, via: Sender, opts: { value: bigint; treasury: Address }) {
        await this.sendMessage(provider, via, opts.value, op(JackpotOp.setTreasury).storeAddress(opts.treasury).endCell())
    }

    // a TEP-74 transfer from a jetton wallet the Jackpot owns; refused for its hGRAM wallet
    async sendRescueJetton(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; jettonWallet: Address; amount: bigint; destination: Address; queryId?: bigint },
    ) {
        const body = op(JackpotOp.rescueJetton, opts.queryId)
            .storeAddress(opts.jettonWallet)
            .storeCoins(opts.amount)
            .storeAddress(opts.destination)
        await this.sendMessage(provider, via, opts.value, body.endCell())
    }

    // a TEP-62 transfer of an NFT item the Jackpot owns
    async sendRescueNft(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; nft: Address; destination: Address; queryId?: bigint },
    ) {
        const body = op(JackpotOp.rescueNft, opts.queryId).storeAddress(opts.nft).storeAddress(opts.destination)
        await this.sendMessage(provider, via, opts.value, body.endCell())
    }

    async sendSetBurnShare(provider: ContractProvider, via: Sender, opts: { value: bigint; burnShare: bigint }) {
        const body = op(JackpotOp.setBurnShare).storeUint(opts.burnShare, 16)
        await this.sendMessage(provider, via, opts.value, body.endCell())
    }

    async sendSetMinPot(provider: ContractProvider, via: Sender, opts: { value: bigint; minPot: bigint }) {
        await this.sendMessage(provider, via, opts.value, op(JackpotOp.setMinPot).storeCoins(opts.minPot).endCell())
    }

    async sendSetBurnBatch(provider: ContractProvider, via: Sender, opts: { value: bigint; burnBatch: bigint }) {
        const body = op(JackpotOp.setBurnBatch).storeCoins(opts.burnBatch)
        await this.sendMessage(provider, via, opts.value, body.endCell())
    }

    async sendSetMinDeposit(provider: ContractProvider, via: Sender, opts: { value: bigint; minDeposit: bigint }) {
        const body = op(JackpotOp.setMinDeposit).storeCoins(opts.minDeposit)
        await this.sendMessage(provider, via, opts.value, body.endCell())
    }

    async sendSetRiseMin(provider: ContractProvider, via: Sender, opts: { value: bigint; riseMin: number }) {
        await this.sendMessage(provider, via, opts.value, op(JackpotOp.setRiseMin).storeUint(opts.riseMin, 32).endCell())
    }

    async sendSetMinGap(provider: ContractProvider, via: Sender, opts: { value: bigint; minGap: number }) {
        await this.sendMessage(provider, via, opts.value, op(JackpotOp.setMinGap).storeUint(opts.minGap, 32).endCell())
    }

    async sendSetContent(provider: ContractProvider, via: Sender, opts: { value: bigint; content: Cell }) {
        await this.sendMessage(provider, via, opts.value, op(JackpotOp.setContent).storeRef(opts.content).endCell())
    }

    async sendSetHalter(provider: ContractProvider, via: Sender, opts: { value: bigint; halter: Address }) {
        const body = op(JackpotOp.setHalter).storeAddress(opts.halter)
        await this.sendMessage(provider, via, opts.value, body.endCell())
    }

    async sendSetHalted(provider: ContractProvider, via: Sender, opts: { value: bigint; halted: boolean }) {
        await this.sendMessage(provider, via, opts.value, op(JackpotOp.setHalted).storeBit(opts.halted).endCell())
    }

    async sendClearFalling(provider: ContractProvider, via: Sender, opts: { value: bigint }) {
        await this.sendMessage(provider, via, opts.value, op(JackpotOp.clearFalling).endCell())
    }

    async sendWithdrawSurplus(provider: ContractProvider, via: Sender, opts: { value: bigint }) {
        await this.sendMessage(provider, via, opts.value, op(JackpotOp.withdrawSurplus).endCell())
    }

    async sendRetire(provider: ContractProvider, via: Sender, opts: { value: bigint }) {
        await this.sendMessage(provider, via, opts.value, op(JackpotOp.retire).endCell())
    }

    async sendSetSuccessor(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; successor: Address | null; depositFee: bigint },
    ) {
        const body = op(JackpotOp.setSuccessor).storeAddress(opts.successor).storeCoins(opts.depositFee)
        await this.sendMessage(provider, via, opts.value, body.endCell())
    }

    // owners: address hashes, 3 to a cell, chained by a ref
    async sendWithdrawFor(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; toSuccessor: boolean; owners: Address[]; valuePerOwner?: bigint },
    ) {
        // valuePerOwner: what each owner's burn carries; at least the formula's (get_fee_parts().wValue, plus the successor fee for a move)
        const body = op(JackpotOp.withdrawFor)
            .storeBit(opts.toSuccessor)
            .storeRef(ownersCell(opts.owners))
            .storeCoins(
                opts.valuePerOwner ??
                    (await this.getFeeParts(provider)).wValue +
                        (opts.toSuccessor ? (await this.getRetirement(provider)).successorDepositFee : 0n),
            )
        await this.sendMessage(provider, via, opts.value, body.endCell())
    }

    async sendCloseSubtree(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; level: number; index: number },
    ) {
        const body = op(JackpotOp.closeSubtree).storeUint(opts.level, 8).storeUint(opts.index, 32)
        await this.sendMessage(provider, via, opts.value, body.endCell())
    }

    // get methods

    async getStorageVersion(provider: ContractProvider): Promise<number> {
        const { stack } = await provider.get('get_storage_version', [])
        return stack.readNumber()
    }

    async getJackpotState(provider: ContractProvider): Promise<JackpotState> {
        const { stack } = await provider.get('get_jackpot_state', [])
        return {
            heldTokens: stack.readBigNumber(),
            incomingTokens: stack.readBigNumber(),
            reservedTokens: stack.readBigNumber(),
            principal: stack.readBigNumber(),
            tickets: stack.readBigNumber(),
            nextPosition: stack.readBigNumber(),
            tag: stack.readBigNumber(),
            unstakingTokens: stack.readBigNumber(),
            carried: stack.readBigNumber(),
            quoteCoins: stack.readBigNumber(),
            quoteTokens: stack.readBigNumber(),
            halted: stack.readBoolean(),
            falling: stack.readBoolean(),
            burnShare: stack.readBigNumber(),
            minPot: stack.readBigNumber(),
            burnBatch: stack.readBigNumber(),
            burnOwed: stack.readBigNumber(),
            minDeposit: stack.readBigNumber(),
            nodeFloat: stack.readBigNumber(),
        }
    }

    async getBoundary(provider: ContractProvider): Promise<BoundaryView> {
        const { stack } = await provider.get('get_boundary', [])
        return {
            lastBoundary: stack.readNumber(),
            boundaryCoins: stack.readBigNumber(),
            boundaryTokens: stack.readBigNumber(),
            riseMin: stack.readNumber(),
            minGap: stack.readNumber(),
            nextMinGap: stack.readNumber(),
            earliestNextBoundary: stack.readNumber(),
            drandRound: stack.readBigNumber(),
        }
    }

    async getRetirement(provider: ContractProvider) {
        const { stack } = await provider.get('get_retirement', [])
        return {
            retired: stack.readBoolean(),
            successor: stack.readAddressOpt(),
            successorDepositFee: stack.readBigNumber(),
        }
    }

    async getDrawState(provider: ContractProvider): Promise<DrawStateView> {
        const { stack } = await provider.get('get_draw_state', [])
        return {
            state: stack.readNumber(),
            tag: stack.readBigNumber(),
            snapshotTickets: stack.readBigNumber(),
            round: stack.readBigNumber(),
            seed: stack.readBigNumber(),
            prizes: [stack.readBigNumber(), stack.readBigNumber(), stack.readBigNumber()],
            openSlots: stack.readNumber(),
            attempts: [stack.readNumber(), stack.readNumber(), stack.readNumber()],
            mcHash: stack.readBigNumber(),
        }
    }

    // The position the open slot tries next, or -1.
    async getPosition(provider: ContractProvider, slot: number): Promise<bigint> {
        const args = new TupleBuilder()
        args.writeNumber(slot)
        const { stack } = await provider.get('get_position', args.build())
        return stack.readBigNumber()
    }

    async getQuote(provider: ContractProvider): Promise<[bigint, bigint]> {
        const { stack } = await provider.get('get_quote', [])
        return [stack.readBigNumber(), stack.readBigNumber()]
    }

    // TEP-74
    async getWalletAddress(provider: ContractProvider, owner: Address): Promise<Address> {
        const args = new TupleBuilder()
        args.writeAddress(owner)
        const { stack } = await provider.get('get_wallet_address', args.build())
        return stack.readAddress()
    }

    // TEP-74
    async getJettonData(provider: ContractProvider) {
        const { stack } = await provider.get('get_jetton_data', [])
        return {
            totalSupply: stack.readBigNumber(),
            mintable: stack.readBoolean(),
            admin: stack.readAddress(),
            content: stack.readCell(),
            walletCode: stack.readCell(),
        }
    }

    async getNodeAddress(provider: ContractProvider, level: number, index: bigint): Promise<Address> {
        const args = new TupleBuilder()
        args.writeNumber(level)
        args.writeNumber(index)
        const { stack } = await provider.get('get_node_address', args.build())
        return stack.readAddress()
    }

    async getAddresses(provider: ContractProvider) {
        const { stack } = await provider.get('get_addresses', [])
        return {
            treasury: stack.readAddress(),
            parent: stack.readAddress(),
            wallet: stack.readAddress(),
            burner: stack.readAddress(),
            governor: stack.readAddress(),
            halter: stack.readAddress(),
            walletCode: stack.readCell(),
            jettonWalletCode: stack.readCell(),
            nodeCode: stack.readCell(),
        }
    }

    async getJackpotFees(provider: ContractProvider): Promise<JackpotFees> {
        const { stack } = await provider.get('get_jackpot_fees', [])
        return {
            deposit: stack.readBigNumber(),
            withdraw: stack.readBigNumber(),
            commentWithdraw: stack.readBigNumber(),
            submit: stack.readBigNumber(),
            poke: stack.readBigNumber(),
            refill: stack.readBigNumber(),
            unstake: stack.readBigNumber(),
            sweep: stack.readBigNumber(),
            return: stack.readBigNumber(),
            payload: stack.readBigNumber(),
            drawBudget: stack.readBigNumber(),
            floatLow: stack.readBigNumber(),
            floatHigh: stack.readBigNumber(),
            walletStorage: stack.readBigNumber(),
            nodeStorage: stack.readBigNumber(),
            payoutFee: stack.readBigNumber(),
            tep89: stack.readBigNumber(),
        }
    }

    // the burn fee for a forward amount and a payload of `cells` and `bits` (outside its root), at the current price
    async getBurnFee(provider: ContractProvider, forwardAmount: bigint, cells: number, bits: number): Promise<bigint> {
        const { stack } = await provider.get('get_burn_fee', [
            { type: 'int', value: forwardAmount },
            { type: 'int', value: BigInt(cells) },
            { type: 'int', value: BigInt(bits) },
        ])
        return stack.readBigNumber()
    }

    async getFeeParts(provider: ContractProvider): Promise<FeeParts> {
        const { stack } = await provider.get('get_fee_parts', [])
        return {
            hop: stack.readBigNumber(),
            updateMin: stack.readBigNumber(),
            updateValue: stack.readBigNumber(),
            release: stack.readBigNumber(),
            hipoSend: stack.readBigNumber(),
            hipoUnstake: stack.readBigNumber(),
            bookedMin: stack.readBigNumber(),
            nodeShare: stack.readBigNumber(),
            wValue: stack.readBigNumber(),
            burnArrives: stack.readBigNumber(),
        }
    }

    // what a sweep must bring on top of fee::sweep to close the tree; 0 with no position ever assigned
    async getCloseCost(provider: ContractProvider): Promise<bigint> {
        const { stack } = await provider.get('get_close_cost', [])
        return stack.readBigNumber()
    }

    // the same for one node closed by close_subtree
    async getSubtreeCloseCost(provider: ContractProvider, level: number, index: number): Promise<bigint> {
        const args = new TupleBuilder()
        args.writeNumber(level)
        args.writeNumber(index)
        const { stack } = await provider.get('get_subtree_close_cost', args.build())
        return stack.readBigNumber()
    }

    async getBalance(provider: ContractProvider): Promise<bigint> {
        return (await provider.getState()).balance
    }
}

// The owners of a withdraw_for: 256-bit hashes, 3 to a cell, chained by a ref.
export function ownersCell(owners: Address[]): Cell {
    let next: Cell | null = null
    for (let i = Math.floor((owners.length - 1) / 3) * 3; i >= 0; i -= 3) {
        const b = beginCell()
        for (const o of owners.slice(i, i + 3)) b.storeBuffer(o.hash)
        if (next != null) b.storeRef(next)
        next = b.endCell()
    }
    return next ?? beginCell().endCell()
}

// The forward payload of a deposit: deposit_options, in a ref.
export interface DepositOptions {
    minPrincipal: bigint
    beneficiary?: Address | null
    responseDestination?: Address | null
    forwardTonAmount?: bigint
    forwardPayload?: Cell | null
}

export function depositOptions(o: DepositOptions): Cell {
    return beginCell()
        .storeUint(JackpotOp.depositOptions, 32)
        .storeCoins(o.minPrincipal)
        .storeAddress(o.beneficiary ?? null)
        .storeAddress(o.responseDestination ?? null)
        .storeCoins(o.forwardTonAmount ?? 0n)
        .storeMaybeRef(o.forwardPayload ?? null)
        .endCell()
}

// The forward payload of a deposit that sets only a price limit.
export function depositPayload(minPrincipal: bigint): Cell {
    return depositOptions({ minPrincipal })
}

export interface WithdrawOptions {
    toSuccessor?: boolean
    forwardTonAmount?: bigint
    forwardPayload?: Cell | null
}

export function withdrawOptions(o: WithdrawOptions): Cell {
    return beginCell()
        .storeUint(JackpotOp.withdrawOptions, 32)
        .storeBit(o.toSuccessor ?? false)
        .storeCoins(o.forwardTonAmount ?? 0n)
        .storeMaybeRef(o.forwardPayload ?? null)
        .endCell()
}

function op(code: number, queryId?: bigint) {
    return beginCell()
        .storeUint(code, 32)
        .storeUint(queryId ?? 0n, 64)
}

// A text comment, the way wallets send it.
export function textComment(text: string): Cell {
    return beginCell().storeUint(0, 32).storeStringTail(text).endCell()
}

// Logs: external-out messages to addr_none, the body starting with a 32-bit op.

export interface BookingLog {
    owner: Address
    depositor: Address
    b: bigint
    principal: bigint // c
    tokens: bigint // t
}
export interface WithdrawalLog {
    owner: Address
    b: bigint
    principal: bigint // x
    tokens: bigint // paid tokens
    last: boolean
    moved: boolean
    quoteCoins: bigint
    quoteTokens: bigint
}
export interface BoundaryLog {
    tag: bigint
    time: bigint
    quoteCoins: bigint
    quoteTokens: bigint
    snapshotTickets: bigint
    pot: bigint // before the unstake; 0 when nothing was set aside
    burn: bigint
    carried: bigint // before the boundary
    unstaked: bigint
    prizes?: [bigint, bigint, bigint]
    round?: bigint
    mcSeqno?: bigint
    mcHash?: bigint
}
export interface SkipLog {
    tag: bigint
    time: bigint
    quoteCoins: bigint
    quoteTokens: bigint
    reserved: bigint
    round: bigint
    mcSeqno: bigint
    mcHash: bigint
}
export interface RandomnessLog {
    tag: bigint
    round: bigint
    seed: bigint
}
export interface SlotLog {
    tag: bigint
    slot: number
    attempt: number
    result: number
    position: bigint // the ticket
    b: bigint // the position; for a lost descent, the index of the node that lost it
    amount: bigint
    owner: Address | null
}
export interface BookingUndoneLog {
    b: bigint
    principal: bigint
    tokens: bigint
}
export interface UnstakeLog {
    amount: bigint
    unstaking: bigint
    float: bigint
}
export interface UntrackedLog {
    cause: number
    tokens: bigint
}
export interface RefusedLog {
    owner: Address
    tokens: bigint
    value: bigint // v
    principal: bigint // c
    reason: number
}
export interface SettingsLog {
    riseMin: number
    minGap: number
    nextMinGap: number
}
export interface SuccessorLog {
    successor: Address | null
    depositFee: bigint
}
export interface HipoWalletLog {
    parent: Address
    wallet: Address
}
export interface TreasuryLog {
    treasury: Address
}
export interface ForeignReturnLog {
    from: Address
    sender: Address | null
    amount: bigint
    sent: boolean
}
export interface SweptLog {
    tokens: bigint
    nextPosition: bigint
}

// An external-out message as the sandbox returns it (ExternalOut) or as a Message.
export interface LogMessage {
    info: { dest?: ExternalAddress | Address | null }
    body: Cell
}

// The op of a log, or undefined for a message that is not one.
export function logTopic(message: LogMessage): number | undefined {
    if (message.body.bits.length < 32) return undefined
    return message.body.beginParse().preloadUint(32)
}

export function parseLog(message: LogMessage) {
    const topic = logTopic(message)
    if (topic == null) return undefined
    const s: Slice = message.body.beginParse()
    s.loadUint(32)
    return parseLogSlice(topic, s)
}

// parseLog, but the body must end where the constructor does: a leftover bit or reference throws.
export function parseLogStrict(message: LogMessage) {
    const topic = logTopic(message)
    if (topic == null) throw new Error('log without an op')
    const s: Slice = message.body.beginParse()
    s.loadUint(32)
    const parsed = parseLogSlice(topic, s)
    if (parsed == null) throw new Error(`unknown log op ${topic.toString(16)}`)
    if (s.remainingBits !== 0 || s.remainingRefs !== 0) throw new Error(`log ${topic.toString(16)} has trailing data`)
    return parsed
}

function parseLogSlice(topic: number, s: Slice) {
    switch (topic) {
        case LogTopic.booking:
            return {
                topic,
                log: {
                    owner: s.loadAddress(),
                    depositor: s.loadAddress(),
                    b: s.loadUintBig(32),
                    principal: s.loadCoins(),
                    tokens: s.loadCoins(),
                },
            }
        case LogTopic.withdrawal:
            return {
                topic,
                log: {
                    owner: s.loadAddress(),
                    b: s.loadUintBig(32),
                    principal: s.loadCoins(),
                    tokens: s.loadCoins(),
                    last: s.loadBit(),
                    moved: s.loadBit(),
                    quoteCoins: s.loadUintBig(128),
                    quoteTokens: s.loadUintBig(128),
                },
            }
        case LogTopic.boundary: {
            const log: BoundaryLog = {
                tag: s.loadUintBig(32),
                time: s.loadUintBig(32),
                quoteCoins: s.loadUintBig(128),
                quoteTokens: s.loadUintBig(128),
                snapshotTickets: s.loadCoins(),
                pot: s.loadCoins(),
                burn: s.loadCoins(),
                carried: s.loadCoins(),
                unstaked: s.loadCoins(),
            }
            if (s.loadBit()) {
                const r = s.loadRef().beginParse()
                log.prizes = [r.loadCoins(), r.loadCoins(), r.loadCoins()]
                log.round = r.loadUintBig(64)
                log.mcSeqno = r.loadUintBig(32)
                log.mcHash = r.loadUintBig(256)
            }
            return { topic, log }
        }
        case LogTopic.skip:
            return {
                topic,
                log: {
                    tag: s.loadUintBig(32),
                    time: s.loadUintBig(32),
                    quoteCoins: s.loadUintBig(128),
                    quoteTokens: s.loadUintBig(128),
                    reserved: s.loadCoins(),
                    round: s.loadUintBig(64),
                    mcSeqno: s.loadUintBig(32),
                    mcHash: s.loadUintBig(256),
                },
            }
        case LogTopic.randomness:
            return { topic, log: { tag: s.loadUintBig(32), round: s.loadUintBig(64), seed: s.loadUintBig(256) } }
        case LogTopic.slot:
            return {
                topic,
                log: {
                    tag: s.loadUintBig(32),
                    slot: s.loadUint(8),
                    attempt: s.loadUint(8),
                    result: s.loadUint(8),
                    position: s.loadUintBig(128),
                    b: s.loadUintBig(32),
                    amount: s.loadCoins(),
                    owner: s.loadMaybeAddress(),
                },
            }
        case LogTopic.bookingUndone:
            return { topic, log: { b: s.loadUintBig(32), principal: s.loadCoins(), tokens: s.loadCoins() } }
        case LogTopic.unstake:
            return { topic, log: { amount: s.loadCoins(), unstaking: s.loadCoins(), float: s.loadCoins() } }
        case LogTopic.untracked:
            return { topic, log: { cause: s.loadUint(8), tokens: s.loadCoins() } }
        case LogTopic.refused:
            return {
                topic,
                log: {
                    owner: s.loadAddress(),
                    tokens: s.loadCoins(),
                    value: s.loadCoins(),
                    principal: s.loadCoins(),
                    reason: s.loadUint(8),
                },
            }
        case LogTopic.settings:
            return { topic, log: { riseMin: s.loadUint(32), minGap: s.loadUint(32), nextMinGap: s.loadUint(32) } }
        case LogTopic.successor:
            return { topic, log: { successor: s.loadMaybeAddress(), depositFee: s.loadCoins() } }
        case LogTopic.swept:
            return { topic, log: { tokens: s.loadCoins(), nextPosition: s.loadUintBig(32) } }
        case LogTopic.hipoWallet:
            return { topic, log: { parent: s.loadAddress(), wallet: s.loadAddress() } }
        case LogTopic.treasury:
            return { topic, log: { treasury: s.loadAddress() } }
        case LogTopic.foreignReturn:
            return {
                topic,
                log: { from: s.loadAddress(), sender: s.loadMaybeAddress(), amount: s.loadCoins(), sent: s.loadBit() },
            }
        case LogTopic.retired:
            return { topic, log: {} }
    }
    return undefined
}

// The logs of one topic among a transaction chain's external-out messages, parsed.
export function logsOf<T>(messages: LogMessage[], topic: number): T[] {
    return messages.filter((m) => logTopic(m) === topic).map((m) => parseLog(m)?.log as T)
}
