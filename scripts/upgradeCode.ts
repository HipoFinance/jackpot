import { execFileSync } from 'child_process'
import { Cell } from '@ton/core'
import { compile, NetworkProvider } from '@ton/blueprint'
import { storageVersion } from '../wrappers/Jackpot'
import { askAmount, confirmSend, hashes, openJackpot, typeBackHash, warnIfNotRole } from './lib/common'
import { dryRunUpgrade } from './lib/upgradeDryRun'

// Upgrades the Jackpot's code. The old code calls the new code's `migrate` (a method_id, ending in throw(0))
// in the same transaction (set_c3); if it cannot read the layout the transaction throws and the old code
// stays. Range and node code are fixed and cannot be upgraded.
//
// Before anything is sent: the contracts folder must be clean, the upgrade is replayed in a sandbox on a copy
// of the live account, and the operator types back the code hash from the audit record.
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const jackpot = await openJackpot(provider)

    const dirty = execFileSync('git', ['status', '--porcelain', 'contracts/'], { encoding: 'utf8' }).trim()
    if (dirty !== '') {
        throw new Error(`contracts/ has uncommitted changes, so the build is not the audited one:\n${dirty}`)
    }
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()

    const newCode = await compile('Jackpot')
    const hash = hashes(newCode)
    const version = await jackpot.getStorageVersion()

    console.info()
    console.info('UPGRADING CODE')
    console.info('==============')
    console.info('1. Rebase this repo, and check that the commit below is the audited one')
    console.info('2. Check migrate in jackpot.fc before proceeding: a method_id named migrate, ending in throw(0)')
    console.info('3. The Jackpot must be halted, with the draw idle and no open quotes or pending deposits')
    console.info('==============')
    console.info('Git commit:             %s', head)
    console.info('Stored layout version:  %s', String(version))
    console.info('This build writes:      %s (wrappers/Jackpot.ts)', String(storageVersion))
    console.info('New code hash hex:      %s', hash.hex)
    console.info('New code hash base64:   %s', hash.base64)
    console.info()

    // The sandbox dry run, on a copy of the live account.
    const live = await provider.provider(jackpot.address).getState()
    if (live.state.type !== 'active' || live.state.code == null || live.state.data == null) {
        throw new Error('The Jackpot is not an active account')
    }
    const checks = await dryRunUpgrade(
        {
            address: jackpot.address,
            code: Cell.fromBoc(live.state.code)[0],
            data: Cell.fromBoc(live.state.data)[0],
            balance: live.balance,
        },
        newCode,
        storageVersion,
    )
    console.info('DRY RUN (sandbox, on a copy of the live account)')
    for (const check of checks) {
        console.info(
            '  %s  %s%s',
            check.ok ? 'ok  ' : 'FAIL',
            check.name,
            check.detail == null ? '' : ` (${check.detail})`,
        )
    }
    if (!checks.every((c) => c.ok)) {
        throw new Error('The dry run failed. Nothing sent.')
    }
    console.info()

    await typeBackHash(provider, 'new code hash (hex)', hash.hex)

    await warnIfNotRole(provider, jackpot, 'governor')
    const value = await askAmount(provider, 'Enter the GRAM to send', '0.5')

    const via = await confirmSend(provider, 'Upgrade the Jackpot code', jackpot.address, value, [
        `code hash:   ${hash.hex}`,
        `git commit:  ${head}`,
    ])
    if (via == null) {
        return
    }

    await jackpot.sendUpgradeCode(via, { value, code: newCode })

    ui.write('Done')
}
