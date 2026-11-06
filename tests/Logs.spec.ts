// Amendment 1, "Logs": every log is an external out message to addr_none whose body starts with the tag of a
// constructor, crc32("jackpot::<name>_log"), and parses with that constructor to the end; abi/jackpot.xml lists
// every one as <ext_out>. The property run (tests/Property.spec.ts) checks the same on every log of its sequences.
import '@ton/test-utils'
import { beginCell, toNano } from '@ton/core'
import { crc32 } from 'zlib'
import { readFileSync } from 'fs'
import { JackpotOp, LogMessage, LogTopic, parseLogStrict } from '../wrappers/Jackpot'
import { messageFrom, poke, sweepValue } from './jackpot/setup'
import { fresh, put, toBoundary, submitDraw } from './jackpot/scenario'

const G = (n: string | number) => toNano(String(n))

describe('Logs', () => {
    it('abi/jackpot.xml lists every log as an <ext_out> whose tag is crc32("jackpot::<name>_log"), and the wrapper knows each tag', () => {
        const abi = readFileSync('abi/jackpot.xml', 'utf8')
        const listed = [...abi.matchAll(/<ext_out name="(jackpot_[a-z_]+)"\/>/g)].map((m) => m[1])
        const defs = [...abi.matchAll(/^\s+([a-z_]+)#([0-9a-f]{8}) .*= ExtOutMsgBody;/gm)].map((m) => ({ name: m[1], tag: m[2] }))
        expect(defs.length).toBe(Object.keys(LogTopic).length)
        expect(listed.sort()).toEqual(defs.map((d) => `jackpot_${d.name}`).sort())
        for (const d of defs) expect(crc32(`jackpot::${d.name}_log`).toString(16).padStart(8, '0')).toBe(d.tag)
        expect(defs.map((d) => parseInt(d.tag, 16)).sort()).toEqual(Object.values(LogTopic).sort())
        // the same constructors are in schema.tlb
        const tlb = readFileSync('contracts/schema.tlb', 'utf8')
        for (const d of defs) expect(tlb).toContain(`${d.name}#${d.tag}`)
    })

    it('every log of a flow through deposits, a refusal, a boundary, a skip, a draw, an unstake and the end parses by its tag to the end', async () => {
        const sc = await fresh({ minDeposit: 1n, players: 3, mint: G('2000'), float: G('7.5') })
        const { env, players } = sc
        const seen = new Set<number>()
        const all: LogMessage[] = []
        const take = (r: { externals: LogMessage[] }) => all.push(...r.externals)
        await env.jackpot.sendSetMinPot(env.governor.getSender(), { value: G('0.05'), minPot: 1n })
        take(await env.jackpot.sendSetRiseMin(env.governor.getSender(), { value: G('0.05'), riseMin: 60 }))
        take((await put(env, players[0], G('300'))).result)
        take((await put(env, players[1], G('300'))).result)
        take((await put(env, players[2], G('10'), G('1000'))).result) // refused: price
        take(await toBoundary(env, G('40'))) // a boundary, with an unstake (the float is low)
        take(await toBoundary(env, G('40'))) // a skip
        take(await submitDraw(env)) // the draw: randomness and slots
        take(await toBoundary(env, G('40')))
        take(await submitDraw(env, 1))
        take(await poke(env))
        const { withdraw } = await import('./jackpot/setup')
        for (const p of players.slice(0, 2)) take(await withdraw(env, p, 0n))
        // the setters (halted, the same addresses) and a foreign jetton that waits
        const addresses = await env.jackpot.getAddresses()
        await env.jackpot.sendSetHalted(env.governor.getSender(), { value: G('0.05'), halted: true })
        take(await env.jackpot.sendSetTreasury(env.governor.getSender(), { value: G('0.05'), treasury: addresses.treasury }))
        take(
            await env.jackpot.sendSetHipoWallet(env.governor.getSender(), {
                value: G('0.05'),
                parent: addresses.parent,
                wallet: addresses.wallet,
                walletCode: addresses.walletCode,
            }),
        )
        await env.jackpot.sendSetHalted(env.governor.getSender(), { value: G('0.05'), halted: false })
        take(
            await env.blockchain.sendMessage(
                messageFrom(
                    players[2].address,
                    env.jackpot.address,
                    G('0.05'),
                    beginCell().storeUint(JackpotOp.transferNotification, 32).storeUint(0, 64).storeCoins(1n).storeAddress(players[0].address).storeBit(false).endCell(),
                    false,
                ),
            ),
        )
        take(await env.jackpot.sendRetire(env.governor.getSender(), { value: G('0.05') }))
        take(
            await env.jackpot.sendSetSuccessor(env.governor.getSender(), {
                value: G('0.05'),
                successor: players[2].address,
                depositFee: G('0.5'),
            }),
        )
        take(await env.jackpot.sendSweep(env.keeper.getSender(), { value: await sweepValue(env) }))
        expect(all.length).toBeGreaterThan(20)
        for (const m of all) {
            expect(m.info.dest == null).toBe(true) // addr_none
            const parsed = parseLogStrict(m)
            seen.add(parsed.topic)
        }
        const expected = Object.values(LogTopic).filter((t) => t !== LogTopic.bookingUndone && t !== LogTopic.untracked)
        for (const t of expected) expect(seen.has(t)).toBe(true)
    }, 600000)
})
