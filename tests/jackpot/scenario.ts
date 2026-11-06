/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests read state they just made */
// Building blocks for tests/Acceptance.spec.ts and friends: a Jackpot on the test build with a few funded
// players, a schedule the tests can step through, and a way to stop a chain half way and deliver its held
// messages later, in either order.
import { BlockchainTransaction, SandboxContract, TreasuryContract } from '@ton/sandbox'
import { Address, beginCell, Cell, Message, toNano } from '@ton/core'
import { DrawState, JackpotOp } from '../../wrappers/Jackpot'
import { Env, hgramOf, makeBoundary, messageFrom, mintHgram, setupJackpot, submitTest, walletAt } from './setup'

export const A0 = 1_800_000_000

export interface Scene {
    fake?: SandboxContract<TreasuryContract>
    env: Env
    players: SandboxContract<TreasuryContract>[]
    minGap: number
}

export async function fresh(
    opts: {
        minDeposit?: bigint
        float?: bigint
        minGap?: number
        riseMin?: number
        mint?: bigint
        players?: number
        burnBatch?: bigint
        // a stand-in for the treasury: the test answers the quote requests by hand (scene.fake)
        fake?: boolean
        failReady?: boolean
        nodeCode?: Cell
    } = {},
): Promise<Scene> {
    const minGap = opts.minGap ?? 3600
    const env = await setupJackpot({
        testBuild: opts.failReady ? 'failReady' : true,
        time: A0,
        float: opts.float,
        fakeTreasury: opts.fake,
        nodeCode: opts.nodeCode,
        config: {
            minGap,
            riseMin: opts.riseMin,
            minDeposit: opts.minDeposit ?? toNano('1'),
            burnBatch: opts.burnBatch,
        },
    })
    const players: SandboxContract<TreasuryContract>[] = []
    for (let i = 0; i < (opts.players ?? 4); i++) {
        const p = await env.blockchain.treasury(`player${i.toString()}`)
        await mintHgram(env, p, opts.mint ?? toNano('2000'))
        players.push(p)
    }
    return { env, players, minGap, fake: env.fakeTreasury }
}

// A deposit of `tokens` hGRAM that accepts any price.
export async function put(
    env: Env,
    p: SandboxContract<TreasuryContract>,
    tokens: bigint,
    minC: bigint | undefined = 0n,
) {
    const { depositHgram } = await import('./setup')
    return depositHgram(env, p, tokens, { minC })
}

export function setNow(env: Env, t: number) {
    env.blockchain.now = t
}

// A boundary: min_gap after the last one, a reward of `gram` (enough for rise_min by default), a poke.
export async function toBoundary(env: Env, gram?: bigint) {
    return makeBoundary(env, { gram })
}

// Submits the open draw's round; `variant` changes the seed without changing the round.
export async function submitDraw(env: Env, variant = 0) {
    const d = await env.jackpot.getDrawState()
    return submitTest(env, Number(d.round), undefined, variant)
}

// The pot as the Jackpot computes it at the treasury's rate: free hGRAM above what covers the principal.
export async function potNow(env: Env) {
    const s = await env.jackpot.getJackpotState()
    const [tc, tt] = await env.hipo.quote()
    const need = (s.principal * tt + tc - 1n) / tc
    const pot = s.heldTokens - s.incomingTokens - s.reservedTokens - need
    return { pot: pot < 0n ? 0n : pot, tc, tt, state: s }
}

export async function drawState(env: Env) {
    return (await env.jackpot.getDrawState()).state
}

export { DrawState, JackpotOp }

type Out = Message

// Runs the chain started by `message` up to and including the first transaction `stop` accepts, drops the
// rest of the chain, and returns the messages that transaction sent. The sandbox keeps what is queued, so
// the queue is emptied: that is what makes the chain stop here.
export async function holdUntil(
    env: Env,
    message: Message,
    stop: (tx: BlockchainTransaction) => boolean,
): Promise<Out[]> {
    const iter = await env.blockchain.sendMessageIter(message)
    for await (const tx of iter) {
        if (stop(tx)) {
            const queue = (env.blockchain as unknown as { defaultQueueManager: { messageQueue: unknown[] } })
                .defaultQueueManager.messageQueue
            queue.length = 0
            return [...tx.outMessages.values()].filter((m) => m.info.type === 'internal')
        }
    }
    throw new Error('the chain ended before the stop')
}

export function transferBody(env: Env, from: Address, tokens: bigint, forward: bigint, payload?: Cell): Cell {
    return beginCell()
        .storeUint(JackpotOp.sendTokens, 32)
        .storeUint(0, 64)
        .storeCoins(tokens)
        .storeAddress(env.jackpot.address)
        .storeAddress(from)
        .storeMaybeRef(null)
        .storeCoins(forward)
        .storeSlice(payload ? payload.beginParse() : beginCell().storeUint(0, 1).endCell().beginParse())
        .endCell()
}

// Starts a deposit of `tokens` and holds it after the transaction `stop` accepts.
export async function startDeposit(
    env: Env,
    p: SandboxContract<TreasuryContract>,
    tokens: bigint,
    stop: (tx: BlockchainTransaction) => boolean,
    payload?: Cell,
) {
    const w = await env.hipo.walletOf(p.address)
    const msg = messageFrom(
        p.address,
        w.address,
        env.fees.deposit + toNano('0.1'),
        transferBody(env, p.address, tokens, env.fees.deposit, payload),
    )
    return holdUntil(env, msg, stop)
}

export const toAddr = (a: Address) => (tx: BlockchainTransaction) =>
    tx.inMessage?.info.dest?.toString() === a.toString()

export function jackpotWalletTx(env: Env, p: SandboxContract<TreasuryContract>) {
    return toAddr(walletAt(env, p.address).address)
}

// Delivers a held message as it was sent, with the chain it starts.
export async function deliver(env: Env, m: Message) {
    return env.blockchain.sendMessage(m)
}

export async function held(env: Env, p: SandboxContract<TreasuryContract>) {
    return hgramOf(env, p.address)
}

// The stand-in treasury answers a poke at the rate tc : tt, echoing the context it was sent. `ctx` is the
// custom_payload of the provide_current_quote the Jackpot sent (see pokeFake).
export async function answer(sc: Scene, ctx: Cell | null, tc: bigint, tt: bigint, value = toNano('0.5')) {
    const body = beginCell()
        .storeUint(JackpotOp.takeCurrentQuote, 32)
        .storeUint(0, 64)
        .storeUint(tc, 128)
        .storeUint(tt, 128)
        .storeMaybeRef(ctx)
        .endCell()
    return sc.fake!.send({ to: sc.env.jackpot.address, value, body })
}

// A poke, held at the Jackpot's request to the (stand-in) treasury: returns the request's context.
export async function pokeHeld(sc: Scene, value?: bigint): Promise<Cell> {
    const out = await holdUntil(
        sc.env,
        messageFrom(sc.env.keeper.address, sc.env.jackpot.address, value ?? sc.env.fees.poke, beginCell().storeUint(JackpotOp.poke, 32).storeUint(0, 64).endCell()),
        toAddr(sc.env.jackpot.address),
    )
    const req = out.find((m) => m.info.dest?.toString() === sc.fake!.address.toString())!
    const s = req.body.beginParse()
    s.skip(32 + 64)
    s.loadBit()
    return s.loadRef()
}

// A poke at the stand-in treasury's rate tc : tt, answered at once.
export async function pokeFake(sc: Scene, tc: bigint, tt: bigint) {
    const ctx = await pokeHeld(sc)
    return answer(sc, ctx, tc, tt)
}

// Sets n_b (the next position) in the stored data, to reach far positions and the capacity without 16 million
// deposits. Only the Jackpot's data changes; the code then runs unchanged.
export async function setNextPosition(env: Env, n: bigint) {
    const c = await env.blockchain.getContract(env.jackpot.address)
    const acc = c.account
    const state = acc.account!.storage.state
    if (state.type !== 'active') throw new Error('not active')
    const s = state.state.data!.beginParse()
    const bits = s.loadBits(s.remainingBits)
    const refs = [s.loadRef(), s.loadRef(), s.loadRef(), s.loadRef()]
    const e = refs[0].beginParse()
    const burnOwed = e.loadCoins()
    const carried = e.loadCoins()
    const unstaking = e.loadCoins()
    e.loadUint(32)
    const tag = e.loadUint(32)
    const rest = [e.loadRef(), e.loadRef(), e.loadRef()]
    refs[0] = beginCell()
        .storeCoins(burnOwed)
        .storeCoins(carried)
        .storeCoins(unstaking)
        .storeUint(n, 32)
        .storeUint(tag, 32)
        .storeRef(rest[0])
        .storeRef(rest[1])
        .storeRef(rest[2])
        .endCell()
    const nb = beginCell().storeBits(bits)
    for (const r of refs) nb.storeRef(r)
    state.state.data = nb.endCell()
    await env.blockchain.setShardAccount(env.jackpot.address, acc)
}

// The keeper's submit for the open draw's round, as a message (for tests that hold the chain).
export async function submitMessage(env: Env, variant = 0, value?: bigint) {
    const d = await env.jackpot.getDrawState()
    const { testSignatureCell } = await import('./testbuild')
    return messageFrom(
        env.keeper.address,
        env.jackpot.address,
        value ?? env.fees.submit,
        beginCell()
            .storeUint(JackpotOp.submitRandomness, 32)
            .storeUint(0, 64)
            .storeRef(testSignatureCell(Number(d.round), variant))
            .storeRef(beginCell().endCell())
            .endCell(),
    )
}

export const atJackpot = (env: Env, op: number) => (tx: BlockchainTransaction) => {
    if (tx.inMessage?.info.dest?.toString() !== env.jackpot.address.toString()) return false
    const b = tx.inMessage.body.beginParse()
    return b.remainingBits >= 32 && b.loadUint(32) === op
}

// A message whose body is `parts`, sent as `from` to the Jackpot, delivered; returns the chain.
export async function forge(env: Env, from: Address, body: Cell, value = toNano('0.5'), to?: Address) {
    return deliver(env, messageFrom(from, to ?? env.jackpot.address, value, body, false))
}

// Sets an account's balance in the sandbox (code and data stay), for tests about a nearly empty float.
export async function setBalance(env: Env, address: Address, balance: bigint) {
    const c = await env.blockchain.getContract(address)
    const acc = c.account
    await env.blockchain.setShardAccount(address, {
        ...acc,
        account: { ...acc.account!, storage: { ...acc.account!.storage, balance: { coins: balance } } },
    })
}

// Sets unstaking_tokens in the stored data, for tests about a stuck unstake. Only the Jackpot's data changes.
export async function setUnstaking(env: Env, amount: bigint) {
    const c = await env.blockchain.getContract(env.jackpot.address)
    const acc = c.account
    const state = acc.account!.storage.state
    if (state.type !== 'active') throw new Error('not active')
    const s = state.state.data!.beginParse()
    const bits = s.loadBits(s.remainingBits)
    const refs = [s.loadRef(), s.loadRef(), s.loadRef(), s.loadRef()]
    const e = refs[0].beginParse()
    const burnOwed = e.loadCoins()
    const carried = e.loadCoins()
    e.loadCoins()
    const rest = e.loadBits(e.remainingBits)
    const tail = [e.loadRef(), e.loadRef(), e.loadRef()]
    refs[0] = beginCell()
        .storeCoins(burnOwed)
        .storeCoins(carried)
        .storeCoins(amount)
        .storeBits(rest)
        .storeRef(tail[0])
        .storeRef(tail[1])
        .storeRef(tail[2])
        .endCell()
    const nb = beginCell().storeBits(bits)
    for (const r of refs) nb.storeRef(r)
    state.state.data = nb.endCell()
    await env.blockchain.setShardAccount(env.jackpot.address, acc)
}

// Deploys every node over the positions below n by a forged update from its parent (a sum of 0), with its balance set
// to the storage reserve and nothing spare, and sets the Jackpot's next_position to n. Returns the nodes.
export async function buildTree(env: Env, n: number, reserve = toNano('0.15')) {
    const { nodeAt } = await import('./setup')
    await setNextPosition(env, BigInt(n))
    const span = [64, 4096, 262144, 16777216]
    const list: { level: number; index: number }[] = []
    for (let level = 1; level <= 4; level++) {
        for (let i = 0; i < Math.ceil(n / span[level - 1]); i++) list.push({ level, index: i })
    }
    for (const { level, index } of list) {
        const node = nodeAt(env, level, BigInt(index))
        const parent = level === 4 ? env.jackpot.address : nodeAt(env, level + 1, BigInt(index >> 6)).address
        const body = beginCell()
            .storeUint(JackpotOp.update, 32)
            .storeUint(0, 64)
            .storeUint(0, 32)
            .storeUint(BigInt(index) << BigInt(6 * level), 32)
            .storeInt(0, 128)
            .storeBit(false)
            .endCell()
        await env.blockchain.sendMessage({
            ...messageFrom(parent, node.address, toNano('1'), body, false),
            init: node.init,
        })
        await setBalance(env, node.address, reserve)
    }
    return list
}
