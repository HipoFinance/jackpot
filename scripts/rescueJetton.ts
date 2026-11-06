import { NetworkProvider } from '@ton/blueprint'
import { amount, askAddress, askAmount, basechain, confirmSend, done, openJackpot, warnIfNotRole } from './lib/common'

// Sends a foreign jetton the Jackpot holds on to an address, from the jetton wallet the Jackpot owns. A foreign jetton
// that came with enough GRAM went back by itself; this is for one that came with too little, or whose return bounced.
// Only the governor may. The Jackpot refuses its own hGRAM wallet (hGRAM inside the count goes back only through
// returnTokens); an old hGRAM wallet can be named. The amount is the jetton's own units. Check the wallet on chain
// first: the Jackpot cannot tell a jetton from a fake.
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const jackpot = await openJackpot(provider)

    const current = await jackpot.getAddresses()
    ui.write(`The Jackpot's hGRAM wallet (refused): ${current.wallet.toString()}`)
    const jettonWallet = basechain(await askAddress(provider, "Enter the friendly address of the Jackpot's jetton wallet"), 'jetton wallet')
    if (jettonWallet.equals(current.wallet)) {
        throw new Error('That is the hGRAM wallet: use returnTokens')
    }
    const tokens = await askAmount(provider, "Enter the amount, in the jetton's own units (9 decimals)")
    const destination = basechain(await askAddress(provider, 'Enter the friendly address to send it to'), 'destination')

    await warnIfNotRole(provider, jackpot, 'governor')
    const value = await askAmount(provider, 'Enter the GRAM to send', '0.1')

    const via = await confirmSend(provider, 'Rescue a foreign jetton', jackpot.address, value, [
        `jetton wallet:   ${jettonWallet.toString()}`,
        `amount:          ${amount(tokens)} (9 decimals assumed)`,
        `destination:     ${destination.toString()}`,
    ])
    if (via == null) {
        return
    }

    await jackpot.sendRescueJetton(via, { value, jettonWallet, amount: tokens, destination })

    done(ui, via)
}
