import { compile } from '@ton/blueprint'
import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox'
import { beginCell, Cell, toNano, Transaction } from '@ton/core'
import { readFileSync } from 'fs'
import { join } from 'path'
import { bytesCell, DrandProbe } from '../wrappers/DrandProbe'
import {
    BLS12_381_P,
    buildWitness,
    DrandError,
    expandMessageXmd,
    packWitness,
    QUICKNET,
    reductionWitness,
    ReductionWitness,
    roundAt,
    roundTime,
} from '../wrappers/drand'

interface Fixture {
    round: number
    signature: string
    randomness: string
}

const fixtures: Fixture[] = (
    JSON.parse(readFileSync(join(__dirname, 'fixtures', 'drand', 'quicknet.json'), 'utf8')) as { rounds: Fixture[] }
).rounds

const MAX_GAS = 200_000n

// ---- BLS12-381 G1 encodings for the negative tests (plain bigint math) ----------------------------------

const P = BLS12_381_P

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
    let result = 1n
    base %= mod
    while (exp > 0n) {
        if (exp & 1n) {
            result = (result * base) % mod
        }
        base = (base * base) % mod
        exp >>= 1n
    }
    return result
}

function toBytes48(x: bigint): Buffer {
    return Buffer.from(x.toString(16).padStart(96, '0'), 'hex')
}

// Compressed encoding of the point (x, y) of E: y^2 = x^3 + 4 (ZCash format: flag bits 0x80 compressed,
// 0x20 for the larger y).
function compressG1(x: bigint, y: bigint): Buffer {
    const out = toBytes48(x)
    out[0] |= 0x80
    if (y > (P - 1n) / 2n) {
        out[0] |= 0x20
    }
    return out
}

// The first x ≥ start for which E has (has = true) or has not (has = false) a point.
function findX(start: bigint, has: boolean): { x: bigint; y: bigint } {
    for (let x = start; ; x++) {
        const rhs = (x * x * x + 4n) % P
        const y = modPow(rhs, (P + 1n) / 4n, P) // p ≡ 3 mod 4
        if (((y * y) % P === rhs) === has) {
            return { x, y }
        }
    }
}

// A point on E whose order is not r: the cofactor of G1 is about 2^126, so a point found this way is
// outside G1 except with negligible probability (and the test would then fail at the pairing, not pass).
const onCurveNotInG1 = (() => {
    const { x, y } = findX(5n, true)
    return compressG1(x, y)
})()
const offCurve = (() => {
    const { x } = findX(5n, false)
    return compressG1(x, 0n)
})()
const infinity = Buffer.concat([Buffer.from([0xc0]), Buffer.alloc(47)])

function negate(point: Buffer): Buffer {
    const out = Buffer.from(point)
    out[0] ^= 0x20
    return out
}

function sig(f: Fixture): Buffer {
    return Buffer.from(f.signature, 'hex')
}

function gasOf(tx: Transaction): bigint {
    if (tx.description.type !== 'generic' || tx.description.computePhase.type !== 'vm') {
        throw new Error('no compute phase')
    }
    return tx.description.computePhase.gasUsed
}

describe('drand quicknet verifier', () => {
    let code: Cell
    let blockchain: Blockchain
    let sender: SandboxContract<TreasuryContract>
    let probe: SandboxContract<DrandProbe>

    beforeAll(async () => {
        code = await compile('DrandProbe')
    })

    beforeEach(async () => {
        blockchain = await Blockchain.create()
        sender = await blockchain.treasury('sender')
        probe = blockchain.openContract(DrandProbe.createFromCode(code))
        const deploy = await probe.sendDeploy(sender.getSender(), toNano('1'))
        expect(deploy.transactions).toHaveTransaction({ to: probe.address, deploy: true, success: true })
    })

    async function verify(opts: {
        round: number | bigint
        signature: Buffer | Cell
        witness?: Cell
        publicKey?: Buffer
    }) {
        const result = await probe.sendVerify(sender.getSender(), toNano('1'), {
            round: opts.round,
            signature: opts.signature instanceof Cell ? opts.signature : bytesCell(opts.signature),
            witness: opts.witness ?? buildWitness(opts.round),
            publicKey: opts.publicKey == null ? undefined : bytesCell(opts.publicKey),
        })
        const tx = result.transactions.find((t) => t.inMessage?.info.dest?.toString() === probe.address.toString())
        if (tx == null) {
            throw new Error('no transaction on the probe')
        }
        return tx
    }

    function expectExit(tx: Transaction, code: number) {
        expect(tx).toBeDefined()
        expect(tx.description.type).toBe('generic')
        if (tx.description.type === 'generic' && tx.description.computePhase.type === 'vm') {
            expect(tx.description.computePhase.exitCode).toBe(code)
        } else {
            throw new Error('compute phase skipped')
        }
    }

    it('has at least 20 fixtures, spread over time and recent', () => {
        expect(fixtures.length).toBeGreaterThanOrEqual(20)
        const rounds = fixtures.map((f) => f.round)
        expect(Math.min(...rounds)).toBe(1)
        expect(Math.max(...rounds)).toBeGreaterThan(33_000_000)
    })

    it('verifies every fixture, returns drand randomness, within the gas limit', async () => {
        const gas: bigint[] = []
        for (const f of fixtures) {
            const tx = await verify({ round: f.round, signature: sig(f) })
            expectExit(tx, 0)
            const { round, seed } = await probe.getResult()
            expect(round).toBe(BigInt(f.round))
            expect(seed).toBe(BigInt('0x' + f.randomness))
            gas.push(gasOf(tx))
        }
        const min = gas.reduce((a, b) => (a < b ? a : b))
        const max = gas.reduce((a, b) => (a > b ? a : b))
        console.log(
            `drand quicknet verification: ${String(fixtures.length)} rounds, compute gas ${String(min)}..${String(max)} (limit ${String(MAX_GAS)})`,
        )
        expect(max).toBeLessThanOrEqual(MAX_GAS)
    })

    it('rejects a signature from another round', async () => {
        const a = fixtures[3]
        const b = fixtures[fixtures.length - 1]
        expectExit(await verify({ round: b.round, signature: sig(a) }), DrandError.wrongSignature)
        expectExit(await verify({ round: a.round + 1, signature: sig(a) }), DrandError.wrongSignature)
    })

    it('rejects the negated signature (in G1, wrong point)', async () => {
        const f = fixtures[5]
        expectExit(await verify({ round: f.round, signature: negate(sig(f)) }), DrandError.wrongSignature)
    })

    it('rejects a point on the curve but not in G1', async () => {
        const f = fixtures[5]
        expectExit(await verify({ round: f.round, signature: onCurveNotInG1 }), DrandError.signatureNotInG1)
        expectExit(await verify({ round: f.round, signature: negate(onCurveNotInG1) }), DrandError.signatureNotInG1)
    })

    it('rejects encodings that are not points', async () => {
        const f = fixtures[5]
        // x with no point on the curve
        expectExit(await verify({ round: f.round, signature: offCurve }), DrandError.signatureNotInG1)
        // x ≥ p
        const big = compressG1(P + 1n, 0n)
        expectExit(await verify({ round: f.round, signature: big }), DrandError.signatureNotInG1)
        // compression flag cleared
        const uncompressedFlag = Buffer.from(sig(f))
        uncompressedFlag[0] &= 0x7f
        expectExit(await verify({ round: f.round, signature: uncompressedFlag }), DrandError.signatureNotInG1)
        // infinity flag with a non-zero body
        const badInfinity = Buffer.from(infinity)
        badInfinity[47] = 1
        expectExit(await verify({ round: f.round, signature: badInfinity }), DrandError.signatureNotInG1)
    })

    it('rejects the point at infinity', async () => {
        const f = fixtures[5]
        expectExit(await verify({ round: f.round, signature: infinity }), DrandError.signatureIsZero)
    })

    it('rejects a malformed or short signature', async () => {
        const f = fixtures[5]
        const s = sig(f)
        expectExit(await verify({ round: f.round, signature: s.subarray(0, 47) }), DrandError.badSignature)
        expectExit(await verify({ round: f.round, signature: Buffer.alloc(0) }), DrandError.badSignature)
        expectExit(
            await verify({ round: f.round, signature: Buffer.concat([s, Buffer.from([0])]) }),
            DrandError.badSignature,
        )
        const odd = beginCell().storeBuffer(s).storeBit(0).endCell()
        expectExit(await verify({ round: f.round, signature: odd }), DrandError.badSignature)
        const withRef = beginCell().storeBuffer(s).storeRef(beginCell().endCell()).endCell()
        expectExit(await verify({ round: f.round, signature: withRef }), DrandError.badSignature)
    })

    it('rejects round 0', async () => {
        const f = fixtures[5]
        expectExit(await verify({ round: 0, signature: sig(f), witness: buildWitness(f.round) }), DrandError.badRound)
    })

    describe('wrong witness', () => {
        const f = () => fixtures[5]
        const good = () => reductionWitness(f().round)

        function withChange(index: 0 | 1, change: (w: ReductionWitness) => ReductionWitness): Cell {
            const w = good()
            w[index] = change(w[index])
            return packWitness(w)
        }

        for (const index of [0, 1] as const) {
            it(`q${String(index)} off by one`, async () => {
                for (const d of [1n, -1n]) {
                    const witness = withChange(index, (w) => ({ q: w.q + d, r: w.r }))
                    expectExit(await verify({ round: f().round, signature: sig(f()), witness }), DrandError.badWitness)
                }
            })

            it(`r${String(index)} off by one`, async () => {
                for (const d of [1n, -1n]) {
                    const witness = withChange(index, (w) => ({ q: w.q, r: w.r + d }))
                    expectExit(await verify({ round: f().round, signature: sig(f()), witness }), DrandError.badWitness)
                }
            })

            it(`r${String(index)} ≥ p, with q${String(index)} lowered so that x = q·p + r still holds`, async () => {
                const witness = withChange(index, (w) => {
                    const changed = { q: w.q - 1n, r: w.r + P }
                    expect(changed.q * P + changed.r).toBe(w.q * P + w.r)
                    expect(changed.r < 1n << 384n).toBe(true)
                    return changed
                })
                expectExit(await verify({ round: f().round, signature: sig(f()), witness }), DrandError.badWitness)
            })

            it(`q${String(index)} at its maximum does not overflow`, async () => {
                const witness = withChange(index, (w) => ({ q: (1n << 132n) - 1n, r: w.r }))
                expectExit(await verify({ round: f().round, signature: sig(f()), witness }), DrandError.badWitness)
            })
        }

        it('rejects the two values swapped', async () => {
            const w = good()
            const witness = packWitness([w[1], w[0]])
            expectExit(await verify({ round: f().round, signature: sig(f()), witness }), DrandError.badWitness)
        })

        it("rejects another round's witness", async () => {
            const witness = buildWitness(f().round + 1)
            expectExit(await verify({ round: f().round, signature: sig(f()), witness }), DrandError.badWitness)
        })

        it('rejects a malformed layout', async () => {
            const w = good()
            const full = packWitness(w)
            const s = full.beginParse()
            const firstBits = s.loadBits(516)
            const second = s.loadRef()
            const layouts = [
                beginCell().storeBits(firstBits).endCell(), // no ref
                beginCell().storeBits(firstBits).storeBit(0).storeRef(second).endCell(), // extra bit
                beginCell().storeBits(firstBits).storeRef(second).storeRef(second).endCell(), // extra ref
                beginCell()
                    .storeBits(firstBits)
                    .storeRef(beginCell().storeSlice(second.beginParse()).storeBit(1).endCell())
                    .endCell(), // second value too long
                beginCell()
                    .storeBits(firstBits)
                    .storeRef(beginCell().storeBits(second.beginParse().loadBits(515)).endCell())
                    .endCell(), // second value too short
            ]
            for (const witness of layouts) {
                expectExit(await verify({ round: f().round, signature: sig(f()), witness }), DrandError.badWitness)
            }
        })
    })

    describe('public key', () => {
        const publicKey = Buffer.from(QUICKNET.publicKey, 'hex')
        const g2Generator = Buffer.from(
            '93e02b6052719f607dacd3a088274f65596bd0d09920b61ab5da61bbdc7f5049334cf11213945d57e5ac7d055d042b7e024aa2b2f08f0a91260805272dc51051c6e47ad4fa403b02b4510b647ae3d1770bac0326a805bbefd48056c8c121bdb8',
            'hex',
        )

        it('accepts with the quicknet key passed in (the helper path matches)', async () => {
            const f = fixtures[7]
            expectExit(await verify({ round: f.round, signature: sig(f), publicKey }), 0)
            expect((await probe.getResult()).seed).toBe(BigInt('0x' + f.randomness))
        })

        it('rejects a wrong public key', async () => {
            const f = fixtures[7]
            expectExit(
                await verify({ round: f.round, signature: sig(f), publicKey: negate(publicKey) }),
                DrandError.wrongSignature,
            )
            expectExit(
                await verify({ round: f.round, signature: sig(f), publicKey: g2Generator }),
                DrandError.wrongSignature,
            )
        })
    })

    describe('round and time', () => {
        it('round_at matches the off-chain rule', async () => {
            const g = QUICKNET.genesisTime
            const times = [0, g - 100, g - 1, g, g + 1, g + 2, g + 3, g + 4, g + 5, g + 6, 1_800_000_000, 1_793_100_000]
            for (const t of times) {
                expect(await probe.getRoundAt(t)).toBe(BigInt(roundAt(t)))
            }
            expect(roundAt(g)).toBe(1)
            expect(roundAt(g + 1)).toBe(2)
            expect(roundAt(g + 3)).toBe(2)
            expect(roundAt(g + 4)).toBe(3)
        })

        it('round_at gives a round published at or after the time, and the round before is earlier', async () => {
            for (const f of fixtures) {
                const t = roundTime(f.round)
                expect(await probe.getRoundAt(t)).toBe(BigInt(f.round))
                expect(await probe.getRoundAt(t + 1)).toBe(BigInt(f.round + 1))
                expect(await probe.getRoundAt(t - 2)).toBe(BigInt(Math.max(f.round, 1)))
            }
        })
    })

    describe('off-chain helpers', () => {
        it('expand_message_xmd matches RFC 9380 test vectors (K.1)', () => {
            const dst = Buffer.from('QUUX-V01-CS02-with-expander-SHA256-128', 'ascii')
            expect(expandMessageXmd(Buffer.from(''), dst, 0x20).toString('hex')).toBe(
                '68a985b87eb6b46952128911f2a4412bbc302a9d759667f87f7a21d803f07235',
            )
            expect(expandMessageXmd(Buffer.from('abc'), dst, 0x20).toString('hex')).toBe(
                'd8ccab23b5985ccea865c6c97b6e5b8350e794e603b4b97902f53a8a0d605615',
            )
        })

        it('builds witnesses in range', () => {
            for (const f of fixtures) {
                for (const w of reductionWitness(f.round)) {
                    expect(w.r < P).toBe(true)
                    expect(w.q < 1n << 132n).toBe(true)
                }
            }
        })
    })
})
