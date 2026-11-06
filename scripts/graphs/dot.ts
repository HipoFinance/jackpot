// Turns a chapter of the story into DOT, without theme. Labels carry the op and its token and principal amounts,
// rounded to 0.001, and nothing that moves with gas: no GRAM values, no query_id, no lt, no unstake amount.
import { TraceChapter, TraceTx } from './types'

export function n(x: string | number, p = 3): string {
    const s = Number(x).toLocaleString('en-US', { minimumFractionDigits: p, maximumFractionDigits: p })
    return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

export function nano(x: string | bigint | number, p = 3): string {
    return n(Number(x) / 1e9, p)
}

export function rate(qc: string, qt: string): string {
    return (Number(qc) / Number(qt)).toFixed(6)
}

const NAMES: Record<string, string> = {
    jackpot: 'Jackpot',
    jackpotHgram: "Jackpot's\\nhGRAM wallet",
    treasury: 'Hipo treasury',
    parent: 'Hipo parent',
    burner: 'HPO burner',
    burnerHgram: "HPO burner's\\nhGRAM wallet",
    keeper: 'keeper',
    governor: 'governor',
    successor: 'new Jackpot\\n(successor)',
    successorHgram: "new Jackpot's\\nhGRAM wallet",
    frankXyz: "Frank's XYZ\\njetton wallet",
    jackpotXyz: "Jackpot's XYZ\\njetton wallet",
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function label(a: string): string {
    if (a in NAMES) return NAMES[a]
    let m = /^node(\d)$/.exec(a)
    if (m) return `node level ${m[1]}`
    m = /^snode(\d)$/.exec(a)
    if (m) return `new Jackpot\\nnode level ${m[1]}`
    m = /^(.+?)Jgram2$/.exec(a)
    if (m) return `${cap(m[1])}'s jGRAM wallet\\nin the new Jackpot`
    m = /^(.+?)(Hgram|Jgram)$/.exec(a)
    if (m) return `${cap(m[1])}'s\\n${m[2] === 'Hgram' ? 'hGRAM' : 'jGRAM'} wallet`
    return cap(a)
}

export function kind(a: string): string {
    if (a === 'jackpot' || a === 'successor') return 'n-jackpot'
    if (a.endsWith('Xyz')) return 'n-foreign'
    if (a.endsWith('Jgram') || a.endsWith('Jgram2')) return 'n-jgram'
    if (a.endsWith('Hgram')) return 'n-hgram'
    if (a.startsWith('node') || a.startsWith('snode')) return 'n-node'
    if (a === 'treasury' || a === 'parent' || a === 'burner') return 'n-hipo'
    return 'n-person'
}

const whoLabel = (a: string) => label(a).replace(/\\n/g, ' ')

function tokensOf(txs: TraceTx[], t: TraceTx): string | null {
    let p: TraceTx | undefined = t
    for (let seen = 0; p != null && seen < 12; seen++) {
        const f = p.fields
        if (f?.amount != null) return f.amount
        const parent: number | null = p.parent
        p = txs.find((x) => x.i === parent)
    }
    return null
}

export const failed = (t: TraceTx) =>
    t.bounced || (t.exit !== 0 && t.exit !== 1 && t.exit !== 'skipped') || (t.actionResult != null && t.actionResult !== 0)

// Which owner holds each position, from the booking logs of the whole story
export function positionOwners(chapters: TraceChapter[]): Map<string, string> {
    const pos = new Map<string, string>()
    for (const ch of chapters)
        for (const t of ch.txs)
            for (const l of t.logs)
                if (l.topic === 'booking' && t.to === 'jackpot') pos.set(String(l.b), cap(String(l.owner)))
    return pos
}

function detail(ch: TraceChapter, t: TraceTx, pos: Map<string, string>): string[] {
    const f = t.fields ?? {}
    switch (t.op) {
        case 'send_tokens': {
            const out = [`tokens: ${n(f.amount)}`, `to: ${whoLabel(f.recipient)}`]
            if (f.payload) out.push(f.payload)
            return out
        }
        case 'receive_tokens':
            return [`tokens: ${n(f.amount)}`]
        case 'transfer_notification': {
            const out = [`tokens: ${n(f.amount)}`, `sender: ${whoLabel(f.sender)}`]
            if (f.payload) out.push(f.payload)
            return out
        }
        case 'prepare_deposit': {
            const out = [`tokens: ${n(f.tokens)}`]
            if (f.owner && f.owner !== f.depositor) out.push(`for: ${cap(f.owner)}`)
            if (f.options === 'true') out.push(`min_principal: ${n(f.min_principal)}`)
            if (t.deploy) out.push('with StateInit: deploys the wallet')
            return out
        }
        case 'deposit_ready': {
            const out = [f.b === 'none' ? 'position: none yet' : `position: ${f.b}`]
            if (f.busy === 'true') out.push('busy')
            return out
        }
        case 'deposit_booked':
            return [`jGRAM: ${n(f.c)}`, `position: ${f.b}`]
        case 'deposit_cancelled':
        case 'close_wallet':
            return t.destroyed ? ['the wallet deletes itself'] : []
        case 'update': {
            const v = Number(f.delta)
            const out = [`position ${f.b}: ${v > 0 ? '+' : '−'}${n(Math.abs(v))}`, `tag ${f.tag}`]
            if (t.deploy) out.push('deploys the node')
            return out
        }
        case 'descend':
            return [`prize ${String(Number(f.slot) + 1)}, try ${String(Number(f.attempt) + 1)}`]
        case 'hit':
        case 'miss':
            return [`prize ${String(Number(f.slot) + 1)}, try ${String(Number(f.attempt) + 1)}`, `position ${f.b} (${pos.get(f.b) ?? '?'})`]
        case 'burn': {
            const out = [Number(f.amount) === 0 ? 'amount: 0 = everything' : `amount: ${n(f.amount)}`]
            if (f.to_successor === 'true') out.push('to_successor: true')
            if (f.payload) out.push(f.payload)
            return out
        }
        case 'burn_notification':
            return [`principal: ${n(f.x)}`, `position ${f.b}, last: ${f.last}`]
        case 'close_node': {
            const out = [`next_position: ${f.next_position}`]
            if (t.destroyed) out.push('the node deletes itself')
            return out
        }
        case 'take_current_quote':
            return [`rate: ${rate(f.TC, f.TT)}`]
        case 'provide_current_quote':
            return ['poke context in custom_payload']
        case 'unstake_tokens':
            return [`tokens: ${n(f.amount)}`]
        case 'proxy_reserve_tokens':
        case 'reserve_tokens':
        case 'proxy_tokens_burned':
        case 'tokens_burned': {
            const a = tokensOf(ch.txs, t)
            return a ? [`tokens: ${n(a)}`] : []
        }
        case 'withdrawal_notification':
            return [`tokens: ${n(f.amount)}`, `GRAM: ${n(f.coins)}`]
        case 'comment':
            return [`text: "${f.text}"`]
        case 'withdraw_for':
            return [`to_successor: ${f.to_successor}`]
        case 'set_successor':
            return [`successor: ${whoLabel(f.successor)}`, `deposit fee: ${n(f.fee, 4)} GRAM`]
        case 'bounced':
            return ['bounced']
        default:
            return []
    }
}

function edgeClass(t: TraceTx): string {
    if (failed(t)) return 'e-bad'
    if (t.op === 'gas_excess') return 'e-gas'
    if (['send_tokens', 'receive_tokens', 'transfer_notification', 'withdrawal_notification', 'tokens_burned', 'unstake_tokens'].includes(t.op)) {
        return 'e-token'
    }
    return 'e-msg'
}

const opLabel = (t: TraceTx) => (t.op === 'comment' ? 'text comment' : t.op === 'plain transfer' ? 'plain transfer' : `op::${t.op}`)

function dotFor(ch: TraceChapter, idx: number[], order: Map<number, number>, pos: Map<string, string>): string {
    const txs = idx.map((i) => {
        const t = ch.txs.find((x) => x.i === i)
        if (t == null) throw new Error(`chapter ${ch.id} has no transaction ${String(i)}`)
        return t
    })
    interface Group {
        key: string
        t: TraceTx[]
    }
    const groups: Group[] = []
    for (const t of txs) {
        const f = t.fields ?? {}
        const key = JSON.stringify([t.from, t.to, t.op, failed(t), t.op === 'send_tokens' ? f.recipient : null])
        const g = groups.find((x) => x.key === key)
        if (g) g.t.push(t)
        else groups.push({ key, t: [t] })
    }
    const actors: string[] = []
    for (const t of txs)
        for (const a of [t.from, t.to]) if (!actors.includes(a)) actors.push(a)
    const L = [
        'digraph {',
        '  graph [ rankdir=TB nodesep=0.5 ranksep=0.55 pad="0.3,0.1" bgcolor=transparent fontname="Arial" ]',
        '  node [ shape=box style="rounded,filled" fontname="Arial" fontsize=13 margin="0.14,0.08" ]',
        '  edge [ fontname="Arial" fontsize=11 arrowsize=0.7 ]',
    ]
    for (const a of actors) L.push(`  "${a}" [ label="${label(a)}" class="${kind(a)}" ]`)
    for (const g of groups) {
        const ts = g.t
        const nums = ts.map((t) => order.get(t.i) ?? 0)
        const nt = nums.length < 4 ? nums.join(', ') : `${String(nums[0])} to ${String(nums[nums.length - 1])}`
        const lines = [nt, opLabel(ts[0])]
        const ds = ts.map((t) => detail(ch, t, pos))
        if (ts.length === 1) {
            lines.push(...ds[0])
        } else if (ts[0].op === 'descend') {
            const fs = ts.map((t) => t.fields ?? {})
            const tries = new Set(fs.map((f) => f.attempt))
            if (tries.size === 1) {
                lines.push(`prizes ${fs.map((f) => String(Number(f.slot) + 1)).join(', ')}, try ${String(Number(fs[0].attempt) + 1)}`)
            } else {
                lines.push(ds.map((x) => x[0]).join(', '))
            }
        } else {
            for (const x of ds) if (x.length > 0) lines.push(x.join('; '))
        }
        const lab = lines.map((l) => l.replace(/"/g, "'")).join('\\l') + '\\l'
        L.push(`  "${ts[0].from}" -> "${ts[0].to}" [ label="${lab}" class="${edgeClass(ts[0])}" ]`)
    }
    L.push('}')
    return L.join('\n')
}

const rng = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, k) => a + k)

// Which transactions of a chapter go into which graph (a title for the graph, or null). The numbers are the
// transactions' places in the chapter's own order; the story spec checks that they exist.
export const PARTS: Record<string, [string | null, number[]][]> = {
    'alice-1': [[null, rng(1, 13)]],
    'bob-1': [[null, rng(1, 13)]],
    'poke-early': [[null, rng(1, 4)]],
    'carol-gift': [[null, rng(1, 14)]],
    'eve-refused': [[null, rng(1, 12)]],
    boundary: [
        ['The poke, the quote, and the boundary in the reply', rng(1, 5)],
        ['Hipo burns the unstaked hGRAM and sends GRAM back', rng(6, 10)],
    ],
    draw: [
        ['The submit and the three searches down the tree', rng(1, 14)],
        ['Three hits, three prizes with their notifications, and the burn', rng(15, 33)],
    ],
    'bob-burn': [[null, rng(1, 11)]],
    'alice-w': [[null, rng(1, 14)]],
    refill: [[null, rng(1, 8)]],
    foreign: [[null, rng(1, 8)]],
    retire: [[null, [1, 3]]],
    'withdraw-for': [[null, rng(1, 15)]],
    move: [
        ["The old Jackpot burns Dave's jGRAM and pays his hGRAM into the successor", [...rng(1, 14), 16]],
        ['The successor books it for Dave', [15, ...rng(17, 25)]],
    ],
    sweep: [
        ['The rest goes to the burner', [1, 2, 4, 5, 8, 9]],
        ['close_node deletes the tree from the top down', [3, 6, 7, 10, 11, 12, 13, 14]],
    ],
}

export interface ChapterGraph {
    title: string | null
    name: string
    dot: string
}

// The graphs of every chapter, keyed by chapter id. Numbers follow the chapter's own order across its graphs.
export function buildGraphs(chapters: TraceChapter[]): Map<string, ChapterGraph[]> {
    const pos = positionOwners(chapters)
    const out = new Map<string, ChapterGraph[]>()
    for (const ch of chapters) {
        const parts = PARTS[ch.id] as (typeof PARTS)[string] | undefined
        if (parts == null) continue // a chapter with no message to the Jackpot (a reward) has no graph
        const all = parts.flatMap(([, idx]) => idx).sort((a, b) => a - b)
        const order = new Map(all.map((i, k) => [i, k + 1] as const))
        out.set(
            ch.id,
            parts.map(([title, idx], k) => ({ title, name: `${ch.id}-${String(k)}`, dot: dotFor(ch, idx, order, pos) })),
        )
    }
    return out
}
