// Fails on a lone T, I, O, F, U, P, L or G used as an identifier in contracts/ and wrappers/, or as a quantity in the prose of
// docs/architecture.md and README.md and in the text the scripts print: the amendment renamed the
// single-letter quantities of the formulas to words (spec §12). Comments, strings and a type parameter named T (the
// generic of logsOf) are not identifiers of a quantity.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const letters = /\b[TIOFUPLG]\b/g
const roots = ['contracts', 'wrappers']
const exts = new Set(['.fc', '.ts'])

function files(dir) {
    return readdirSync(dir).flatMap((f) => {
        const p = join(dir, f)
        return statSync(p).isDirectory() ? files(p) : exts.has(extname(p)) ? [p] : []
    })
}

function strip(text, ext) {
    let out = text
    if (ext === '.fc') out = out.replace(/;;[^\n]*/g, '')
    else out = out.replace(/\/\/[^\n]*/g, '')
    out = out.replace(/\/\*[\s\S]*?\*\//g, '')
    out = out.replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/`(?:[^`\\]|\\.)*`/g, '``')
    return out
}

let bad = 0
for (const root of roots) {
    for (const file of files(root)) {
        if (file.endsWith('stdlib.fc')) continue // vendored
        const ext = extname(file)
        const lines = strip(readFileSync(file, 'utf8'), ext).split('\n')
        lines.forEach((line, i) => {
            for (const m of line.matchAll(letters)) {
                // the generic parameter T of logsOf<T>
                if (ext === '.ts' && m[0] === 'T' && /<T>|<T,|\bT\[\]|:\s*T\b|\bas T\b/.test(line)) continue
                console.error(`${file}:${String(i + 1)}: lone ${m[0]} used as an identifier: ${line.trim()}`)
                bad++
            }
        })
    }
}

// the prose of the docs, outside code, and the text every script prints
const lone = /(?<![\w'’-])[TIOFUPLG](?![\w'’-])/
for (const file of ['docs/architecture.md', 'README.md']) {
    const prose = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, '')).replace(/`[^`\n]*`/g, '')
    prose.split('\n').forEach((line, i) => {
        if (lone.test(line)) {
            console.error(`${file}:${String(i + 1)}: lone letter in prose: ${line.trim().slice(0, 100)}`)
            bad++
        }
    })
}
for (const file of [...files('scripts')].filter((f) => f.endsWith('.ts'))) {
    const text = readFileSync(file, 'utf8')
    // string literals, with the ${...} of a template removed
    for (const m of text.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)) {
        const literal = m[0].replace(/\$\{[^}]*\}/g, '')
        if (lone.test(literal) && !/^\s*(import|from)/.test(literal)) {
            const line = text.slice(0, m.index).split('\n').length
            console.error(`${file}:${String(line)}: lone letter in printed text: ${literal.slice(0, 100)}`)
            bad++
        }
    }
}
if (bad > 0) {
    console.error(`${String(bad)} lone-letter identifier(s): use the names of the spec's §12`)
    process.exit(1)
}
console.log('no lone-letter quantities in contracts/, wrappers/, the prose of the docs and the output of the scripts')
