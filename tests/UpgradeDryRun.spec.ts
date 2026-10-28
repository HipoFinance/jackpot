/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests read state they just made */
// The sandbox dry run that scripts/upgradeCode.ts runs before it sends an upgrade (scripts/lib/upgradeDryRun.ts).
import { compile } from '@ton/blueprint'
import { toNano } from '@ton/core'
import '@ton/test-utils'
import { storageVersion } from '../wrappers/Jackpot'
import { dryRunUpgrade, LiveAccount } from '../scripts/lib/upgradeDryRun'
import { Env, setupJackpot } from './jackpot/setup'

async function liveAccount(env: Env): Promise<LiveAccount> {
    const contract = await env.blockchain.getContract(env.jackpot.address)
    const state = contract.accountState
    if (state?.type !== 'active') throw new Error('not active')
    return { address: env.jackpot.address, code: state.state.code!, data: state.state.data!, balance: contract.balance }
}

describe('The upgrade dry run', () => {
    it('passes for the same code on a halted, idle Jackpot', async () => {
        const env = await setupJackpot({ fakeTreasury: true })
        await env.jackpot.sendSetHalted(env.halter.getSender(), { value: toNano('0.1'), halted: true })
        const checks = await dryRunUpgrade(await liveAccount(env), env.jackpot.init!.code, storageVersion)
        expect(checks.filter((c) => !c.ok)).toEqual([])
        expect(checks.length).toBeGreaterThan(8)
    })

    it('refuses a Jackpot that is not halted, without upgrading anything', async () => {
        const env = await setupJackpot({ fakeTreasury: true })
        const checks = await dryRunUpgrade(await liveAccount(env), env.jackpot.init!.code, storageVersion)
        expect(checks.some((c) => c.name === 'the Jackpot is halted' && !c.ok)).toBe(true)
        expect(checks.length).toBe(4)
    })

    it('fails for code that cannot read the layout, and for a build that writes another version', async () => {
        const env = await setupJackpot({ fakeTreasury: true })
        await env.jackpot.sendSetHalted(env.halter.getSender(), { value: toNano('0.1'), halted: true })
        const account = await liveAccount(env)

        const bad = await dryRunUpgrade(account, env.rangeCode, storageVersion)
        expect(bad.some((c) => c.name.startsWith('upgrade_code') && !c.ok)).toBe(true)

        // the probe migrates to version 2, so it is not what a build of version 1 would write
        const probe = await compile('UpgradeProbe')
        const other = await dryRunUpgrade(account, probe, storageVersion)
        expect(other.some((c) => !c.ok)).toBe(true)
    })
})
