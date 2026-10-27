/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests read state they just made */
// Helpers for the acceptance, attack and property tests: a set-up at any start time, a message runner
// that can hold, drop or reorder messages, direct edits of Hipo's state (participations, wallets), forged
// message bodies, and fast reads of the Jackpot's counters straight from its data cell.
import { Blockchain, BlockchainTransaction, internal, SandboxContract, TreasuryContract } from '@ton/sandbox'
import { Address, beginCell, Cell, Message, toNano } from '@ton/core'
import { createHash } from 'crypto'
import { deployHipo } from '../hipo/deploy'
import { ParticipationState, treasuryConfigToCell } from '../hipo/Treasury'
import { BookingLog, Jackpot, JackpotConfig, JackpotOp, LogMessage, LogTopic, logsOf } from '../../wrappers/Jackpot'
import { Env, codes, depositGram, drawRounds, fixtureRound, nextRound, startDraw, submitRound } from './setup'
import { buildWitness, roundTime } from '../../wrappers/drand'

// setupJackpot with a start time of the caller's choice, so a test can run draws for older drand rounds
// (the sandbox refuses to move an account's clock backwards).
export async function setupAt(
    time: number,
    opts: { fakeTreasury?: boolean; config?: Partial<JackpotConfig>; instantMint?: boolean } = {},
): Promise<Env> {
    const { jackpotCode, rangeCode } = await codes()
    const blockchain = await Blockchain.create()
    blockchain.now = time
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
    await jackpot.sendDeploy(governor.getSender(), toNano('11'))
    const fees = await jackpot.getJackpotFees()
    return { blockchain, hipo, jackpot, governor, halter, burner, keeper, fakeTreasury, rangeCode, fees, bookings: [] }
}

// ---- a message runner with control over delivery ----------------------------------------------------------

export interface Run {
    transactions: BlockchainTransaction[]
    externals: LogMessage[]
    held: Message[]
}

// Runs one message and everything it causes, one transaction at a time, breadth first like the sandbox.
// `hold` keeps a message out of the run (the caller can deliver it later, or never: a dropped message).
// `after` runs after every transaction, for invariant checks.
export async function deliver(
    blockchain: Blockchain,
    first: Message | Message[],
    opts: {
        hold?: (m: Message) => boolean
        after?: (tx: BlockchainTransaction) => Promise<void>
    } = {},
): Promise<Run> {
    const queue: Message[] = Array.isArray(first) ? [...first] : [first]
    const run: Run = { transactions: [], externals: [], held: [] }
    while (queue.length > 0) {
        const message = queue.shift()!
        const it = await blockchain.sendMessageIter(message, { allowParallel: true })
        const step = await it.next()
        if (step.done === true) continue
        const tx = step.value
        run.transactions.push(tx)
        if (opts.after != null) await opts.after(tx)
        for (const [, out] of tx.outMessages) {
            if (out.info.type === 'external-out') {
                run.externals.push({ info: { dest: out.info.dest }, body: out.body })
                continue
            }
            if (out.info.type !== 'internal') continue
            if (opts.hold?.(out) === true) run.held.push(out)
            else queue.push(out)
        }
    }
    return run
}

// An internal message as a wallet of `from` would send it (the sandbox does not charge `from`).
export function msg(from: Address, to: Address, value: bigint, body: Cell, bounce = true): Message {
    return internal({ from, to, value, body, bounce })
}

export function opOfMessage(m: Message): number | undefined {
    const s = m.body.beginParse()
    return s.remainingBits >= 32 ? s.loadUint(32) : undefined
}

export function queryIdOfMessage(m: Message): bigint {
    const s = m.body.beginParse()
    s.skip(32)
    return s.loadUintBig(64)
}

export function isTo(m: Message, to: Address, op?: number): boolean {
    return m.info.type === 'internal' && m.info.dest.equals(to) && (op == null || opOfMessage(m) === op)
}

export function isFrom(m: Message, from: Address, op?: number): boolean {
    return m.info.type === 'internal' && m.info.src.equals(from) && (op == null || opOfMessage(m) === op)
}

// ---- fast reads ----------------------------------------------------------------------------------------

export interface Counters {
    T: bigint
    I: bigint
    O: bigint
    P: bigint
    N: bigint
    TC: bigint
    TT: bigint
    halted: boolean
    falling: boolean
}

export async function dataOf(blockchain: Blockchain, address: Address): Promise<Cell | undefined> {
    const state = (await blockchain.getContract(address)).accountState
    return state?.type === 'active' ? (state.state.data ?? undefined) : undefined
}

// The Jackpot's counters, parsed from its data cell (the layout of JackpotStorage in schema.tlb).
export async function counters(env: Env): Promise<Counters> {
    const s = (await dataOf(env.blockchain, env.jackpot.address))!.beginParse()
    const T = s.loadCoins()
    const I = s.loadCoins()
    const O = s.loadCoins()
    const P = s.loadCoins()
    const N = s.loadCoins()
    const TC = s.loadUintBig(128)
    const TT = s.loadUintBig(128)
    s.skip(32)
    const halted = s.loadBit()
    return { T, I, O, P, N, TC, TT, halted, falling: s.loadBit() }
}

// The hGRAM a Hipo wallet holds, parsed from its data (owner, parent, tokens, ...); 0 when not deployed.
export async function walletTokens(blockchain: Blockchain, wallet: Address): Promise<bigint> {
    const data = await dataOf(blockchain, wallet)
    if (data == null) return 0n
    const s = data.beginParse()
    s.loadAddress()
    s.loadAddress()
    return s.loadCoins()
}

export async function jackpotWallet(env: Env): Promise<Address> {
    return env.hipo.walletAddress(env.jackpot.address)
}

// F·TC ≥ P·TT at the stored quote, F ≥ 0, and the Jackpot's real hGRAM wallet holds at least T.
export async function solvencyError(env: Env, wallet: Address): Promise<string | undefined> {
    const c = await counters(env)
    const F = c.T - c.I - c.O
    if (F < 0n) return `F < 0: T=${String(c.T)} I=${String(c.I)} O=${String(c.O)}`
    if (c.TT > 0n && F * c.TC < c.P * c.TT) {
        return `F·TC < P·TT: F=${String(F)} P=${String(c.P)} TC=${String(c.TC)} TT=${String(c.TT)}`
    }
    if (c.TT === 0n && c.P > 0n) return `P=${String(c.P)} with no quote`
    const real = await walletTokens(env.blockchain, wallet)
    if (real < c.T) return `wallet ${String(real)} < T ${String(c.T)}`
    return undefined
}

// ---- edits of Hipo's state ------------------------------------------------------------------------------

async function setData(blockchain: Blockchain, address: Address, data: Cell) {
    const contract = await blockchain.getContract(address)
    const account = contract.account
    const state = account.account!.storage.state
    if (state.type !== 'active') throw new Error('not active')
    state.state.data = data
    await blockchain.setShardAccount(address, account)
}

// Rewrites the Hipo treasury's participations. The rest of its data is written back as read.
export async function setParticipations(env: Env, rounds: [bigint, ParticipationState][]) {
    const config = await env.hipo.treasury.getTreasuryState()
    const current = (await dataOf(env.blockchain, env.hipo.treasury.address))!
    if (!treasuryConfigToCell(config).equals(current)) throw new Error('treasury data does not round-trip')
    for (const k of config.participations.keys()) config.participations.delete(k)
    for (const [roundSince, state] of rounds) config.participations.set(roundSince, { state })
    await setData(env.blockchain, env.hipo.treasury.address, treasuryConfigToCell(config))
}

// Rewrites the tokens of a deployed Hipo wallet.
export async function setWalletTokens(blockchain: Blockchain, wallet: Address, tokens: bigint) {
    const s = (await dataOf(blockchain, wallet))!.beginParse()
    const owner = s.loadAddress()
    const parent = s.loadAddress()
    s.loadCoins()
    const rest = s.loadMaybeRef()
    const unstaking = s.loadCoins()
    const data = beginCell()
        .storeAddress(owner)
        .storeAddress(parent)
        .storeCoins(tokens)
        .storeMaybeRef(rest)
        .storeCoins(unstaking)
        .endCell()
    await setData(blockchain, wallet, data)
}

// Makes the hGRAM wallet of `owner` refuse every receive_tokens (as a broken or frozen wallet would): its
// parent is rewritten to one that is not Hipo's, so its sender check fails. The wallet must exist (the
// sandbox emulator aborts on a wallet account made by hand). Returns a function that repairs it.
export async function breakWalletOf(env: Env, owner: Address): Promise<() => Promise<void>> {
    const wallet = await env.hipo.walletAddress(owner)
    if ((await env.blockchain.getContract(wallet)).accountState?.type !== 'active') {
        throw new Error('breakWalletOf: the wallet must exist; mint some hGRAM to its owner first')
    }
    await rewriteParent(env.blockchain, wallet, new Address(0, Buffer.alloc(32, 7)))
    return () => rewriteParent(env.blockchain, wallet, env.hipo.parent.address)
}

async function rewriteParent(blockchain: Blockchain, wallet: Address, parent: Address) {
    const s = (await dataOf(blockchain, wallet))!.beginParse()
    const owner = s.loadAddress()
    s.loadAddress()
    const tokens = s.loadCoins()
    const staking = s.loadMaybeRef()
    const unstaking = s.loadCoins()
    const data = beginCell()
        .storeAddress(owner)
        .storeAddress(parent)
        .storeCoins(tokens)
        .storeMaybeRef(staking)
        .storeCoins(unstaking)
        .endCell()
    await setData(blockchain, wallet, data)
}

// ---- message bodies -------------------------------------------------------------------------------------

export function hitBody(o: { draw: bigint; slot: number; j: number; r: bigint; start: bigint; owner: Address }) {
    return beginCell()
        .storeUint(JackpotOp.hit, 32)
        .storeUint(0, 64)
        .storeUint(o.draw, 32)
        .storeUint(o.slot, 8)
        .storeUint(o.j, 8)
        .storeUint(o.r, 128)
        .storeUint(o.start, 128)
        .storeAddress(o.owner)
        .endCell()
}

export function missBody(o: { draw: bigint; slot: number; j: number; r: bigint; start: bigint }) {
    return beginCell()
        .storeUint(JackpotOp.miss, 32)
        .storeUint(0, 64)
        .storeUint(o.draw, 32)
        .storeUint(o.slot, 8)
        .storeUint(o.j, 8)
        .storeUint(o.r, 128)
        .storeUint(o.start, 128)
        .endCell()
}

export function checkBody(o: { draw: bigint; slot: number; j: number; r: bigint; start: bigint }) {
    return beginCell()
        .storeUint(JackpotOp.check, 32)
        .storeUint(0, 64)
        .storeUint(o.draw, 32)
        .storeUint(o.slot, 8)
        .storeUint(o.j, 8)
        .storeUint(o.r, 128)
        .storeUint(o.start, 128)
        .endCell()
}

export function rangeSetupBody(owner: Address, length: bigint) {
    return beginCell()
        .storeUint(JackpotOp.rangeSetup, 32)
        .storeUint(0, 64)
        .storeAddress(owner)
        .storeCoins(length)
        .endCell()
}

export function withdrawnBody(x: bigint, start: bigint, owner: Address) {
    return beginCell()
        .storeUint(JackpotOp.withdrawn, 32)
        .storeUint(0, 64)
        .storeCoins(x)
        .storeUint(start, 128)
        .storeAddress(owner)
        .endCell()
}

export function gasExcessBody(queryId: bigint) {
    return beginCell().storeUint(JackpotOp.gasExcess, 32).storeUint(queryId, 64).endCell()
}

export function quoteBody(queryId: bigint, coins: bigint, tokens: bigint) {
    return beginCell()
        .storeUint(JackpotOp.takeCurrentQuote, 32)
        .storeUint(queryId, 64)
        .storeUint(coins, 128)
        .storeUint(tokens, 128)
        .storeMaybeRef(null)
        .endCell()
}

export function notificationBody(queryId: bigint, amount: bigint, sender: Address) {
    return beginCell()
        .storeUint(JackpotOp.transferNotification, 32)
        .storeUint(queryId, 64)
        .storeCoins(amount)
        .storeAddress(sender)
        .storeBit(false)
        .endCell()
}

// Hipo's deposit_coins, as anyone may send it to the treasury.
export function depositCoinsBody(queryId: bigint, owner: Address | null, coins: bigint) {
    return beginCell()
        .storeUint(JackpotOp.depositCoins, 32)
        .storeUint(queryId, 64)
        .storeAddress(owner)
        .storeCoins(coins)
        .storeCoins(0)
        .storeAddress(null)
        .endCell()
}

// Hipo's send_tokens, sent by the owner to its own wallet.
export function sendTokensBody(o: {
    queryId?: bigint
    amount: bigint
    recipient: Address
    returnExcess: Address | null
    forward?: bigint
}) {
    return beginCell()
        .storeUint(JackpotOp.sendTokens, 32)
        .storeUint(o.queryId ?? 0n, 64)
        .storeCoins(o.amount)
        .storeAddress(o.recipient)
        .storeAddress(o.returnExcess)
        .storeMaybeRef(null)
        .storeCoins(o.forward ?? 0n)
        .storeBit(false)
        .endCell()
}

export function submitBody(round: number, signature?: Buffer, witness?: Cell) {
    const sig = signature ?? Buffer.from(fixtureRound(round).signature, 'hex')
    return beginCell()
        .storeUint(JackpotOp.submitRandomness, 32)
        .storeUint(0, 64)
        .storeRef(beginCell().storeBuffer(sig).endCell())
        .storeRef(witness ?? buildWitness(round))
        .endCell()
}

export function opBody(op: number, ...uints: [bigint | number, number][]) {
    const b = beginCell().storeUint(op, 32).storeUint(0, 64)
    for (const [v, bits] of uints) b.storeUint(v, bits)
    return b.endCell()
}

// ---- the draw, off chain ---------------------------------------------------------------------------------

// r(i, j) = uint256(sha256(seed ‖ uint8 i ‖ uint8 j)) mod E
export function ticketOf(seed: bigint, slot: number, j: number, cutoff: bigint): bigint {
    const pre = Buffer.alloc(34)
    Buffer.from(seed.toString(16).padStart(64, '0'), 'hex').copy(pre, 0)
    pre[32] = slot
    pre[33] = j
    return BigInt('0x' + createHash('sha256').update(pre).digest('hex')) % cutoff
}

export function bookingsOfRun(run: { externals: LogMessage[] }): BookingLog[] {
    return logsOf<BookingLog>(run.externals, LogTopic.booking)
}

// The state of an account's data, as a hash: "no state change" means the same hash.
export async function dataHash(blockchain: Blockchain, address: Address): Promise<string> {
    return (await dataOf(blockchain, address))?.hash().toString('hex') ?? 'none'
}

// Every transaction of a run that failed in compute or action phase.
export function failed(txs: BlockchainTransaction[]): BlockchainTransaction[] {
    return txs.filter((tx) => {
        if (tx.description.type !== 'generic') return false
        const c = tx.description.computePhase
        return (c.type === 'vm' && !c.success) || tx.description.actionPhase?.success === false
    })
}

export type Player = SandboxContract<TreasuryContract>

// ---- a draw ready to resolve ------------------------------------------------------------------------------

// Books each (player, GRAM) deposit, opens the first period, starts a real draw waiting for drawRounds[0]
// and submits its randomness. The Jackpot is then resolving draw 1.
export async function drawReady(env: Env, deposits: [Player, bigint][]) {
    for (const [p, gram] of deposits) await depositGram(env, p, gram)
    await nextRound(env, toNano('30'))
    await startDraw(env)
    await nextRound(env, toNano('30'))
    await startDraw(env, roundTime(drawRounds[0]) - 60)
    await submitRound(env, drawRounds[0])
}

// The booking whose range holds ticket r, or undefined.
export function rangeOf(env: Env, r: bigint): BookingLog | undefined {
    return env.bookings.find((x) => x.start <= r && r < x.start + x.principal)
}
