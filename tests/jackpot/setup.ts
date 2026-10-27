/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests read state they just made */
// Shared set-up for the Jackpot tests: the real Hipo contracts (tests/hipo), a Jackpot wired to them,
// and helpers for the steps of each flow.
import { Blockchain, BlockchainTransaction, SandboxContract, SendMessageResult, TreasuryContract } from '@ton/sandbox'
import { Address, beginCell, Cell, toNano } from '@ton/core'
import { compile } from '@ton/blueprint'
import { readFileSync } from 'fs'
import { join } from 'path'
import { Hipo, deployHipo } from '../hipo/deploy'
import {
    BookingLog,
    Jackpot,
    JackpotConfig,
    JackpotFees,
    JackpotOp,
    JackpotState,
    LogTopic,
    QuoteKind,
    logsOf,
} from '../../wrappers/Jackpot'
import { Range } from '../../wrappers/Range'
import { buildWitness, roundTime } from '../../wrappers/drand'

interface FixtureRound {
    round: number
    signature: string
    randomness: string
}

export const quicknet: FixtureRound[] = (
    JSON.parse(readFileSync(join(__dirname, '../fixtures/drand/quicknet.json'), 'utf8')) as { rounds: FixtureRound[] }
).rounds

export function fixtureRound(round: number): FixtureRound {
    const r = quicknet.find((x) => x.round === round)
    if (r == null) throw new Error(`no fixture for round ${round.toString()}`)
    return r
}

// Two recorded rounds 3000 s apart, about now. A draw started at roundTime(R) - 60 waits for exactly R.
export const drawRounds = [33429893, 33430893]

// The tests start an hour before the first recorded round.
export const startTime = roundTime(drawRounds[0]) - 3600

export interface Env {
    blockchain: Blockchain
    hipo: Hipo
    jackpot: SandboxContract<Jackpot>
    governor: SandboxContract<TreasuryContract>
    halter: SandboxContract<TreasuryContract>
    burner: SandboxContract<TreasuryContract>
    keeper: SandboxContract<TreasuryContract>
    // Set when the Jackpot asks a stand-in for quotes instead of Hipo's treasury.
    fakeTreasury?: SandboxContract<TreasuryContract>
    rangeCode: Cell
    fees: JackpotFees
    bookings: BookingLog[]
}

let jackpotCode: Cell | undefined
let rangeCode: Cell | undefined

export async function codes() {
    jackpotCode ??= await compile('Jackpot')
    rangeCode ??= await compile('Range')
    return { jackpotCode, rangeCode }
}

export async function setupJackpot(
    opts: { fakeTreasury?: boolean; config?: Partial<JackpotConfig>; instantMint?: boolean } = {},
): Promise<Env> {
    const { jackpotCode, rangeCode } = await codes()
    const blockchain = await Blockchain.create()
    blockchain.now = startTime
    const hipo = await deployHipo(blockchain, { instantMint: opts.instantMint })
    const [, , , , walletCode] = await hipo.parent.getJettonData()

    const governor = await blockchain.treasury('jackpot-governor')
    const halter = await blockchain.treasury('jackpot-halter')
    const burner = await blockchain.treasury('burner')
    const keeper = await blockchain.treasury('keeper')
    const fakeTreasury = opts.fakeTreasury ? await blockchain.treasury('fake-treasury') : undefined

    const jackpot = blockchain.openContract(
        Jackpot.createFromConfig(
            {
                treasury: fakeTreasury?.address ?? hipo.treasury.address,
                parent: hipo.parent.address,
                walletCode,
                rangeCode,
                burner: burner.address,
                governor: governor.address,
                halter: halter.address,
                ...opts.config,
            },
            jackpotCode,
        ),
    )
    const deploy = await jackpot.sendDeploy(governor.getSender(), toNano('11'))
    expect(deploy.transactions).toHaveTransaction({ to: jackpot.address, deploy: true, success: true })

    const fees = await jackpot.getJackpotFees()
    return { blockchain, hipo, jackpot, governor, halter, burner, keeper, fakeTreasury, rangeCode, fees, bookings: [] }
}

export function rangeAt(env: Env, start: bigint): SandboxContract<Range> {
    return env.blockchain.openContract(Range.createFromConfig({ jackpot: env.jackpot.address, start }, env.rangeCode))
}

export async function hgramOf(env: Env, owner: Address): Promise<bigint> {
    const wallet = await env.hipo.walletOf(owner)
    const state = await env.blockchain.getContract(wallet.address)
    if (state.accountState?.type !== 'active') return 0n
    const [tokens] = await wallet.getWalletState()
    return tokens
}

// Every transaction of the chain succeeded, in compute and action phase.
export function expectChainSucceeded(
    result: SendMessageResult,
    allowFailed: (tx: BlockchainTransaction) => boolean = () => false,
) {
    for (const tx of result.transactions) {
        if (tx.description.type !== 'generic') continue
        const compute = tx.description.computePhase
        const ok = (compute.type === 'skipped' || compute.success) && tx.description.actionPhase?.success !== false
        if (!ok && !allowFailed(tx)) {
            throw new Error(`failed transaction: ${String(tx.inMessage?.info.dest)} op ${String(opOf(tx))}`)
        }
    }
}

export function opOf(tx: BlockchainTransaction): number | undefined {
    const body = tx.inMessage?.body
    if (body == null) return undefined
    const s = body.beginParse()
    if (s.remainingBits < 32) return undefined
    return s.loadUint(32)
}

export function bookingsIn(result: SendMessageResult): BookingLog[] {
    return logsOf<BookingLog>(result.externals, LogTopic.booking)
}

// A GRAM deposit of `gram` (what is staked), plus the fee.
export async function depositGram(env: Env, player: SandboxContract<TreasuryContract>, gram: bigint) {
    const result = await env.jackpot.sendDeposit(player.getSender(), { value: gram + env.fees.deposit })
    const bookings = bookingsIn(result)
    env.bookings.push(...bookings)
    return { result, booking: bookings[0] as BookingLog | undefined }
}

// Mints hGRAM for `player` at Hipo, the ordinary way.
export async function mintHgram(env: Env, player: SandboxContract<TreasuryContract>, gram: bigint) {
    const hipoFees = await env.hipo.treasury.getTreasuryFees(0n)
    await env.hipo.treasury.sendDepositCoins(player.getSender(), { value: gram + hipoFees.depositCoinsFee })
    return hgramOf(env, player.address)
}

// Sends `tokens` hGRAM from the player's wallet to the Jackpot with `forward` GRAM for the notification.
export async function depositHgram(
    env: Env,
    player: SandboxContract<TreasuryContract>,
    tokens: bigint,
    forward: bigint = env.fees.hgramDeposit,
) {
    const wallet = await env.hipo.walletOf(player.address)
    const result = await wallet.sendSendTokens(player.getSender(), {
        value: forward + toNano('0.1'),
        tokens,
        recipient: env.jackpot.address,
        returnExcess: player.address,
        forwardTonAmount: forward,
    })
    const bookings = bookingsIn(result)
    env.bookings.push(...bookings)
    return { result, booking: bookings[0] as BookingLog | undefined }
}

export async function jackpotState(env: Env): Promise<JackpotState> {
    return env.jackpot.getJackpotState()
}

// F·TC ≥ P·TT at the stored quote, and the real wallet holds at least T.
export async function expectSolvent(env: Env) {
    const s = await jackpotState(env)
    const free = s.totalTokens - s.inFlight - s.setAside
    expect(free).toBeGreaterThanOrEqual(0n)
    if (s.quoteTokens > 0n) {
        expect(free * s.quoteCoins).toBeGreaterThanOrEqual(s.principal * s.quoteTokens)
    }
    expect(await hgramOf(env, env.jackpot.address)).toBeGreaterThanOrEqual(s.totalTokens)
}

// Moves to the next validation round, and raises Hipo's rate by gifting `gram` to the treasury.
export async function nextRound(env: Env, gram: bigint) {
    if (gram > 0n) await env.hipo.raiseRate(gram)
    await env.hipo.nextValidationRound()
}

export async function startDraw(env: Env, at?: number) {
    if (at != null) env.blockchain.now = at
    return env.jackpot.sendStartDraw(env.keeper.getSender(), { value: env.fees.startDraw })
}

export async function submitRound(env: Env, round: number) {
    const fixture = fixtureRound(round)
    return env.jackpot.sendSubmitRandomness(env.keeper.getSender(), {
        value: env.fees.submitRandomness,
        signature: beginCell().storeBuffer(Buffer.from(fixture.signature, 'hex')).endCell(),
        witness: buildWitness(round),
    })
}

// The booking whose range holds ticket r.
export function bookingOf(env: Env, r: bigint): BookingLog {
    const b = env.bookings.find((x) => x.start <= r && r < x.start + x.principal)
    if (b == null) throw new Error(`no range holds ticket ${r.toString()}`)
    return b
}

// Plays the keeper until every slot is settled: reads each open slot's ticket and locates its range.
export async function resolveDraw(env: Env) {
    const results: SendMessageResult[] = []
    for (let guard = 0; guard < 3 * 64 + 3; guard++) {
        const draw = await env.jackpot.getDrawState()
        if (draw.openSlots === 0) return results
        const slot = [0, 1, 2].find((i) => (draw.openSlots >> i) & 1)!
        const r = await env.jackpot.getTicket(slot)
        const booking = bookingOf(env, r)
        const result = await env.jackpot.sendLocate(env.keeper.getSender(), {
            value: env.fees.locate,
            slot,
            start: booking.start,
        })
        results.push(result)
    }
    throw new Error('draw did not resolve')
}

// The quote record of `kind` waiting for its reply, for tests that answer quotes by hand.
export async function pendingQuote(env: Env, kind: number = QuoteKind.booking): Promise<bigint> {
    const { quotes } = await env.jackpot.getBooks()
    const ids = [...quotes.entries()].filter(([, q]) => q.kind === kind).map(([id]) => id)
    if (ids.length !== 1) throw new Error(`expected one quote record of kind ${kind.toString()}, found ${ids.length.toString()}`)
    return ids[0]
}

// The stand-in treasury answers a quote request.
export async function replyQuote(env: Env, queryId: bigint, coins: bigint, tokens: bigint) {
    const body = beginCell()
        .storeUint(JackpotOp.takeCurrentQuote, 32)
        .storeUint(queryId, 64)
        .storeUint(coins, 128)
        .storeUint(tokens, 128)
        .storeMaybeRef(null)
        .endCell()
    return env.fakeTreasury!.send({ to: env.jackpot.address, value: toNano('0.05'), body })
}
