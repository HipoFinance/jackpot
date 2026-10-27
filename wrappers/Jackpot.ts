import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Dictionary,
    DictionaryValue,
    ExternalAddress,
    Sender,
    SendMode,
    Slice,
    toNano,
    TupleBuilder,
} from '@ton/core'

// Op codes: crc32 of "jackpot::<name>", see contracts/schema.tlb.
export const JackpotOp = {
    deposit: 0x7c6bacac,
    withdrawn: 0x32e2541b,
    startDraw: 0xb9af1e01,
    submitRandomness: 0x52cc77c3,
    locate: 0x100ffec7,
    requote: 0xfa418de9,
    expire: 0xff25ead2,
    claim: 0xe53d2340,
    hit: 0x5c850e0e,
    miss: 0x847501f7,
    rangeSetup: 0xe82ed41c,
    withdraw: 0x35528864,
    check: 0x7eda5174,
    upgradeCode: 0x1870f697,
    setHipoWallet: 0x8ceea056,
    resolvePending: 0x0827b963,
    returnTokens: 0x842c3822,
    settleFailedPayout: 0xf6b46a38,
    setBurnShare: 0xdf23bdaf,
    setMinPot: 0x19ee5cbe,
    setBurnBatch: 0xc82e7221,
    setMinDeposit: 0x0cf62e2f,
    setHalter: 0x271f8ef1,
    setHalted: 0xd3cb3ba0,
    clearFalling: 0xdf19084f,
    withdrawSurplus: 0x9a30705b,

    // Hipo's
    sendTokens: 0x0f8a7ea5,
    transferNotification: 0x7362d09c,
    gasExcess: 0xd53276db,
    provideCurrentQuote: 0xad83913f,
    takeCurrentQuote: 0x0a420458,
    depositCoins: 0x3d3761a6,
    topUp: 0x5372158c,
} as const

export const JackpotError = {
    insufficientFee: 101,
    insufficientFunds: 102,
    accessDenied: 103,
    onlyBasechainAllowed: 104,
    halted: 106,
    invalidOp: 107,
    invalidParameters: 109,
    depositTooSmall: 110,
    notIdle: 401,
    rateFalling: 402,
    roundNotChanged: 403,
    notWaitingForRandomness: 404,
    notResolving: 405,
    slotClosed: 406,
    tooSoon: 407,
    unknownQuery: 408,
    nothingToClaim: 409,
    alreadySetUp: 410,
    notSetUp: 411,
    ticketOutOfRange: 412,
} as const

export const DrawState = { idle: 0, quoting: 1, waiting: 2, resolving: 3 } as const

export const LogTopic = { booking: 1, withdrawal: 2, drawStart: 3, randomness: 4, slot: 5 } as const

export const SlotResult = { hit: 0, miss: 1, rolledOver: 2, expired: 3, held: 4 } as const

export const QuoteKind = { booking: 0, withdrawal: 1, draw: 2 } as const

// Decisions of the spec, used as the initial parameters.
export const defaults = {
    burnShare: 1000n,
    minPot: toNano('1'),
    burnBatch: toNano('50'),
    minDeposit: toNano('10'),
}

export interface JackpotConfig {
    treasury: Address
    parent: Address
    walletCode: Cell
    rangeCode: Cell
    burner: Address
    governor: Address
    halter: Address
    // The Jackpot's own hGRAM wallet. Leave it out: the contract derives it from its own address.
    wallet?: Address | null
    burnShare?: bigint
    minPot?: bigint
    burnBatch?: bigint
    minDeposit?: bigint
}

export function jackpotConfigToCell(config: JackpotConfig): Cell {
    const params = beginCell()
        .storeUint(config.burnShare ?? defaults.burnShare, 16)
        .storeCoins(config.minPot ?? defaults.minPot)
        .storeCoins(config.burnBatch ?? defaults.burnBatch)
        .storeCoins(config.minDeposit ?? defaults.minDeposit)
        .endCell()
    const lastStart = beginCell().storeUint(0, 32).storeCoins(0).storeUint(0, 128).storeUint(0, 128).endCell()
    const extra = beginCell().storeCoins(0).storeRef(params).storeRef(lastStart).endCell()
    const prizes = beginCell().storeCoins(0).storeCoins(0).storeCoins(0).endCell()
    const draw = beginCell()
        .storeUint(0, 2)
        .storeUint(0, 32)
        .storeUint(0, 64)
        .storeCoins(0)
        .storeUint(0, 64)
        .storeUint(0, 256)
        .storeUint(0, 32)
        .storeUint(0, 32)
        .storeRef(prizes)
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
        .storeRef(config.rangeCode)
        .storeRef(hipo)
        .storeRef(roles)
        .endCell()
    const books = beginCell().storeDict(null).storeDict(null).storeDict(null).storeDict(null).endCell()
    return beginCell()
        .storeCoins(0) // T
        .storeCoins(0) // I
        .storeCoins(0) // O
        .storeCoins(0) // P
        .storeCoins(0) // N
        .storeUint(0, 128) // TC
        .storeUint(0, 128) // TT
        .storeUint(0, 32) // query counter
        .storeBit(false) // halted
        .storeBit(false) // falling
        .storeRef(extra)
        .storeRef(draw)
        .storeRef(addresses)
        .storeRef(books)
        .endCell()
}

export interface JackpotState {
    totalTokens: bigint
    inFlight: bigint
    setAside: bigint
    principal: bigint
    nextTicket: bigint
    quoteCoins: bigint
    quoteTokens: bigint
    halted: boolean
    falling: boolean
    burnShare: bigint
    minPot: bigint
    burnBatch: bigint
    burnOwed: bigint
    minDeposit: bigint
    lastRoundSince: bigint
    cutoff: bigint
    lastCoins: bigint
    lastTokens: bigint
}

export interface DrawStateView {
    state: number
    drawId: bigint
    queryId: bigint
    cutoff: bigint
    round: bigint
    seed: bigint
    randomnessTime: bigint
    prizes: [bigint, bigint, bigint]
    openSlots: number
    attempts: [number, number, number]
}

export interface JackpotFees {
    deposit: bigint
    hgramDeposit: bigint
    withdraw: bigint
    startDraw: bigint
    submitRandomness: bigint
    locate: bigint
    requote: bigint
    expire: bigint
    claim: bigint
}

export interface QuoteRecord {
    createdAt: number
    kind: number
    owner?: Address
    tokens?: bigint
    start?: bigint
    amount?: bigint
    roundSince?: number
}

export interface PayoutRecord {
    kind: number
    recipient: Address
    amount: bigint
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

    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await this.sendMessage(provider, via, value, op(JackpotOp.topUp).endCell())
    }

    async sendTopUp(provider: ContractProvider, via: Sender, value: bigint) {
        await this.sendMessage(provider, via, value, op(JackpotOp.topUp).endCell())
    }

    async sendDeposit(provider: ContractProvider, via: Sender, opts: { value: bigint; queryId?: bigint }) {
        await this.sendMessage(provider, via, opts.value, op(JackpotOp.deposit, opts.queryId).endCell())
    }

    async sendStartDraw(provider: ContractProvider, via: Sender, opts: { value: bigint; queryId?: bigint }) {
        await this.sendMessage(provider, via, opts.value, op(JackpotOp.startDraw, opts.queryId).endCell())
    }

    async sendSubmitRandomness(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; signature: Cell; witness: Cell; queryId?: bigint },
    ) {
        const body = op(JackpotOp.submitRandomness, opts.queryId).storeRef(opts.signature).storeRef(opts.witness)
        await this.sendMessage(provider, via, opts.value, body.endCell())
    }

    async sendLocate(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; slot: number; start: bigint; queryId?: bigint },
    ) {
        const body = op(JackpotOp.locate, opts.queryId).storeUint(opts.slot, 8).storeUint(opts.start, 128)
        await this.sendMessage(provider, via, opts.value, body.endCell())
    }

    async sendRequote(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; target: bigint; queryId?: bigint },
    ) {
        const body = op(JackpotOp.requote, opts.queryId).storeUint(opts.target, 64)
        await this.sendMessage(provider, via, opts.value, body.endCell())
    }

    async sendExpire(provider: ContractProvider, via: Sender, opts: { value: bigint; slot: number; queryId?: bigint }) {
        const body = op(JackpotOp.expire, opts.queryId).storeUint(opts.slot, 8)
        await this.sendMessage(provider, via, opts.value, body.endCell())
    }

    async sendClaim(provider: ContractProvider, via: Sender, opts: { value: bigint; queryId?: bigint }) {
        await this.sendMessage(provider, via, opts.value, op(JackpotOp.claim, opts.queryId).endCell())
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

    async sendResolvePending(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; target: bigint; tokens: bigint },
    ) {
        const body = op(JackpotOp.resolvePending).storeUint(opts.target, 64).storeCoins(opts.tokens)
        await this.sendMessage(provider, via, opts.value, body.endCell())
    }

    async sendReturnTokens(
        provider: ContractProvider,
        via: Sender,
        opts: { value: bigint; owner: Address; amount: bigint },
    ) {
        const body = op(JackpotOp.returnTokens).storeAddress(opts.owner).storeCoins(opts.amount)
        await this.sendMessage(provider, via, opts.value, body.endCell())
    }

    async sendSettleFailedPayout(provider: ContractProvider, via: Sender, opts: { value: bigint; target: bigint }) {
        const body = op(JackpotOp.settleFailedPayout).storeUint(opts.target, 64)
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

    // get methods

    async getJackpotState(provider: ContractProvider): Promise<JackpotState> {
        const { stack } = await provider.get('get_jackpot_state', [])
        return {
            totalTokens: stack.readBigNumber(),
            inFlight: stack.readBigNumber(),
            setAside: stack.readBigNumber(),
            principal: stack.readBigNumber(),
            nextTicket: stack.readBigNumber(),
            quoteCoins: stack.readBigNumber(),
            quoteTokens: stack.readBigNumber(),
            halted: stack.readBoolean(),
            falling: stack.readBoolean(),
            burnShare: stack.readBigNumber(),
            minPot: stack.readBigNumber(),
            burnBatch: stack.readBigNumber(),
            burnOwed: stack.readBigNumber(),
            minDeposit: stack.readBigNumber(),
            lastRoundSince: stack.readBigNumber(),
            cutoff: stack.readBigNumber(),
            lastCoins: stack.readBigNumber(),
            lastTokens: stack.readBigNumber(),
        }
    }

    async getDrawState(provider: ContractProvider): Promise<DrawStateView> {
        const { stack } = await provider.get('get_draw_state', [])
        return {
            state: stack.readNumber(),
            drawId: stack.readBigNumber(),
            queryId: stack.readBigNumber(),
            cutoff: stack.readBigNumber(),
            round: stack.readBigNumber(),
            seed: stack.readBigNumber(),
            randomnessTime: stack.readBigNumber(),
            prizes: [stack.readBigNumber(), stack.readBigNumber(), stack.readBigNumber()],
            openSlots: stack.readNumber(),
            attempts: [stack.readNumber(), stack.readNumber(), stack.readNumber()],
        }
    }

    async getTicket(provider: ContractProvider, slot: number): Promise<bigint> {
        const args = new TupleBuilder()
        args.writeNumber(slot)
        const { stack } = await provider.get('get_ticket', args.build())
        return stack.readBigNumber()
    }

    async getQuote(provider: ContractProvider): Promise<[bigint, bigint]> {
        const { stack } = await provider.get('get_quote', [])
        return [stack.readBigNumber(), stack.readBigNumber()]
    }

    async getRangeAddress(provider: ContractProvider, start: bigint): Promise<Address> {
        const args = new TupleBuilder()
        args.writeNumber(start)
        const { stack } = await provider.get('get_range_address', args.build())
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
            rangeCode: stack.readCell(),
        }
    }

    async getBooks(provider: ContractProvider) {
        const { stack } = await provider.get('get_books', [])
        const pending = Dictionary.loadDirect(
            Dictionary.Keys.BigUint(64),
            inline,
            stack.readCellOpt(),
        )
        const quotes = Dictionary.loadDirect(Dictionary.Keys.BigUint(64), inline, stack.readCellOpt())
        const payouts = Dictionary.loadDirect(
            Dictionary.Keys.BigUint(64),
            inline,
            stack.readCellOpt(),
        )
        const claimable = Dictionary.loadDirect(
            Dictionary.Keys.BigUint(256),
            inline,
            stack.readCellOpt(),
        )
        return {
            pending: new Map(
                pending.keys().map((k) => {
                    const s = must(pending.get(k)).beginParse()
                    return [k, { owner: s.loadAddress(), createdAt: s.loadUint(32) }]
                }),
            ),
            quotes: new Map(quotes.keys().map((k) => [k, parseQuote(must(quotes.get(k)))])),
            payouts: new Map(payouts.keys().map((k) => [k, parsePayout(must(payouts.get(k)))])),
            claimable: new Map(
                claimable.keys().map((k) => {
                    const s = must(claimable.get(k)).beginParse()
                    return [s.loadAddress().toString(), s.loadCoins()]
                }),
            ),
        }
    }

    async getClaimable(provider: ContractProvider, owner: Address): Promise<bigint> {
        const args = new TupleBuilder()
        args.writeAddress(owner)
        const { stack } = await provider.get('get_claimable', args.build())
        return stack.readBigNumber()
    }

    async getJackpotFees(provider: ContractProvider): Promise<JackpotFees> {
        const { stack } = await provider.get('get_jackpot_fees', [])
        return {
            deposit: stack.readBigNumber(),
            hgramDeposit: stack.readBigNumber(),
            withdraw: stack.readBigNumber(),
            startDraw: stack.readBigNumber(),
            submitRandomness: stack.readBigNumber(),
            locate: stack.readBigNumber(),
            requote: stack.readBigNumber(),
            expire: stack.readBigNumber(),
            claim: stack.readBigNumber(),
        }
    }

    async getBalance(provider: ContractProvider): Promise<bigint> {
        return (await provider.getState()).balance
    }
}

function must<T>(x: T | undefined): T {
    if (x === undefined) throw new Error('missing dict value')
    return x
}

// Dict values the contract stores inline (udict_set_builder), read back as a cell of their own.
const inline: DictionaryValue<Cell> = {
    serialize: (src, builder) => {
        builder.storeSlice(src.beginParse())
    },
    parse: (src) => src.asCell(),
}

function op(code: number, queryId?: bigint) {
    return beginCell()
        .storeUint(code, 32)
        .storeUint(queryId ?? 0n, 64)
}

function parseQuote(cell: Cell): QuoteRecord {
    const s = cell.beginParse()
    const createdAt = s.loadUint(32)
    const kind = s.loadUint(2)
    if (kind === QuoteKind.booking) {
        return { createdAt, kind, owner: s.loadAddress(), tokens: s.loadCoins() }
    }
    if (kind === QuoteKind.withdrawal) {
        return { createdAt, kind, owner: s.loadAddress(), start: s.loadUintBig(128), amount: s.loadCoins() }
    }
    return { createdAt, kind, roundSince: s.loadUint(32) }
}

function parsePayout(cell: Cell): PayoutRecord {
    const s = cell.beginParse()
    return { kind: s.loadUint(1), recipient: s.loadAddress(), amount: s.loadCoins() }
}

// Logs: external-out messages to addr_extern(256 bits) = topic.

export interface BookingLog {
    owner: Address
    start: bigint
    principal: bigint
    tokens: bigint
}
export interface WithdrawalLog {
    owner: Address
    start: bigint
    principal: bigint
    tokens: bigint
}
export interface DrawStartLog {
    drawId: bigint
    roundSince: bigint
    cutoff: bigint
    nextCutoff: bigint
    pot: bigint
    burn: bigint
    prizes: [bigint, bigint, bigint]
    drandRound: bigint
}
export interface RandomnessLog {
    drawId: bigint
    drandRound: bigint
    seed: bigint
}
export interface SlotLog {
    drawId: bigint
    slot: number
    attempt: number
    result: number
    ticket: bigint
    start: bigint
    amount: bigint
    owner: Address | null
}

// An external-out message as the sandbox returns it (ExternalOut) or as a Message.
export interface LogMessage {
    info: { dest?: ExternalAddress | Address | null }
    body: Cell
}

// The body as parsed out of the message, inline or ^Cell alike.
function logBody(message: LogMessage): Slice {
    return message.body.beginParse()
}

export function logTopic(message: LogMessage): number | undefined {
    const dest = message.info.dest
    return dest instanceof ExternalAddress ? Number(dest.value) : undefined
}

export function parseLog(message: LogMessage) {
    const topic = logTopic(message)
    if (topic == null) return undefined
    const s = logBody(message)
    switch (topic) {
        case LogTopic.booking:
            return {
                topic,
                log: {
                    owner: s.loadAddress(),
                    start: s.loadUintBig(128),
                    principal: s.loadCoins(),
                    tokens: s.loadCoins(),
                },
            }
        case LogTopic.withdrawal:
            return {
                topic,
                log: {
                    owner: s.loadAddress(),
                    start: s.loadUintBig(128),
                    principal: s.loadCoins(),
                    tokens: s.loadCoins(),
                },
            }
        case LogTopic.drawStart:
            return {
                topic,
                log: {
                    drawId: s.loadUintBig(32),
                    roundSince: s.loadUintBig(32),
                    cutoff: s.loadCoins(),
                    nextCutoff: s.loadCoins(),
                    pot: s.loadCoins(),
                    burn: s.loadCoins(),
                    prizes: [s.loadCoins(), s.loadCoins(), s.loadCoins()],
                    drandRound: s.loadUintBig(64),
                },
            }
        case LogTopic.randomness:
            return {
                topic,
                log: { drawId: s.loadUintBig(32), drandRound: s.loadUintBig(64), seed: s.loadUintBig(256) },
            }
        case LogTopic.slot:
            return {
                topic,
                log: {
                    drawId: s.loadUintBig(32),
                    slot: s.loadUint(8),
                    attempt: s.loadUint(8),
                    result: s.loadUint(8),
                    ticket: s.loadUintBig(128),
                    start: s.loadUintBig(128),
                    amount: s.loadCoins(),
                    owner: s.loadMaybeAddress(),
                },
            }
    }
    return undefined
}

// The logs of one topic among a transaction chain's external-out messages, parsed.
export function logsOf<T>(messages: LogMessage[], topic: number): T[] {
    return messages.filter((m) => logTopic(m) === topic).map((m) => parseLog(m)?.log as T)
}
