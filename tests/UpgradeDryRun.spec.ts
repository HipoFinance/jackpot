/* eslint-disable @typescript-eslint/no-non-null-assertion -- tests read state they just made */
// The sandbox dry run that scripts/upgradeCode.ts runs before it sends an upgrade (scripts/lib/upgradeDryRun.ts),
// and the upgrade message itself. There is no tick any more, so the dry run's own clock does not matter.
import { compile } from '@ton/blueprint'
import { toNano } from '@ton/core'
import '@ton/test-utils'
import { storageVersion } from '../wrappers/Jackpot'
import { dryRunUpgrade, LiveAccount } from '../scripts/lib/upgradeDryRun'
import { Env, setupJackpot } from './jackpot/setup'
import { compileJackpotV2 } from './jackpot/v2'
import { compileFunc } from '@ton-community/func-js'
import { Cell } from '@ton/core'
import { readFileSync } from 'fs'

async function liveAccount(env: Env): Promise<LiveAccount> {
    const contract = await env.blockchain.getContract(env.jackpot.address)
    const state = contract.accountState
    if (state?.type !== 'active') throw new Error('not active')
    return { address: env.jackpot.address, code: state.state.code!, data: state.state.data!, balance: contract.balance }
}

describe('The upgrade dry run', () => {
    it('passes for the same code on a halted, idle Jackpot', async () => {
        const env = await setupJackpot()
        await env.jackpot.sendSetHalted(env.halter.getSender(), { value: toNano('0.1'), halted: true })
        const checks = await dryRunUpgrade(await liveAccount(env), env.jackpot.init!.code, storageVersion)
        expect(checks.filter((c) => !c.ok)).toEqual([])
        expect(checks.length).toBeGreaterThan(8)
    })

    it('refuses a Jackpot that is not halted, without upgrading anything', async () => {
        const env = await setupJackpot()
        const checks = await dryRunUpgrade(await liveAccount(env), env.jackpot.init!.code, storageVersion)
        expect(checks.some((c) => c.name === 'the Jackpot is halted' && !c.ok)).toBe(true)
        expect(checks.length).toBe(2)
    })

    it('fails for code that cannot read the layout, and for a build that writes another version', async () => {
        const env = await setupJackpot()
        await env.jackpot.sendSetHalted(env.halter.getSender(), { value: toNano('0.1'), halted: true })
        const account = await liveAccount(env)

        const bad = await dryRunUpgrade(account, env.jettonWalletCode, storageVersion)
        expect(bad.some((c) => c.name.startsWith('upgrade_code') && !c.ok)).toBe(true)

        // the probe migrates to version 2, so it is not what a build of version 1 would write
        const probe = await compile('UpgradeProbe')
        const other = await dryRunUpgrade(account, probe, storageVersion)
        expect(other.some((c) => !c.ok)).toBe(true)
    })

    it('passes for a real layout bump from version 1 to version 2', async () => {
        const env = await setupJackpot()
        await env.jackpot.sendSetHalted(env.halter.getSender(), { value: toNano('0.1'), halted: true })
        const v2 = await compileJackpotV2()
        const checks = await dryRunUpgrade(await liveAccount(env), v2, 2)
        expect(checks.filter((c) => !c.ok)).toEqual([])
        // the roll-forward checks ran, not the rollback
        expect(checks.some((c) => c.name.startsWith('a second upgrade_code'))).toBe(true)
        expect(checks.some((c) => c.name.startsWith('an upgrade back'))).toBe(false)
    })

    it('fails when the build claims version 2 but the code only writes version 1', async () => {
        const env = await setupJackpot()
        await env.jackpot.sendSetHalted(env.halter.getSender(), { value: toNano('0.1'), halted: true })
        const checks = await dryRunUpgrade(await liveAccount(env), env.jackpot.init!.code, 2)
        expect(checks.some((c) => c.name.includes('version') && !c.ok)).toBe(true)
    })
})

// "upgrades": migrate keeps the draw state and never lowers the tag; storage carries a version.
describe('Upgrades', () => {
    it('upgrade_code with the same code keeps the draw where it is and the tag; a stranger cannot upgrade', async () => {
        const env = await setupJackpot({ testBuild: false })
        const state0 = await env.jackpot.getJackpotState()
        const stranger = await env.blockchain.treasury('stranger')
        const denied = await env.jackpot.sendUpgradeCode(stranger.getSender(), {
            value: toNano('0.1'),
            code: env.jackpot.init!.code,
        })
        expect(denied.transactions).toHaveTransaction({ to: env.jackpot.address, success: false })
        const ok = await env.jackpot.sendUpgradeCode(env.governor.getSender(), {
            value: toNano('0.1'),
            code: env.jackpot.init!.code,
        })
        expect(ok.transactions).toHaveTransaction({ to: env.jackpot.address, success: true })
        expect(await env.jackpot.getJackpotState()).toEqual(state0)
        expect(await env.jackpot.getStorageVersion()).toBe(storageVersion)
        // code that cannot read the layout reverts the upgrade
        const bad = await env.jackpot.sendUpgradeCode(env.governor.getSender(), {
            value: toNano('0.1'),
            code: env.nodeCode,
        })
        expect(bad.transactions).toHaveTransaction({ to: env.jackpot.address, success: false })
        expect(await env.jackpot.getStorageVersion()).toBe(storageVersion)
    })

    it('an upgrade sent after a boundary is not refused as a changed draw, and the tag does not fall', async () => {
        const env = await setupJackpot({ testBuild: false })
        const tag0 = (await env.jackpot.getJackpotState()).tag
        env.blockchain.now = (env.blockchain.now ?? 0) + 4000
        const up = await env.jackpot.sendUpgradeCode(env.governor.getSender(), {
            value: toNano('0.1'),
            code: env.jackpot.init!.code,
        })
        expect(up.transactions).toHaveTransaction({ to: env.jackpot.address, success: true })
        expect((await env.jackpot.getJackpotState()).tag).toBeGreaterThanOrEqual(tag0)
    })

    it('refuses a build whose wallet code or derivation changed', async () => {
        const env = await setupJackpot()
        await env.jackpot.sendSetHalted(env.halter.getSender(), { value: toNano('0.1'), halted: true })
        // the same build, but it reads the node code where the jGRAM wallet code belongs: every derived wallet moves
        const result = await compileFunc({
            targets: ['contracts/jackpot.fc'],
            sources: (path: string) => {
                const source = readFileSync(path, 'utf8')
                if (!path.endsWith('contracts/jackpot.fc')) return source
                const from = 'cell wallet_code() inline {\n    return address_ref(0);'
                if (!source.includes(from)) throw new Error('wallet_code not found')
                return source.replace(from, 'cell wallet_code() inline {\n    return address_ref(1);')
            },
        })
        if (result.status === 'error') throw new Error(result.message)
        const changed = Cell.fromBase64(result.codeBoc)
        const checks = await dryRunUpgrade(await liveAccount(env), changed, storageVersion)
        const bad = checks.filter((c) => !c.ok)
        expect(bad.some((c) => c.name.includes('derived wallet and node addresses are unchanged'))).toBe(true)
    })
})
