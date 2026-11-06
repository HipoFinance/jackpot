import { NetworkProvider } from '@ton/blueprint'
import { floatHigh } from '../wrappers/Jackpot'
import { amount, askAmount, confirmSend, openJackpot, readPool, requireQuiet, warnIfNotRole, done } from './lib/common'

// Sends the Jackpot's GRAM above its float to the governor: what the user chains and the draws left over.
// The float is G_hi (15 GRAM) plus the node float; the contract keeps the same amount.
const storageFloat = floatHigh

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const jackpot = await openJackpot(provider)

    const state = await jackpot.getJackpotState()
    const balance = await jackpot.getBalance()
    const keep = storageFloat + state.nodeFloat
    const surplus = balance > keep ? balance - keep : 0n
    ui.write(`Jackpot balance:   ${amount(balance)} GRAM`)
    ui.write(
        `Kept:              ${amount(keep)} GRAM (${amount(storageFloat)} GRAM float + ${amount(state.nodeFloat)} node float)`,
    )
    ui.write(`Will be withdrawn: ${amount(surplus)} GRAM`)

    // Money in flight draws on the float, so nothing may be open.
    requireQuiet(await readPool(provider, jackpot, false), 'Not withdrawing')
    if (state.nextPosition === 0n) {
        ui.write(
            'WARNING: there is no deposit yet. The first node of each level (0.68 GRAM) is still to be paid, ' +
                'and would come out of the float.',
        )
    }
    if (surplus === 0n) {
        ui.write('Nothing above the float. Nothing to do.')
        return
    }

    await warnIfNotRole(provider, jackpot, 'governor')
    const value = await askAmount(provider, 'Enter the GRAM to send', '0.1')

    const via = await confirmSend(provider, 'Withdraw the surplus to the governor', jackpot.address, value, [
        `surplus:     ${amount(surplus)} GRAM`,
    ])
    if (via == null) {
        return
    }

    await jackpot.sendWithdrawSurplus(via, { value })

    done(ui, via)
}
