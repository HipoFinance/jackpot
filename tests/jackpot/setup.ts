// Shared set-up for the Jackpot v2 tests: the real Hipo contracts (tests/hipo), a Jackpot wired to them,
// and helpers for the steps of each flow.
import { Blockchain, BlockchainTransaction, SandboxContract, SendMessageResult, TreasuryContract } from '@ton/sandbox'
import { Address, beginCell, Cell, Dictionary, Message, toNano } from '@ton/core'
import { compile } from '@ton/blueprint'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import { Hipo, deployHipo } from '../hipo/deploy'
import { UnstakeMode } from '../hipo/Wallet'
import {
    BookingLog,
    Jackpot,
    JackpotConfig,
    JackpotFees,
    JackpotOp,
    JackpotState,
    DepositOptions,
    LogTopic,
    SlotLog,
    depositOptions,
    drandDelay,
    logsOf,
} from '../../wrappers/Jackpot'
import { Wallet } from '../../wrappers/Wallet'
import { Node } from '../../wrappers/Node'
import { buildWitness, roundAt, roundTime } from '../../wrappers/drand'
import { compileTestJackpot, mcHashOf, testSignatureCell } from './testbuild'

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

// The recorded rounds the draws use. A draw whose boundary is T waits for the first round published at or
// after T + D, so a boundary at roundTime(R) - D draws with exactly R.
export const drawRounds = [33429893, 33430893]
export const farRound = 33000000

// The boundary whose draw waits for round R.
export function boundaryOf(round: number): number {
    return roundTime(round) - drandDelay
}

// The default start: the first test time. A boundary is whatever poke finds the rate risen and min_gap passed.
export const start = 1_800_000_000

export interface Env {
    blockchain: Blockchain
    hipo: Hipo
    jackpot: SandboxContract<Jackpot>
    governor: SandboxContract<TreasuryContract>
    halter: SandboxContract<TreasuryContract>
    burner: SandboxContract<TreasuryContract>
    keeper: SandboxContract<TreasuryContract>
    fakeTreasury?: SandboxContract<TreasuryContract>
    jettonWalletCode: Cell
    nodeCode: Cell
    fees: JackpotFees
    bookings: BookingLog[]
}

let jackpotCode: Cell | undefined
let jettonWalletCode: Cell | undefined
let nodeCode: Cell | undefined

export async function codes() {
    jackpotCode ??= await compile('Jackpot')
    jettonWalletCode ??= await compile('Wallet')
    nodeCode ??= await compile('Node')
    return { jackpotCode, jettonWalletCode, nodeCode }
}

export interface SetupOptions {
    config?: Partial<JackpotConfig>
    instantMint?: boolean
    // the start time, and the deploy time of the Jackpot (its first last_boundary)
    time?: number
    // the test build: any 48 bytes pass for a round's signature (tests/jackpot/testbuild.ts)
    testBuild?: boolean | 'failReady'
    // a treasury wallet stands in for Hipo's treasury; the test answers the quote requests
    fakeTreasury?: boolean
    // the float the Jackpot is deployed with
    float?: bigint
    // another node code than the built one (a test variant)
    nodeCode?: Cell
}

// The sandbox as the amendment needs it: mainnet's global version and capabilities (config 8), and the
// masterchain blocks PREVMCBLOCKS shows. The newest has the highest seqno.
export function setMcBlocks(blockchain: Blockchain, newest: number) {
    blockchain.prevBlocks = {
        lastMcBlocks: Array.from({ length: 16 }, (_, i) => ({
            workchain: -1,
            shard: -(2n ** 63n),
            seqno: newest - i,
            rootHash: createHash('sha256').update(`mc root ${(newest - i).toString()}`).digest(),
            fileHash: createHash('sha256').update(`mc file ${(newest - i).toString()}`).digest(),
        })),
        prevKeyBlock: {
            workchain: -1,
            shard: -(2n ** 63n),
            seqno: newest - 1000,
            rootHash: Buffer.alloc(32, 0x77),
            fileHash: Buffer.alloc(32, 0x78),
        },
    }
}

export function setMainnetVersion(blockchain: Blockchain) {
    const config = Dictionary.loadDirect(Dictionary.Keys.BigInt(32), Dictionary.Values.Cell(), blockchain.config)
    config.set(8n, beginCell().storeUint(0xc4, 8).storeUint(16, 32).storeUint(0x3ee, 64).endCell())
    const storage = beginCell()
    config.storeDirect(storage)
    blockchain.setConfig(storage.endCell())
}

export const mcSeqno = 5000

export async function setupJackpot(opts: SetupOptions = {}): Promise<Env> {
    const { jackpotCode: prodCode, jettonWalletCode, nodeCode: builtNodeCode } = await codes()
    const nodeCode = opts.nodeCode ?? builtNodeCode
    const jackpotCode = opts.testBuild
        ? await compileTestJackpot(opts.testBuild === 'failReady' ? 'failReady' : 'plain')
        : prodCode
    const blockchain = await Blockchain.create()
    blockchain.now = opts.time ?? start
    const hipo = await deployHipo(blockchain, { instantMint: opts.instantMint })
    setMainnetVersion(blockchain)
    setMcBlocks(blockchain, mcSeqno)
    const [, , , , walletCode] = await hipo.parent.getJettonData()

    const governor = await blockchain.treasury('jackpot-governor')
    const halter = await blockchain.treasury('jackpot-halter')
    const burner = await blockchain.treasury('burner')
    const keeper = await blockchain.treasury('keeper')
    const fakeTreasury = opts.fakeTreasury ? await blockchain.treasury('fake-treasury') : undefined
    const [quoteCoins, quoteTokens] = await hipo.quote()

    const jackpot = blockchain.openContract(
        Jackpot.createFromConfig(
            {
                treasury: fakeTreasury?.address ?? hipo.treasury.address,
                parent: hipo.parent.address,
                walletCode,
                jettonWalletCode,
                nodeCode,
                burner: burner.address,
                governor: governor.address,
                halter: halter.address,
                quoteCoins,
                quoteTokens,
                lastBoundary: blockchain.now,
                ...opts.config,
            },
            jackpotCode,
        ),
    )
    // the first message checks the deploy data
    const deploy = await jackpot.sendDeploy(governor.getSender(), opts.float ?? toNano('40'))
    expect(deploy.transactions).toHaveTransaction({ to: jackpot.address, deploy: true, success: true })

    const fees = await jackpot.getJackpotFees()
    return {
        blockchain,
        hipo,
        jackpot,
        governor,
        halter,
        burner,
        keeper,
        fakeTreasury,
        jettonWalletCode,
        nodeCode,
        fees,
        bookings: [],
    }
}

export function walletAt(env: Env, owner: Address): SandboxContract<Wallet> {
    return env.blockchain.openContract(
        Wallet.createFromConfig({ jackpot: env.jackpot.address, owner }, env.jettonWalletCode),
    )
}

export function nodeAt(env: Env, level: number, index: bigint): SandboxContract<Node> {
    return env.blockchain.openContract(
        Node.createFromConfig({ jackpot: env.jackpot.address, level, index }, env.nodeCode),
    )
}

export async function hgramOf(env: Env, owner: Address): Promise<bigint> {
    const wallet = await env.hipo.walletOf(owner)
    const state = await env.blockchain.getContract(wallet.address)
    if (state.accountState?.type !== 'active') return 0n
    const [tokens] = await wallet.getWalletState()
    return tokens
}

export async function balanceOf(env: Env, address: Address): Promise<bigint> {
    return (await env.blockchain.getContract(address)).balance
}

// A jGRAM wallet's balance, 0 when there is no such account.
export async function jgramOf(env: Env, owner: Address): Promise<bigint> {
    const wallet = walletAt(env, owner)
    const state = await env.blockchain.getContract(wallet.address)
    if (state.accountState?.type !== 'active') return 0n
    return (await wallet.getWalletState()).balance
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

// Gas used by the transactions that ran at `address`, per op.
export function gasOf(result: SendMessageResult, address: Address): { op?: number; gas: bigint }[] {
    return result.transactions
        .filter((tx) => tx.inMessage?.info.dest?.toString() === address.toString())
        .map((tx) => ({
            op: opOf(tx),
            gas:
                tx.description.type === 'generic' && tx.description.computePhase.type === 'vm'
                    ? tx.description.computePhase.gasUsed
                    : 0n,
        }))
}

export function bookingsIn(result: SendMessageResult): BookingLog[] {
    return logsOf<BookingLog>(result.externals, LogTopic.booking)
}

export function slotsIn(result: SendMessageResult): SlotLog[] {
    return logsOf<SlotLog>(result.externals, LogTopic.slot)
}

// Mints hGRAM for `player` at Hipo, the ordinary way.
export async function mintHgram(env: Env, player: SandboxContract<TreasuryContract>, gram: bigint) {
    const hipoFees = await env.hipo.treasury.getTreasuryFees(0n)
    await env.hipo.treasury.sendDepositCoins(player.getSender(), { value: gram + hipoFees.depositCoinsFee })
    return hgramOf(env, player.address)
}

// Sends `tokens` hGRAM from the player's wallet to the Jackpot with `forward` GRAM for the notification.
// `options` become deposit_options in a ref; `minC` alone is options with only a price limit; neither is a default deposit.
export async function depositHgram(
    env: Env,
    player: SandboxContract<TreasuryContract>,
    tokens: bigint,
    opts: {
        forward?: bigint
        minC?: bigint
        options?: DepositOptions
        payload?: Cell
        value?: bigint
        queryId?: bigint
    } = {},
) {
    const forward = opts.forward ?? env.fees.deposit
    const wallet = await env.hipo.walletOf(player.address)
    const options = opts.options ?? (opts.minC != null ? { minPrincipal: opts.minC } : undefined)
    const payload =
        opts.payload ?? (options != null ? beginCell().storeBit(true).storeRef(depositOptions(options)).endCell() : undefined)
    const result = await wallet.sendSendTokens(player.getSender(), {
        value: opts.value ?? forward + toNano('0.1'),
        tokens,
        recipient: env.jackpot.address,
        returnExcess: player.address,
        queryId: opts.queryId,
        forwardTonAmount: forward,
        forwardPayload: payload?.beginParse(),
    })
    const bookings = bookingsIn(result)
    env.bookings.push(...bookings)
    return { result, booking: bookings[0] as BookingLog | undefined }
}

// Mints and deposits in one go: `gram` of GRAM becomes hGRAM and then principal.
export async function stake(env: Env, player: SandboxContract<TreasuryContract>, gram: bigint, minC?: bigint) {
    const before = await hgramOf(env, player.address)
    const tokens = (await mintHgram(env, player, gram)) - before
    return { ...(await depositHgram(env, player, tokens, { minC })), tokens }
}

export async function withdraw(
    env: Env,
    player: SandboxContract<TreasuryContract>,
    amount: bigint,
    value: bigint = env.fees.withdraw,
) {
    return walletAt(env, player.address).sendBurn(player.getSender(), { value, amount })
}

export async function jackpotState(env: Env): Promise<JackpotState> {
    return env.jackpot.getJackpotState()
}

// F·TC ≥ P·TT at the stored quote, held = incoming + reserved + F, and the real wallet holds at least held.
export async function expectSolvent(env: Env) {
    const s = await jackpotState(env)
    const free = s.heldTokens - s.incomingTokens - s.reservedTokens
    expect(free).toBeGreaterThanOrEqual(0n)
    if (s.quoteTokens > 0n) {
        expect(free * s.quoteCoins).toBeGreaterThanOrEqual(s.principal * s.quoteTokens)
    }
    expect(s.tickets).toBe(s.principal)
    expect(await hgramOf(env, env.jackpot.address)).toBeGreaterThanOrEqual(s.heldTokens)
}

// Raises Hipo's rate by gifting `gram` to the treasury, as a round's reward does.
export async function reward(env: Env, gram: bigint) {
    return env.hipo.raiseRate(gram)
}

// A poke from the keeper: the quote round trip, and a boundary if the reply says so.
export async function poke(env: Env, value?: bigint) {
    return env.jackpot.sendPoke(env.keeper.getSender(), { value: value ?? env.fees.poke })
}

// A boundary: the time min_gap after the last one (or `at`), a reward large enough for rise_min, and a poke.
export async function makeBoundary(env: Env, opts: { at?: number; gram?: bigint } = {}) {
    const b = await env.jackpot.getBoundary()
    env.blockchain.now = opts.at ?? Math.max(env.blockchain.now ?? 0, b.lastBoundary + b.minGap)
    const [tc, tt] = await env.hipo.quote()
    // the least rate the boundary rule accepts, with a margin of 10 ppm
    const need = (b.boundaryCoins * tt * (1_000_000n + BigInt(b.riseMin + 10))) / (b.boundaryTokens * 1_000_000n) + 1n
    const gram = opts.gram ?? (need > tc ? need - tc : 0n)
    if (gram > 0n) await reward(env, gram)
    return poke(env)
}

export function advanceTo(env: Env, time: number) {
    env.blockchain.now = time
}

export async function submitRound(env: Env, round: number, value?: bigint) {
    const fixture = fixtureRound(round)
    return env.jackpot.sendSubmitRandomness(env.keeper.getSender(), {
        value: value ?? env.fees.submit,
        signature: beginCell().storeBuffer(Buffer.from(fixture.signature, 'hex')).endCell(),
        witness: buildWitness(round),
    })
}

// Hipo's instant unstake of `tokens` hGRAM by `player`, for tests that need a withdrawal_notification.
export async function unstake(env: Env, player: SandboxContract<TreasuryContract>, tokens: bigint) {
    const wallet = await env.hipo.walletOf(player.address)
    return wallet.sendUnstakeTokens(player.getSender(), {
        value: toNano('1'),
        tokens,
        mode: UnstakeMode.Instant,
    })
}

// An internal message as if `from` had sent it, for tests that act as a contract.
export function messageFrom(from: Address, to: Address, value: bigint, body: Cell, bounce = true): Message {
    return {
        info: {
            type: 'internal',
            ihrDisabled: true,
            bounce,
            bounced: false,
            src: from,
            dest: to,
            value: { coins: value },
            ihrFee: 0n,
            forwardFee: 0n,
            createdLt: 0n,
            createdAt: 0,
        },
        body,
    }
}

export { JackpotOp, mcHashOf }

// Submits with the test build: the round's test signature, a witness the build ignores.
export function submitTest(env: Env, round: number, value?: bigint, variant = 0) {
    return env.jackpot.sendSubmitRandomness(env.keeper.getSender(), {
        value: value ?? env.fees.submit,
        signature: testSignatureCell(round, variant),
        witness: beginCell().endCell(),
    })
}

// The drand round the draw of boundary t waits for.
export function roundOfBoundary(t: number): number {
    return roundAt(t + drandDelay)
}

export { roundTime }

// A TEP-74 transfer_notification a contract received in a chain, parsed.
export interface Note {
    from: Address
    value: bigint
    queryId: bigint
    amount: bigint
    sender: Address | null
    payload: Cell // the forward payload, whether it was inline or in a ref
}

export function notificationsTo(result: SendMessageResult, to: Address): Note[] {
    const out: Note[] = []
    for (const tx of result.transactions) {
        const info = tx.inMessage?.info
        if (info?.type !== 'internal' || info.dest.toString() !== to.toString() || tx.inMessage == null) continue
        if (opOf(tx) !== JackpotOp.transferNotification) continue
        const s = tx.inMessage.body.beginParse()
        s.skip(32)
        const queryId = s.loadUintBig(64)
        const amount = s.loadCoins()
        const sender = s.loadMaybeAddress()
        const payload = s.loadBit() ? s.loadRef() : beginCell().storeSlice(s).endCell()
        out.push({ from: info.src, value: info.value.coins, queryId, amount, sender, payload })
    }
    return out
}

// The gas_excess messages a contract received in a chain: their query_id and value.
export function excessesTo(result: SendMessageResult, to: Address): { queryId: bigint; value: bigint }[] {
    const out: { queryId: bigint; value: bigint }[] = []
    for (const tx of result.transactions) {
        const info = tx.inMessage?.info
        if (info?.type !== 'internal' || info.dest.toString() !== to.toString() || tx.inMessage == null) continue
        if (opOf(tx) !== JackpotOp.gasExcess) continue
        const s = tx.inMessage.body.beginParse()
        s.skip(32)
        out.push({ queryId: s.loadUintBig(64), value: info.value.coins })
    }
    return out
}

// A comment cell's text, or undefined for any other payload.
export function commentOf(payload: Cell): string | undefined {
    const s = payload.beginParse()
    if (s.remainingBits < 32 || s.loadUint(32) !== 0) return undefined
    return s.loadStringTail()
}

// A second Jackpot in the same sandbox, on the same Hipo, with the same roles: the successor of a migration. Its
// address differs by its deploy time. Returns an Env that shares everything with `env` but the Jackpot.
export async function deploySecondJackpot(env: Env, lastBoundary: number): Promise<Env> {
    const { jettonWalletCode, nodeCode } = await codes()
    const code = await compileTestJackpot('plain')
    const [, , , , walletCode] = await env.hipo.parent.getJettonData()
    const [quoteCoins, quoteTokens] = await env.hipo.quote()
    const a = await env.jackpot.getAddresses()
    const jackpot = env.blockchain.openContract(
        Jackpot.createFromConfig(
            {
                treasury: a.treasury,
                parent: a.parent,
                walletCode,
                jettonWalletCode,
                nodeCode,
                burner: a.burner,
                governor: a.governor,
                halter: a.halter,
                quoteCoins,
                quoteTokens,
                lastBoundary,
                minGap: 3600,
                minDeposit: 1n,
            },
            code,
        ),
    )
    const deploy = await jackpot.sendDeploy(env.governor.getSender(), toNano('40'))
    expect(deploy.transactions).toHaveTransaction({ to: jackpot.address, deploy: true, success: true })
    return { ...env, jackpot, fees: await jackpot.getJackpotFees(), bookings: [] }
}

// What a sweep must bring: fee::sweep and the funding of the close (the cascade's cost at the current prices).
export async function sweepValue(env: Env): Promise<bigint> {
    return env.fees.sweep + (await env.jackpot.getCloseCost())
}

// Sets the basechain gas price (config 21) to `nano` nano-GRAM per gas, the worst case the fees are sized at (the
// sandbox's own is lower). The prices are stored in 1/65536 nano-GRAM.
export function setGasPrice(blockchain: Blockchain, nano: bigint) {
    const config = Dictionary.loadDirect(Dictionary.Keys.BigInt(32), Dictionary.Values.Cell(), blockchain.config)
    const prices = config.get(21n)
    if (prices == null) throw new Error('no config 21')
    const old = prices.beginParse()
    const flatTag = old.loadUint(8)
    const flatLimit = old.loadUintBig(64)
    const flatPrice = old.loadUintBig(64)
    const extTag = old.loadUint(8)
    old.loadUintBig(64) // the old gas_price
    const rest = old.loadBits(old.remainingBits)
    config.set(
        21n,
        beginCell()
            .storeUint(flatTag, 8)
            .storeUint(flatLimit, 64)
            .storeUint(flatPrice, 64)
            .storeUint(extTag, 8)
            .storeUint(nano * 65536n, 64)
            .storeBits(rest)
            .endCell(),
    )
    const storage = beginCell()
    config.storeDirect(storage)
    blockchain.setConfig(storage.endCell())
}
