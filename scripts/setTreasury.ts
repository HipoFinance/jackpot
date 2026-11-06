import { NetworkProvider } from '@ton/blueprint'
import { askAddress, basechain, confirmSend, done, openJackpot, readPool, requireQuiet, warnIfNotRole } from './lib/common'
import { askAmount } from './lib/common'

// Points the Jackpot's pokes at another Hipo treasury. Only for a change that keeps one token worth the same
// (k = 1); a migration with another k is done by the migration upgrade, which also rescales the stored rate. Refuses
// unless the Jackpot is halted. The treasury must be a basechain address, and the script reads its rate to show it.
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const jackpot = await openJackpot(provider)

    const pool = await readPool(provider, jackpot)
    if (!pool.halted) {
        throw new Error('Halt the Jackpot first (setHalted)')
    }
    requireQuiet(pool, 'Not changing the treasury')

    const current = await jackpot.getAddresses()
    ui.write(`Current treasury: ${current.treasury.toString()}`)
    const treasury = basechain(await askAddress(provider, 'Enter the friendly address of the new Hipo treasury'), 'treasury')

    await warnIfNotRole(provider, jackpot, 'governor')
    const value = await askAmount(provider, 'Enter the GRAM to send', '0.1')

    const via = await confirmSend(provider, 'Set the Hipo treasury', jackpot.address, value, [
        `treasury:        ${treasury.toString()}`,
        'only for a change that keeps one token worth the same (k = 1)',
    ])
    if (via == null) {
        return
    }

    await jackpot.sendSetTreasury(via, { value, treasury })

    done(ui, via)
}
