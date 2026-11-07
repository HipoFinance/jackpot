/* eslint-disable -- a recording harness: it decodes bodies it has just made, and is run by `npm run graphs` only */
// The message-graph story (spec §13): one sandbox run of the amended Jackpot against Hipo's real contracts, in
// chapters. It records each chapter's transactions, names every address by its role, decodes each body by op name,
// builds the DOT of every graph (scripts/graphs/dot.ts) and compares it with docs/graphs/<graph>.dot: `npm test` fails on
// a difference and says to run `npm run graphs`. With UPDATE_GRAPHS=1 it writes docs/graphs/*.dot and
// docs/message-graphs.md instead. SKIP_GRAPHS=1 skips it (about a minute).
import { Address, Cell, Dictionary, beginCell, toNano } from '@ton/core'
import { BlockchainTransaction, createShardAccount } from '@ton/sandbox'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { op as hipoOps } from '../hipo/common'
import * as HW from '../hipo/Wallet'
import * as J from '../../wrappers/Jackpot'
import * as S from '../jackpot/setup'
import * as Sc from '../jackpot/scenario'
import { buildGraphs } from '../../scripts/graphs/dot'
import { buildMarkdown } from '../../scripts/graphs/markdown'

const ROOT = join(__dirname, '..', '..')
const mode = process.env.UPDATE_GRAPHS === '1' ? 'update' : process.env.SKIP_GRAPHS === '1' ? null : 'check'

const G = (n: number | string) => toNano(String(n))
const gram = (x: bigint) => (Number(x) / 1e9).toString()

// op names from Hipo's and the Jackpot's constants files; the Jackpot's win where a code is shared
const opNames = new Map<number, string>()
for (const [k, v] of Object.entries(hipoOps)) opNames.set(Number(v), k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase()))
for (const m of readFileSync(join(ROOT, 'contracts/imports/constants.fc'), 'utf8').matchAll(/const int op::(\w+) = (0x[0-9a-fA-F]+);/g))
    opNames.set(Number(m[2]), m[1])
opNames.set(0x178d4519, 'receive_tokens')
opNames.set(0xffffffff, 'bounced')
opNames.set(0xfffffffe, 'bounced')
const topicNames = new Map<number, string>(Object.entries(J.LogTopic).map(([k, v]) => [v as number, k]))
const reasonNames = new Map<number, string>(Object.entries(J.Reason).map(([k, v]) => [v as number, k]))

;(mode ? it : it.skip)('story', async () => {
    const sc = await Sc.fresh({ players: 0, minDeposit: G(10), minGap: 32768, burnBatch: G(5) })
    const { env } = sc
    const names = ['alice', 'bob', 'carol', 'dave', 'eve', 'frank']
    const mints: Record<string, number> = { alice: 110000, bob: 60000, carol: 40000, dave: 0, eve: 2000, frank: 0 }
    const P: any = {}
    for (const n of names) {
        P[n] = await env.blockchain.treasury(n)
        if (mints[n] > 0) await S.mintHgram(env, P[n], G(mints[n]))
    }

    // roles: every address is named by what it is
    const roles = new Map<string, string>()
    const role = (a: Address | null | undefined | any) =>
        a == null ? 'none' : (roles.get(a.toString()) ?? '?' + (a.hash ? a.hash.toString('hex').slice(0, 6) : String(a)))
    const ad = await env.jackpot.getAddresses()
    for (const n of names) {
        roles.set(P[n].address.toString(), n)
        roles.set((await env.hipo.walletAddress(P[n].address)).toString(), n + 'Hgram')
        roles.set(S.walletAt(env, P[n].address).address.toString(), n + 'Jgram')
    }
    roles.set(env.jackpot.address.toString(), 'jackpot')
    roles.set(ad.wallet.toString(), 'jackpotHgram')
    roles.set(env.hipo.treasury.address.toString(), 'treasury')
    roles.set(env.hipo.parent.address.toString(), 'parent')
    roles.set(env.burner.address.toString(), 'burner')
    roles.set((await env.hipo.walletAddress(env.burner.address)).toString(), 'burnerHgram')
    roles.set(env.keeper.address.toString(), 'keeper')
    roles.set(env.governor.address.toString(), 'governor')
    roles.set(env.hipo.governor.address.toString(), 'hipoGovernor')
    for (let l = 1; l <= 4; l++) roles.set(S.nodeAt(env, l, 0n).address.toString(), 'node' + l)

    const either = (s: any): Cell | null => {
        if (s.remainingBits < 1) return null
        if (s.loadBit()) return s.remainingRefs > 0 ? s.loadRef() : null
        return s.remainingBits > 0 || s.remainingRefs > 0 ? beginCell().storeSlice(s).endCell() : null
    }
    const payloadText = (c: Cell | null): string | undefined => {
        if (c == null) return undefined
        const s = c.beginParse()
        if (s.remainingBits < 32) return 'payload'
        const op = s.loadUint(32)
        if (op === 0) return `comment "${s.loadStringTail()}"`
        if (op === J.JackpotOp.depositRefused) {
            const r = s.loadUint(8)
            return `deposit_refused, reason ${r} (${reasonNames.get(r)})`
        }
        if (op === J.JackpotOp.depositOptions) return 'deposit_options'
        if (op === J.JackpotOp.withdrawOptions) return 'withdraw_options'
        return 'payload 0x' + op.toString(16)
    }
    const decode = (body: Cell, name: string): Record<string, string> => {
        const s = body.beginParse()
        const o: Record<string, string> = {}
        try {
            s.skip(32)
            if (name === 'comment') {
                o.text = s.loadStringTail()
                return o
            }
            if (name === 'bounced') return o
            o.query_id = s.loadUintBig(64).toString()
            switch (name) {
                case 'prepare_deposit': {
                    const c = s.loadRef().beginParse()
                    c.loadUintBig(64)
                    o.tokens = gram(c.loadCoins())
                    const has = c.loadBit()
                    o.options = String(has)
                    if (has) o.min_principal = gram(c.loadCoins())
                    o.fwd = gram(c.loadCoins())
                    const p = c.loadMaybeRef()
                    if (p) o.payload = payloadText(p) ?? ''
                    const parties = c.loadRef().beginParse()
                    o.owner = role(parties.loadAddress())
                    o.depositor = role(parties.loadAddress())
                    o.response = role(parties.loadAddress())
                    break
                }
                case 'deposit_ready':
                    o.busy = String(s.loadBit())
                    o.b = s.loadBit() ? s.loadUintBig(32).toString() : 'none'
                    break
                case 'deposit_booked':
                    o.c = gram(s.loadCoins())
                    o.b = s.loadUintBig(32).toString()
                    break
                case 'burn':
                    o.amount = gram(s.loadCoins())
                    o.response = role(s.loadMaybeAddress())
                    {
                        const opt = s.loadMaybeRef()
                        if (opt) {
                            const q = opt.beginParse()
                            q.skip(32)
                            o.to_successor = String(q.loadBit())
                            o.fwd = gram(q.loadCoins())
                            const p = q.loadMaybeRef()
                            if (p) o.payload = payloadText(p) ?? ''
                        }
                    }
                    break
                case 'unstake_tokens':
                    o.amount = gram(s.loadCoins())
                    break
                case 'burn_notification':
                    o.x = gram(s.loadCoins())
                    o.owner = role(s.loadAddress())
                    o.response = role(s.loadMaybeAddress())
                    o.last = String(s.loadBit())
                    o.b = s.loadUintBig(32).toString()
                    {
                        const opt = s.loadMaybeRef()
                        if (opt) {
                            const q = opt.beginParse()
                            q.skip(32)
                            o.to_successor = String(q.loadBit())
                            o.fwd = gram(q.loadCoins())
                            const p = q.loadMaybeRef()
                            if (p) o.payload = payloadText(p) ?? ''
                        }
                    }
                    break
                case 'update':
                    o.tag = s.loadUintBig(32).toString()
                    o.b = s.loadUintBig(32).toString()
                    o.delta = gram(s.loadIntBig(128))
                    break
                case 'descend':
                    o.tag = s.loadUintBig(32).toString()
                    o.slot = String(s.loadUint(8))
                    o.attempt = String(s.loadUint(8))
                    o.k = s.loadUintBig(128).toString()
                    break
                case 'hit':
                case 'miss':
                    o.tag = s.loadUintBig(32).toString()
                    o.slot = String(s.loadUint(8))
                    o.attempt = String(s.loadUint(8))
                    o.k = s.loadUintBig(128).toString()
                    o.b = s.loadUintBig(32).toString()
                    break
                case 'close_node':
                    o.next_position = s.loadUintBig(32).toString()
                    break
                case 'take_current_quote':
                    o.TC = s.loadUintBig(128).toString()
                    o.TT = s.loadUintBig(128).toString()
                    break
                case 'send_tokens':
                    o.amount = gram(s.loadCoins())
                    o.recipient = role(s.loadAddress())
                    o.return_excess = role(s.loadMaybeAddress())
                    s.loadMaybeRef()
                    o.fwd = gram(s.loadCoins())
                    {
                        const t = payloadText(either(s))
                        if (t) o.payload = t
                    }
                    break
                case 'receive_tokens':
                    o.amount = gram(s.loadCoins())
                    o.sender = role(s.loadAddress())
                    o.return_excess = role(s.loadMaybeAddress())
                    o.fwd = gram(s.loadCoins())
                    break
                case 'transfer_notification':
                    o.amount = gram(s.loadCoins())
                    o.sender = role(s.loadMaybeAddress())
                    {
                        const t = payloadText(either(s))
                        if (t) o.payload = t
                    }
                    break
                case 'withdrawal_notification':
                    o.amount = gram(s.loadCoins())
                    o.coins = gram(s.loadCoins())
                    break
                case 'withdraw_for':
                    o.to_successor = String(s.loadBit())
                    break
                case 'set_successor':
                    o.successor = role(s.loadMaybeAddress())
                    o.fee = gram(s.loadCoins())
                    break
            }
        } catch {
            /* a short body: what was read stays */
        }
        return o
    }
    const logsOf = (tx: BlockchainTransaction) =>
        tx.externals.map((m: any) => {
            const p = J.parseLog(m)
            if (!p) return { topic: '?' }
            const out: any = { topic: topicNames.get(p.topic) ?? String(p.topic) }
            for (const [k, v] of Object.entries(p.log as any))
                out[k] =
                    typeof v === 'bigint'
                        ? v.toString()
                        : v == null
                          ? null
                          : Array.isArray(v)
                            ? v.map(String)
                            : typeof v === 'object'
                              ? role(v)
                              : v
            return out
        })

    const chapters: any[] = []
    let next: any = null // the successor's env, once deployed
    const stateNow = async () => {
        const s = await env.jackpot.getJackpotState()
        const d = await env.jackpot.getDrawState()
        const b = await env.jackpot.getBoundary()
        const need = s.quoteCoins > 0n ? (s.principal * s.quoteTokens + s.quoteCoins - 1n) / s.quoteCoins : 0n
        const free = s.heldTokens - s.incomingTokens - s.reservedTokens
        const pot = free - need > 0n ? free - need : 0n
        const out: any = {
            held: s.heldTokens, incoming: s.incomingTokens, reserved: s.reservedTokens, free, unstaking: s.unstakingTokens,
            principal: s.principal, tickets: s.tickets, next_position: s.nextPosition, tag: s.tag, burn_owed: s.burnOwed,
            carried: s.carried, quote_coins: s.quoteCoins, quote_tokens: s.quoteTokens, pot,
            float: await S.balanceOf(env, env.jackpot.address),
            state: ['none', 'waiting', 'resolving'][d.state], snapshot_tickets: d.snapshotTickets,
            last_boundary: b.lastBoundary, now: env.blockchain.now,
            retired: (await env.jackpot.getRetirement()).retired,
        }
        const r: any = {}
        for (const k of Object.keys(out)) r[k] = typeof out[k] === 'bigint' ? out[k].toString() : out[k]
        for (const n of names) {
            r[n + '_hgram'] = (await S.hgramOf(env, P[n].address)).toString()
            r[n + '_jgram'] = (await S.jgramOf(env, P[n].address)).toString()
            if (next) r[n + '_jgram2'] = (await S.jgramOf(next, P[n].address)).toString()
        }
        r.burner_hgram = (await S.hgramOf(env, env.burner.address)).toString()
        const nodes: string[] = []
        for (let l = 1; l <= 4; l++)
            nodes.push((await env.blockchain.getContract(S.nodeAt(env, l, 0n).address)).accountState?.type ?? 'none')
        r.nodes = nodes
        return r
    }
    const record = async (id: string, segs: BlockchainTransaction[][]) => {
        const all = segs.flat()
        const idx = new Map<BlockchainTransaction, number>()
        all.forEach((t, i) => idx.set(t, i))
        const txs = all.map((tx, i) => {
            const m: any = tx.inMessage
            const info = m?.info
            const d: any = tx.description
            let op: number | null = null
            if (m?.body && m.body.beginParse().remainingBits >= 32) op = m.body.beginParse().loadUint(32)
            const to = role(info?.dest)
            let name = op == null ? 'plain transfer' : op === 0 ? 'comment' : (opNames.get(op) ?? '0x' + op.toString(16))
            if (op === 0x595f07bc) name = to.endsWith('Hgram') ? 'unstake_tokens' : 'burn'
            if (info?.type === 'internal' && info.bounced) name = 'bounced'
            return {
                i,
                parent: tx.parent ? (idx.get(tx.parent) ?? null) : null,
                from: info?.type === 'internal' ? role(info.src) : 'external',
                to,
                op: name,
                ...(m?.body && op != null ? { fields: decode(m.body, name) } : {}),
                valueGram: info?.type === 'internal' ? gram(info.value.coins) : '0',
                bounced: info?.type === 'internal' ? !!info.bounced : false,
                bounceable: info?.type === 'internal' ? !!info.bounce : false,
                deploy: tx.oldStatus !== 'active' && tx.endStatus === 'active',
                destroyed: tx.oldStatus === 'active' && tx.endStatus !== 'active',
                exit: d.computePhase?.type === 'vm' ? d.computePhase.exitCode : 'skipped',
                actionResult: d.actionPhase ? d.actionPhase.resultCode : null,
                logs: logsOf(tx),
            }
        })
        chapters.push({ id, txs, after: await stateNow() })
        console.log(
            id,
            txs.length,
            'tx',
            txs.filter((t) => (t.exit !== 0 && t.exit !== 1 && t.exit !== 'skipped') || (t.actionResult != null && t.actionResult !== 0)).map((t) => `${t.to}:${t.op}:${t.exit}/${t.actionResult}`).join(' '),
        )
    }
    const reward = async (frac: number) => {
        const [tc] = await env.hipo.quote()
        const coins = BigInt(Math.floor(Number(tc) * frac))
        return env.hipo.treasury.sendGiftCoins(env.hipo.governor.getSender(), { value: coins + G(1), coins })
    }

    // 1. deposits
    Sc.setNow(env, Sc.A0 + 600)
    await record('alice-1', [(await S.depositHgram(env, P.alice, G(100000))).result.transactions])
    Sc.setNow(env, Sc.A0 + 900)
    await record('bob-1', [(await S.depositHgram(env, P.bob, G(50000))).result.transactions])

    // 2a. a reward lands, a poke stores the rate: not a boundary, min_gap has not passed
    Sc.setNow(env, Sc.A0 + 7200)
    await record('reward-1', [(await reward(0.00031)).transactions])
    Sc.setNow(env, Sc.A0 + 7400)
    await record('poke-early', [(await S.poke(env)).transactions])

    // 1b. Carol deposits for Dave, with options: beneficiary, a payload for him, and min_principal
    Sc.setNow(env, Sc.A0 + 8000)
    {
        const [qc, qt] = await env.jackpot.getQuote()
        const t = G(30000)
        const v = (t * qc) / qt
        const minPrincipal = v - v / 200n // accepts a price of up to 0.5%
        const fwd = G(0.01)
        const opts = { minPrincipal, beneficiary: P.dave.address, forwardTonAmount: fwd, forwardPayload: J.textComment('A gift from Carol') }
        const forward = env.fees.deposit + fwd + env.fees.payload
        const r = await S.depositHgram(env, P.carol, t, { options: opts, forward, queryId: 4242n })
        await record('carol-gift', [r.result.transactions])
    }
    // 1c. Eve: a price limit nobody can meet; she asked for a forward amount, so the refund carries the reason
    Sc.setNow(env, Sc.A0 + 8300)
    {
        const fwd = G(0.01)
        const opts = { minPrincipal: G(999999), forwardTonAmount: fwd }
        const r = await S.depositHgram(env, P.eve, G(1000), { options: opts, forward: env.fees.deposit + fwd })
        await record('eve-refused', [r.result.transactions])
    }

    // 2b. the next reward, after min_gap: the poke that is a boundary. The float is set low by hand first, so the
    // boundary also unstakes.
    const b0 = await env.jackpot.getBoundary()
    Sc.setNow(env, b0.lastBoundary + b0.minGap + 300)
    await record('reward-2', [(await reward(0.00031)).transactions])
    Sc.setNow(env, b0.lastBoundary + b0.minGap + 420)
    await Sc.setBalance(env, env.jackpot.address, G(7.5))
    await record('boundary', [(await S.poke(env)).transactions])

    // 3. the draw: 90 s later drand has published R, the keeper submits
    Sc.setNow(env, (env.blockchain.now as number) + 90)
    await record('draw', [(await Sc.submitDraw(env)).transactions])

    // 4. withdrawals: Bob burns part, with options; Alice sends `w`
    Sc.setNow(env, (env.blockchain.now as number) + 600)
    {
        const fwd = G(0.02)
        const r = await S.walletAt(env, P.bob.address).sendBurn(P.bob.getSender(), {
            value: env.fees.withdraw + fwd + env.fees.payload,
            amount: G(20000),
            queryId: 777n,
            options: J.withdrawOptions({ forwardTonAmount: fwd, forwardPayload: J.textComment('Savings app: order 17') }),
        })
        await record('bob-burn', [r.transactions])
    }
    Sc.setNow(env, (env.blockchain.now as number) + 600)
    await record('alice-w', [(await env.jackpot.sendComment(P.alice.getSender(), { value: env.fees.commentWithdraw, text: 'w' })).transactions])

    // 5. refill: a reward and a poke (not a boundary) give a pot at the stored rate; the float is set below the draw
    // budget by hand; anyone refills
    Sc.setNow(env, (env.blockchain.now as number) + 3600)
    await reward(0.00031)
    await S.poke(env)
    await Sc.setBalance(env, env.jackpot.address, G(3.5))
    Sc.setNow(env, (env.blockchain.now as number) + 60)
    await record('refill', [(await env.jackpot.sendRefill(P.frank.getSender(), { value: env.fees.refill })).transactions])

    // 6. a foreign jetton: Hipo's wallet code under another minter, so a real TEP-74 wallet of a different jetton
    {
        const minter = await env.blockchain.treasury('xyz-minter')
        const [, , , , walletCode] = await env.hipo.parent.getJettonData()
        const mk = (owner: Address, tokens: bigint) =>
            HW.Wallet.createFromConfig({ owner, parent: minter.address, tokens, staking: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.BigVarUint(4)), unstaking: 0n }, walletCode)
        // the address follows from the wallet's init data with 0 tokens; the stored data then holds Frank's 25
        const fw = mk(P.frank.address, 0n)
        const jw = mk(env.jackpot.address, 0n)
        roles.set(fw.address.toString(), 'frankXyz')
        roles.set(jw.address.toString(), 'jackpotXyz')
        roles.set(minter.address.toString(), 'xyzMinter')
        await env.blockchain.setShardAccount(
            fw.address,
            createShardAccount({ workchain: 0, address: fw.address, code: walletCode, data: mk(P.frank.address, G(25)).init!.data, balance: G(0.1) }),
        )
        const w = env.blockchain.openContract(HW.Wallet.createFromAddress(fw.address))
        Sc.setNow(env, (env.blockchain.now as number) + 60)
        const r = await w.sendSendTokens(P.frank.getSender(), {
            value: G(0.3),
            tokens: G(25),
            recipient: env.jackpot.address,
            returnExcess: P.frank.address,
            forwardTonAmount: G(0.15),
        })
        await record('foreign', [r.transactions])
    }

    // 7. the end: retire and a successor
    Sc.setNow(env, (env.blockchain.now as number) + 3600)
    const retireTxs = (await env.jackpot.sendRetire(env.governor.getSender(), { value: G(0.05) })).transactions
    next = await S.deploySecondJackpot(env, env.blockchain.now as number)
    roles.set(next.jackpot.address.toString(), 'successor')
    roles.set((await next.jackpot.getAddresses()).wallet.toString(), 'successorHgram')
    for (const n of names) roles.set(S.walletAt(next, P[n].address).address.toString(), n + 'Jgram2')
    for (let l = 1; l <= 4; l++) roles.set(S.nodeAt(next, l, 0n).address.toString(), 'snode' + l)
    const fee = next.fees.deposit + next.fees.return + next.fees.payload
    const setTxs = (await env.jackpot.sendSetSuccessor(env.governor.getSender(), { value: G(0.05), successor: next.jackpot.address, depositFee: fee })).transactions
    await record('retire', [retireTxs, setTxs])

    Sc.setNow(env, (env.blockchain.now as number) + 600)
    {
        const value = (await env.jackpot.getFeeParts()).wValue + G(0.1)
        const r = await env.jackpot.sendWithdrawFor(env.governor.getSender(), { value, toSuccessor: false, owners: [P.bob.address] })
        await record('withdraw-for', [r.transactions])
    }
    Sc.setNow(env, (env.blockchain.now as number) + 60)
    {
        const value = (await env.jackpot.getFeeParts()).wValue + fee + G(0.1)
        const r = await env.jackpot.sendWithdrawFor(env.governor.getSender(), { value, toSuccessor: true, owners: [P.dave.address] })
        await record('move', [r.transactions])
    }
    Sc.setNow(env, (env.blockchain.now as number) + 600)
    {
        const r = await env.jackpot.sendSweep(env.governor.getSender(), { value: await S.sweepValue(env) })
        await record('sweep', [r.transactions])
    }

    // the graphs, and the page
    const graphs = buildGraphs(chapters)
    const dir = join(ROOT, 'docs', 'graphs')
    const files = new Map<string, string>()
    for (const list of graphs.values()) for (const g of list) files.set(g.name + '.dot', g.dot)
    if (mode === 'update') {
        mkdirSync(dir, { recursive: true })
        for (const f of readdirSync(dir)) if (/\.(dot|svg)$/.test(f)) unlinkSync(join(dir, f))
        for (const [f, dot] of files) writeFileSync(join(dir, f), dot)
        writeFileSync(join(ROOT, 'docs', 'message-graphs.md'), buildMarkdown(chapters, graphs))
    } else {
        const differ: string[] = []
        for (const [f, dot] of files) if (!existsSync(join(dir, f)) || readFileSync(join(dir, f), 'utf8') !== dot) differ.push(f)
        const stale = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.dot') && !files.has(f)) : []
        if (differ.length > 0 || stale.length > 0) {
            throw new Error(`docs/graphs differs from the story (${[...differ, ...stale].join(', ')}): run npm run graphs`)
        }
    }
}, 900000)
