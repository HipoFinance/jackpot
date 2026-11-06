import { NetworkProvider } from '@ton/blueprint'
import {
    amount,
    askAddress,
    askAmount,
    askVerifyOnly,
    conclude,
    confirmSend,
    done,
    openJackpot,
    printPool,
    readPool,
    warnIfNotRole,
} from './lib/common'

// Sends back hGRAM that reached the Jackpot's wallet without a notification (so it never entered T).
// Only tokens outside T may go: the amount may not exceed W - T, one pool for every recovery. With "in flight"
// the tokens are still counted as incoming (a deposit stuck in its steps) and the amount may not exceed that
// count instead. The Jackpot keeps no record of its own payouts, so a prize or burn still on its way also shows in
// W - T: the script reads twice and uses the lower figure. Answer "v" at the first prompt to run the checks and send nothing (for signers, just before
// signing).
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const verifyOnly = await askVerifyOnly(provider)
    const jackpot = await openJackpot(provider)

    const pool = await readPool(provider, jackpot)
    printPool(ui, pool)
    const inFlight =
        (await ui.input('Are the tokens still counted as incoming (in flight)? [yN]')).trim().toLowerCase() === 'y'
    const available = inFlight ? pool.incoming : pool.outside
    ui.write(
        inFlight
            ? `Available for this recovery: ${amount(available)} hGRAM (the incoming count)`
            : `Available for this recovery: ${amount(available)} hGRAM (W - T)`,
    )

    // askAddress refuses an address that is not on the basechain
    const owner = await askAddress(provider, 'Enter the friendly address that gets the hGRAM back')
    const tokens = await askAmount(provider, 'Enter the hGRAM to return')

    const problems: string[] = []
    if (tokens > available) {
        problems.push(`returning ${amount(tokens)} hGRAM, but only ${amount(available)} hGRAM is available`)
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
            `in flight:   ${String(inFlight)}`,
            `available:   ${amount(available)} hGRAM (W - T = ${amount(pool.outside)}, incoming ${amount(pool.incoming)})`,
        ],
        {
            bodyNotes: [
                `checked against ${inFlight ? 'the incoming count' : 'W - T'} = ${amount(available)} hGRAM`,
                `this order consumes ${amount(tokens)} hGRAM of it`,
                'valid only if no other recovery order is pending: rerun this script with "v" just before signing',
            ],
        },
    )
    if (via == null) {
        return
    }

    await jackpot.sendReturnTokens(via, { value, owner, amount: tokens, inFlight })

    done(ui, via)
}
