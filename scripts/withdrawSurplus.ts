import { NetworkProvider } from '@ton/blueprint'
import { amount, askAmount, confirmSend, openJackpot, readPool, requireQuiet, warnIfNotRole } from './lib/common'

// Sends the Jackpot's GRAM above its storage float to the governor: surcharges and what the keeper's
// messages left over. The float is 10 GRAM plus the node float.
const storageFloat = 10_000_000_000n

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const jackpot = await openJackpot(provider)

    const state = await jackpot.getJackpotState()
    const balance = await jackpot.getBalance()
    const keep = storageFloat + state.nodeFloat
    const surplus = balance > keep ? balance - keep : 0n
    ui.write(`Jackpot balance:   ${amount(balance)} GRAM`)
    ui.write(`Kept:              ${amount(keep)} GRAM (10 GRAM storage + ${amount(state.nodeFloat)} node float)`)
    ui.write(`Will be withdrawn: ${amount(surplus)} GRAM`)

    // Money in flight draws on the float, so nothing may be open.
    requireQuiet(await readPool(provider, jackpot), 'Not withdrawing')
    if (state.nextBooking === 0n) {
        ui.write(
            'WARNING: there is no booking yet. The first node of each level (1.28 GRAM) is still to be paid, ' +
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

    ui.write('Done')
}
