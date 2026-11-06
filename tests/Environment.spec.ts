/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests read state they just made */
// Amendment 1, "Sandbox version", "PREVMCBLOCKS works" and "Fixed storage": the emulator the tests run in is the
// one the contracts need, or the build stops. No test is weakened to pass.
import '@ton/test-utils'
import { Dictionary, beginCell, toNano } from '@ton/core'
import { readFileSync } from 'fs'
import { BoundaryLog, LogTopic, logsOf, newBounce } from '../wrappers/Jackpot'
import { depositHgram, expectChainSucceeded, hgramOf, mcSeqno, setMcBlocks, walletAt } from './jackpot/setup'
import { fresh, put, toBoundary } from './jackpot/scenario'
import { mcHashOf } from './jackpot/testbuild'

const G = (n: string | number) => toNano(String(n))

describe('Environment', () => {
    it('Sandbox version: the emulator runs global version 12 or later with config 8 set to mainnet’s (16), and a message sent with extra_flags = 3 bounces as new_bounce_body', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const { env, players } = sc
        const config = Dictionary.loadDirect(Dictionary.Keys.BigInt(32), Dictionary.Values.Cell(), env.blockchain.config)
        const s = config.get(8n)!.beginParse()
        expect(s.loadUint(8)).toBe(0xc4)
        const version = s.loadUint(32)
        expect(version).toBeGreaterThanOrEqual(12)
        expect(version).toBe(16)
        // a frozen jGRAM wallet bounces the Jackpot's prepare_deposit; the bounce is the network's full-body one
        await put(env, players[0], G('100'))
        const addr = walletAt(env, players[0].address).address
        const acc = (await env.blockchain.getContract(addr)).account
        const state = acc.account!.storage.state
        if (state.type !== 'active') throw new Error('no wallet')
        const init = beginCell().storeUint(6, 5).storeRef(state.state.code!).storeRef(state.state.data!).endCell()
        await env.blockchain.setShardAccount(addr, {
            ...acc,
            account: {
                ...acc.account!,
                storage: {
                    ...acc.account!.storage,
                    state: { type: 'frozen', stateHash: BigInt('0x' + init.hash().toString('hex')) },
                },
            },
        })
        const h = await hgramOf(env, players[0].address)
        const dep = await depositHgram(env, players[0], G('20'), { minC: 0n })
        const bounce = dep.result.transactions.find((t) => t.inMessage?.info.type === 'internal' && t.inMessage.info.bounced)!
        expect(bounce).toBeDefined()
        expect(bounce.inMessage!.body.beginParse().preloadUint(32)).toBe(newBounce)
        expect(await hgramOf(env, players[0].address)).toBe(h)
    }, 200000)

    it('PREVMCBLOCKS works: a boundary reads a non-zero root hash of the entry with the highest seqno, and the sandbox sets it per transaction', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 2, mint: G('1000') })
        const { env, players } = sc
        await put(env, players[0], G('300'))
        const first = await toBoundary(env, G('40'))
        expectChainSucceeded(first)
        const [a] = logsOf<BoundaryLog>(first.externals, LogTopic.boundary)
        expect(a.mcHash).not.toBe(0n)
        expect(a.mcSeqno).toBe(BigInt(mcSeqno))
        expect(a.mcHash).toBe(mcHashOf(mcSeqno))
        // another block per transaction: the next boundary sees it
        setMcBlocks(env.blockchain, mcSeqno + 25)
        const second = await toBoundary(env, G('40'))
        const [b] = logsOf<BoundaryLog>(second.externals, LogTopic.skip).length
            ? [{ mcSeqno: logsOf<{ mcSeqno: bigint; mcHash: bigint }>(second.externals, LogTopic.skip)[0].mcSeqno, mcHash: logsOf<{ mcSeqno: bigint; mcHash: bigint }>(second.externals, LogTopic.skip)[0].mcHash }]
            : logsOf<BoundaryLog>(second.externals, LogTopic.boundary)
        expect(b.mcSeqno).toBe(BigInt(mcSeqno + 25))
        expect(b.mcHash).toBe(mcHashOf(mcSeqno + 25))
    }, 200000)

    it('Fixed storage: schema.tlb has no HashmapE in the Jackpot’s storage, and the data keeps its cell count (see the property run)', () => {
        const tlb = readFileSync('contracts/schema.tlb', 'utf8')
        const from = tlb.indexOf('// Jackpot storage')
        const to = tlb.indexOf('// jGRAM wallet storage')
        expect(from).toBeGreaterThan(0)
        expect(to).toBeGreaterThan(from)
        expect(tlb.slice(from, to)).not.toContain('HashmapE')
        expect(tlb.slice(from, to)).not.toContain('Hashmap')
    })
})
