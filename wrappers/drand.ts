// Off-chain helpers for the drand quicknet check in contracts/imports/drand.fc: round and time, fetching a
// round from api.drand.sh, and the reduction witness the contract needs for hash-to-G1.
//
// The contract cannot reduce a 512-bit number mod the 381-bit BLS12-381 field prime p with 257-bit TVM
// integers, so the sender supplies the quotient q and remainder r of each of the two reductions, and the
// contract checks x = q·p + r and r < p. A wrong witness only makes that check fail.

import { createHash } from 'crypto'
import { beginCell, Cell } from '@ton/core'

// From https://api.drand.sh/v2/beacons/quicknet/info, checked 2026-10-27.
export const QUICKNET = {
    chainHash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
    scheme: 'bls-unchained-g1-rfc9380',
    genesisTime: 1692803367,
    period: 3,
    publicKey:
        '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
    dst: 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_',
} as const

export const DRAND_API = 'https://api.drand.sh'

// The base field prime of BLS12-381.
export const BLS12_381_P =
    0x1a0111ea397fe69a4b1ba7b6434bacd764774b84f38512bf6730d2a0f6b0f6241eabfffeb153ffffb9feffffffffaaabn

// Bit sizes of the witness fields, as drand.fc reads them. q ≤ floor((2^512 − 1) / p) < 2^132.
export const WITNESS_Q_BITS = 132
export const WITNESS_R_BITS = 384

// Error codes thrown by drand.fc.
export const DrandError = {
    badRound: 501,
    badSignature: 502,
    badWitness: 503,
    signatureNotInG1: 504,
    signatureIsZero: 505,
    wrongSignature: 506,
} as const

export interface DrandRound {
    round: number
    signature: Buffer // 48-byte compressed G1 point
    randomness: Buffer // sha256(signature)
}

export interface ReductionWitness {
    q: bigint
    r: bigint
}

// Unix time at which drand publishes `round` (round 1 is at genesis).
export function roundTime(round: number): number {
    return QUICKNET.genesisTime + (round - 1) * QUICKNET.period
}

// The smallest round n with roundTime(n) ≥ time; the same rule as quicknet_round_at in drand.fc.
// Never below 1.
export function roundAt(time: number): number {
    if (time <= QUICKNET.genesisTime) {
        return 1
    }
    return Math.ceil((time - QUICKNET.genesisTime) / QUICKNET.period) + 1
}

// The latest round drand should have published at `time`.
export function currentRound(time: number): number {
    if (time < QUICKNET.genesisTime) {
        return 0
    }
    return Math.floor((time - QUICKNET.genesisTime) / QUICKNET.period) + 1
}

function sha256(...parts: Buffer[]): Buffer {
    const h = createHash('sha256')
    for (const part of parts) {
        h.update(part)
    }
    return h.digest()
}

// Fetches a round (or the latest one) from the drand HTTP API. The randomness is computed here as
// sha256(signature); the API's v2 endpoint does not return it. Check the signature on chain, not here.
export async function fetchRound(round: number | 'latest', baseUrl: string = DRAND_API): Promise<DrandRound> {
    const url = `${baseUrl}/v2/beacons/quicknet/rounds/${String(round)}`
    const response = await fetch(url)
    if (!response.ok) {
        throw new Error(`drand: ${url} answered ${String(response.status)}`)
    }
    const body = (await response.json()) as { round: number; signature: string }
    if (round !== 'latest' && body.round !== round) {
        throw new Error(`drand: asked for round ${String(round)}, got ${String(body.round)}`)
    }
    const signature = Buffer.from(body.signature, 'hex')
    if (signature.length !== 48) {
        throw new Error(`drand: round ${String(body.round)} has a ${String(signature.length)}-byte signature`)
    }
    return { round: body.round, signature, randomness: sha256(signature) }
}

// The message drand quicknet signs for a round: sha256 of the round as 8 bytes, big-endian.
export function roundMessage(round: number | bigint): Buffer {
    const bytes = Buffer.alloc(8)
    bytes.writeBigUInt64BE(BigInt(round))
    return sha256(bytes)
}

// expand_message_xmd with SHA-256 (RFC 9380, section 5.3.1).
export function expandMessageXmd(msg: Buffer, dst: Buffer, lenInBytes: number): Buffer {
    const ell = Math.ceil(lenInBytes / 32)
    if (ell > 255 || lenInBytes > 65535 || dst.length > 255) {
        throw new Error('expand_message_xmd: bad lengths')
    }
    const dstPrime = Buffer.concat([dst, Buffer.from([dst.length])])
    const zPad = Buffer.alloc(64)
    const libStr = Buffer.from([lenInBytes >> 8, lenInBytes & 0xff])
    const b0 = sha256(zPad, msg, libStr, Buffer.from([0]), dstPrime)
    const blocks: Buffer[] = [sha256(b0, Buffer.from([1]), dstPrime)]
    for (let i = 2; i <= ell; i++) {
        const prev = blocks[blocks.length - 1]
        const mixed = Buffer.alloc(32)
        for (let j = 0; j < 32; j++) {
            mixed[j] = b0[j] ^ prev[j]
        }
        blocks.push(sha256(mixed, Buffer.from([i]), dstPrime))
    }
    return Buffer.concat(blocks).subarray(0, lenInBytes)
}

// The two 512-bit numbers hash-to-G1 reduces mod p for a round.
export function hashToFieldInputs(round: number | bigint): [bigint, bigint] {
    const uniform = expandMessageXmd(roundMessage(round), Buffer.from(QUICKNET.dst, 'ascii'), 128)
    return [BigInt('0x' + uniform.subarray(0, 64).toString('hex')), BigInt('0x' + uniform.subarray(64).toString('hex'))]
}

// Quotient and remainder of the two reductions for a round.
export function reductionWitness(round: number | bigint): [ReductionWitness, ReductionWitness] {
    const [x0, x1] = hashToFieldInputs(round)
    return [
        { q: x0 / BLS12_381_P, r: x0 % BLS12_381_P },
        { q: x1 / BLS12_381_P, r: x1 % BLS12_381_P },
    ]
}

// Packs a witness exactly as drand.fc reads it:
//   q0:uint132 r0:uint384 ^[ q1:uint132 r1:uint384 ]
// r is stored as 48 bytes big-endian, the field-element encoding BLS_MAP_TO_G1 takes.
export function packWitness(w: [ReductionWitness, ReductionWitness]): Cell {
    const second = beginCell().storeUint(w[1].q, WITNESS_Q_BITS).storeUint(w[1].r, WITNESS_R_BITS).endCell()
    return beginCell().storeUint(w[0].q, WITNESS_Q_BITS).storeUint(w[0].r, WITNESS_R_BITS).storeRef(second).endCell()
}

// The witness cell for a round, ready to send.
export function buildWitness(round: number | bigint): Cell {
    return packWitness(reductionWitness(round))
}
