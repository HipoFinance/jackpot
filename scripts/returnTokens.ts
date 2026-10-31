import { NetworkProvider } from '@ton/blueprint'
import {
    amount,
    askAddress,
    askAmount,
    askVerifyOnly,
    availableOutside,
    conclude,
    confirmSend,
    done,
    openJackpot,
    printPool,
    readPool,
    warnIfNotRole,
} from './lib/common'

// Sends back hGRAM that reached the Jackpot's wallet without a notification (so it never entered T).
// Only tokens outside T may go: the amount may not exceed W - T less the open payouts, one pool for every
// recovery. Answer "v" at the first prompt to run the checks and send nothing (for signers, just before
// signing).
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const verifyOnly = await askVerifyOnly(provider)
    const jackpot = await openJackpot(provider)

    const pool = await readPool(provider, jackpot)
    printPool(ui, pool)
    const { available, excluded } = await availableOutside(provider, pool)
    ui.write(`Available for this recovery: ${amount(available)} hGRAM (W - T less open payouts not excluded)`)

    // askAddress refuses an address that is not on the basechain
    const owner = await askAddress(provider, 'Enter the friendly address that gets the hGRAM back')
    const tokens = await askAmount(provider, 'Enter the hGRAM to return')

    const problems: string[] = []
    if (tokens > available) {
        problems.push(`returning ${amount(tokens)} hGRAM, but only ${amount(available)} hGRAM is available outside T`)
    }
    if (!conclude(ui, problems, verifyOnly)) {
        return
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
            `outside T:   ${amount(pool.outside)} hGRAM, ${amount(available)} hGRAM available`,
        ],
        {
            bodyNotes: [
                `checked against W - T = ${amount(pool.outside)} hGRAM, ${amount(available)} hGRAM after open payouts` +
                    (excluded.length > 0 ? ` (excluded payouts: ${excluded.join(', ')})` : ''),
                `this order consumes ${amount(tokens)} hGRAM of it`,
                'valid only if no other recovery order is pending: rerun this script with "v" just before signing',
            ],
        },
    )
    if (via == null) {
        return
    }

    await jackpot.sendReturnTokens(via, { value, owner, amount: tokens })

    done(ui, via)
}
