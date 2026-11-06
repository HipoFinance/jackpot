/// <reference types="node" />
// Renders each docs/graphs/<name>.dot to <name>-light.svg and <name>-dark.svg with @hpcc-js/wasm-graphviz. The .dot
// files have no theme: each node and edge carries a class (n-jackpot, e-token, ...), which this turns into colours.
import { Graphviz } from '@hpcc-js/wasm-graphviz'
import { readFileSync, readdirSync, writeFileSync } from 'fs'
import { join } from 'path'

interface Theme {
    ink: string
    muted: string
    line: string
    accent: string
    bad: string
    nodes: Record<string, string>
}

const light: Theme = {
    ink: '#1b2230',
    muted: '#5a6476',
    line: '#9aa3b2',
    accent: '#2448b8',
    bad: '#b3261e',
    nodes: {
        'n-person': '#e8ebf1',
        'n-jackpot': '#c9d5fa',
        'n-jgram': '#cdeadd',
        'n-hgram': '#fbe7bd',
        'n-node': '#e3dcf5',
        'n-hipo': '#f7d9d6',
        'n-foreign': '#d3ecef',
    },
}
const dark: Theme = {
    ink: '#e6e9ef',
    muted: '#9aa5b8',
    line: '#4a556a',
    accent: '#8fa8f5',
    bad: '#ff8a80',
    nodes: {
        'n-person': '#2b3342',
        'n-jackpot': '#2c3f7a',
        'n-jgram': '#1f4a3a',
        'n-hgram': '#55431a',
        'n-node': '#3b3060',
        'n-hipo': '#5a2e2b',
        'n-foreign': '#1d4650',
    },
}

export function themed(dot: string, t: Theme): string {
    return dot
        .replace(/class="(n-[a-z]+)"/g, (_, k: string) => {
            const stroke = k === 'n-jackpot' ? t.accent : t.line
            return `fillcolor="${t.nodes[k]}" color="${stroke}" fontcolor="${t.ink}"`
        })
        .replace(/class="(e-[a-z]+)"/g, (_, k: string) => {
            if (k === 'e-token') return `color="${t.accent}" fontcolor="${t.ink}" penwidth=2`
            if (k === 'e-gas') return `color="${t.muted}" fontcolor="${t.muted}" style=dashed`
            if (k === 'e-bad') return `color="${t.bad}" fontcolor="${t.bad}" penwidth=1.6`
            return `color="${t.muted}" fontcolor="${t.muted}"`
        })
}

export async function renderAll(dir: string) {
    const graphviz = await Graphviz.load()
    const files = readdirSync(dir).filter((f) => f.endsWith('.dot'))
    for (const f of files) {
        const dot = readFileSync(join(dir, f), 'utf8')
        const name = f.replace(/\.dot$/, '')
        writeFileSync(join(dir, `${name}-light.svg`), graphviz.dot(themed(dot, light)))
        writeFileSync(join(dir, `${name}-dark.svg`), graphviz.dot(themed(dot, dark)))
    }
    return files.length
}

if (require.main === module) {
    renderAll(join(__dirname, '..', '..', 'docs', 'graphs'))
        .then((count) => { console.log(`rendered ${String(count)} graphs`); })
        .catch((e: unknown) => {
            console.error(e)
            process.exit(1)
        })
}
