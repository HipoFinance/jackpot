import { NetworkProvider } from '@ton/blueprint'
import {
    amount,
    askAddress,
    askAmount,
    confirmSend,
    openJackpot,
    printPool,
    readPool,
    warnIfNotRole,
} from './lib/common'

// Sends back hGRAM that reached the Jackpot's wallet without a notification (so it never entered T).
// Only tokens outside T may go: the amount may not exceed W - T, which open payouts and pending records
// also draw on.
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const jackpot = await openJackpot(provider)

    const pool = await readPool(provider, jackpot)
    printPool(ui, pool)

    // askAddress refuses an address that is not on the basechain
    const owner = await askAddress(provider, 'Enter the friendly address that gets the hGRAM back')
    const tokens = await askAmount(provider, 'Enter the hGRAM to return')
    if (tokens > pool.outside) {
        throw new Error(`Returning ${amount(tokens)} hGRAM, but only ${amount(pool.outside)} sits outside T`)
    }

    await warnIfNotRole(provider, jackpot, 'governor')
    const value = await askAmount(provider, 'Enter the GRAM to send', '0.5')

    const via = await confirmSend(
        provider,
        'Return hGRAM that arrived without a notification',
        jackpot.address,
        value,
        [
            `to:          ${owner.toString()}`,
            `amount:      ${amount(tokens)} hGRAM`,
            `outside T:   ${amount(pool.outside)} hGRAM`,
        ],
    )
    if (via == null) {
        return
    }

    await jackpot.sendReturnTokens(via, { value, owner, amount: tokens })

    ui.write('Done')
}
