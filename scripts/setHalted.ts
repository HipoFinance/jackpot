import { NetworkProvider } from '@ton/blueprint'
import { amount, askAmount, confirmSend, openJackpot, warnIfNotRole } from './lib/common'

// Halts or resumes the Jackpot. The halter or the governor may halt; only the governor resumes.
// A halt stops deposits (GRAM and hGRAM) and draw starts. A running draw completes and withdrawals go on.
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const jackpot = await openJackpot(provider)

    const choice = await ui.choose('What to do', ['halt', 'resume'], (x) => x)
    const halted = choice === 'halt'
    const state = await jackpot.getJackpotState()
    ui.write(`The Jackpot is now ${state.halted ? 'halted' : 'not halted'}.`)

    if (halted) {
        // Either role may halt: warn only when the sender is neither.
        const sender = provider.sender().address
        const addresses = await jackpot.getAddresses()
        if (sender == null || !(sender.equals(addresses.halter) || sender.equals(addresses.governor))) {
            ui.write(
                `WARNING: the sending wallet is neither the halter ${addresses.halter.toString()} nor the governor ` +
                    `${addresses.governor.toString()}. The Jackpot will refuse this message.`,
            )
        }
    } else {
        await warnIfNotRole(provider, jackpot, 'governor')
    }
    const value = await askAmount(provider, 'Enter the GRAM to send', '0.1')

    const via = await confirmSend(provider, `${halted ? 'Halt' : 'Resume'} the Jackpot`, jackpot.address, value, [
        `set_halted:  ${String(halted)}`,
        `value:       ${amount(value)} GRAM`,
    ])
    if (via == null) {
        return
    }

    await jackpot.sendSetHalted(via, { value, halted })

    ui.write('Done')
}
