import { NetworkProvider } from '@ton/blueprint'
import { amount, askAmount, confirmSend, openJackpot, warnIfNotRole, done } from './lib/common'

// Retires the Jackpot: new deposits are refused for good, and no message undoes it. Boundaries, draws, prizes,
// withdrawals, `w` and the burn go on. Only the governor may. Then set a successor (setSuccessor), let players
// withdraw (or withdrawFor), and end it with sweep.
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const jackpot = await openJackpot(provider)

    const retirement = await jackpot.getRetirement()
    const state = await jackpot.getJackpotState()
    ui.write(`Retired:    ${String(retirement.retired)}`)
    ui.write(`Principal:  ${amount(state.principal)} GRAM owed to players`)
    if (retirement.retired) {
        ui.write('The Jackpot is already retired. Nothing to do.')
        return
    }
    ui.write('WARNING: this cannot be undone by any message. Deposits, also those still on their way, are refused.')

    await warnIfNotRole(provider, jackpot, 'governor')
    const value = await askAmount(provider, 'Enter the GRAM to send', '0.1')

    const via = await confirmSend(provider, 'Retire the Jackpot', jackpot.address, value, [
        'effect:      no new deposits, for good',
    ])
    if (via == null) {
        return
    }

    await jackpot.sendRetire(via, { value })

    done(ui, via)
}
