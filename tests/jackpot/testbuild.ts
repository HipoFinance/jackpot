// A test-only build of the Jackpot for the tests that need more drand rounds than the 26 recorded ones.
// The patch is made in memory at compile time; nothing under contracts/ changes. In this build the
// quicknet check keeps its length checks but skips the pairing, and accepts only a signature that names the round
// R the draw waits for in its first 8 bytes (so a wrong round is refused as in production); the rest is chosen in the test and the seed is sha256 of it, exactly as in production. The flows that use the real
// key and the recorded rounds run on the production build (tests/Flows.spec.ts, tests/Drand.spec.ts).
import { compileFunc } from '@ton-community/func-js'
import { Cell, beginCell } from '@ton/core'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'

const from = `int quicknet_verify(int round, slice signature, slice witness) impure inline {
    return drand::verify_with_key(round, signature, witness, drand::public_key);
}`
const to = `int quicknet_verify(int round, slice signature, slice witness) impure inline {
    throw_unless(err::drand_bad_round, (round > 0) & (round < (1 << 64)));
    throw_unless(err::drand_bad_signature, (signature.slice_bits() == 384) & (signature.slice_refs() == 0));
    ;; the test signature carries its round in the first 8 bytes, and only the round R is accepted
    throw_unless(err::drand_wrong_signature, signature.preload_uint(64) == round);
    return string_hash(signature);
}`

// 'failReady' also makes the action phase of the deposit_ready handler fail (a reserve nobody can pay), to test the +16 bounce.
export type Variant = 'plain' | 'failReady'
const cached = new Map<Variant, Cell>()

export async function compileTestJackpot(variant: Variant = 'plain'): Promise<Cell> {
    const hit = cached.get(variant)
    if (hit) return hit
    const result = await compileFunc({
        targets: ['contracts/jackpot.fc'],
        sources: (path: string) => {
            const source = readFileSync(path, 'utf8')
            if (path.endsWith('imports/drand.fc')) {
                if (!source.includes(from)) throw new Error('test build: quicknet_verify not found')
                return source.replace(from, to)
            }
            if (variant === 'failReady' && path.endsWith('contracts/jackpot.fc')) {
                const at =
                    '    act_flag = send::bounce_if_failed;\n    int query_id = s~load_uint(64);\n    int busy? = s~load_int(1);'
                if (!source.includes(at)) throw new Error('test build: deposit_ready not found')
                return source.replace(
                    at,
                    at + '\n    raw_reserve(1000000000000000, reserve::exact + send::bounce_if_failed);',
                )
            }
            return source
        },
    })
    if (result.status === 'error') throw new Error(result.message)
    const code = Cell.fromBase64(result.codeBoc)
    cached.set(variant, code)
    return code
}

// The test "signature" of a round: the round in 8 bytes, then 40 bytes chosen by `variant`, so that one round
// can give many seeds. The build refuses any signature whose round is not the one the draw waits for.
// A node whose close_node burns extra gas, about 15% over the built node's measure at every level (4,000 gas at
// level 1, 90,000 above): "every node's real gas raised over its measure".
const nodeCached: { code?: Cell } = {}
export async function compileSlowNode(): Promise<Cell> {
    if (nodeCached.code) return nodeCached.code
    const at = '    ifnot from_parent?(src) | equal_slice_bits(src, jackpot) {\n        return ();\n    }\n    ifnot initialized? {'
    const result = await compileFunc({
        targets: ['contracts/node.fc'],
        sources: (path: string) => {
            const source = readFileSync(path, 'utf8')
            if (!path.endsWith('contracts/node.fc')) return source
            if (!source.includes(at)) throw new Error('slow node: close_node not found')
            return source.replace(
                at,
                '    ifnot from_parent?(src) | equal_slice_bits(src, jackpot) {\n        return ();\n    }\n' +
                    '    int burn = 7;\n    repeat (level == 1 ? 40 : 800) {\n        burn = (burn * 7 + 3) % 1000003;\n    }\n' +
                    '    if burn < 0 {\n        return ();\n    }\n    ifnot initialized? {',
            )
        },
    })
    if (result.status === 'error') throw new Error(result.message)
    nodeCached.code = Cell.fromBase64(result.codeBoc)
    return nodeCached.code
}

export function testSignature(round: number, variant = 0): Buffer {
    const head = Buffer.alloc(8)
    head.writeBigUInt64BE(BigInt(round))
    const a = createHash('sha256').update(`test round ${round.toString()} variant ${variant.toString()}`).digest()
    const b = createHash('sha256').update(a).digest()
    return Buffer.concat([head, a, b.subarray(0, 8)])
}

// The root hash tests/jackpot/setup.ts gives the newest masterchain block.
export function mcHashOf(newest: number): bigint {
    return BigInt('0x' + createHash('sha256').update(`mc root ${newest.toString()}`).digest('hex'))
}

// The seed of a draw: sha256(signature ‖ mc_hash), the newest block's root hash being the one of the boundary.
export function testSeed(round: number, variant = 0, newest = 5000): string {
    return createHash('sha256')
        .update(testSignature(round, variant))
        .update(Buffer.from(mcHashOf(newest).toString(16).padStart(64, '0'), 'hex'))
        .digest('hex')
}

export function testSignatureCell(round: number, variant = 0): Cell {
    return beginCell().storeBuffer(testSignature(round, variant)).endCell()
}
