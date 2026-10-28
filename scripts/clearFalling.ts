import { NetworkProvider } from '@ton/blueprint'
import { askAmount, confirmSend, openJackpot, warnIfNotRole } from './lib/common'

// Clears the "rate fell" flag. Only the governor may. While the flag is up no draw starts, new bookings are
// refused and prizes are not paid; clear it only after the cause is understood (docs/architecture.md).
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const jackpot = await openJackpot(provider)

    const state = await jackpot.getJackpotState()
    const [coins, tokens] = await jackpot.getQuote()
    ui.write(`Rate fell flag: ${String(state.falling)}`)
    ui.write(`Stored quote:   ${String(coins)} nano-GRAM / ${String(tokens)} nano-hGRAM`)
    ui.write(`Last start:     ${String(state.lastCoins)} nano-GRAM / ${String(state.lastTokens)} nano-hGRAM`)

    await warnIfNotRole(provider, jackpot, 'governor')
    const value = await askAmount(provider, 'Enter the GRAM to send', '0.1')

    const via = await confirmSend(provider, 'Clear the rate-fell flag', jackpot.address, value, [])
    if (via == null) {
        return
    }

    await jackpot.sendClearFalling(via, { value })

    ui.write('Done')
}
