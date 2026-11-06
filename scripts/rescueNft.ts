import { NetworkProvider } from '@ton/blueprint'
import { askAddress, askAmount, basechain, confirmSend, done, openJackpot, warnIfNotRole } from './lib/common'

// Sends an NFT item the Jackpot holds on to an address. An NFT that came with enough GRAM went back by itself; this
// is for one that came with too little, from a mint, or with the Jackpot as previous owner. Only the governor may.
// Never use it on an item of Hipo's bill collection without checking what it is. Check the item on chain first.
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const jackpot = await openJackpot(provider)

    const nft = basechain(await askAddress(provider, 'Enter the friendly address of the NFT item'), 'nft')
    const destination = basechain(await askAddress(provider, 'Enter the friendly address to send it to'), 'destination')

    await warnIfNotRole(provider, jackpot, 'governor')
    const value = await askAmount(provider, 'Enter the GRAM to send', '0.1')

    const via = await confirmSend(provider, 'Rescue an NFT', jackpot.address, value, [
        `item:            ${nft.toString()}`,
        `destination:     ${destination.toString()}`,
    ])
    if (via == null) {
        return
    }

    await jackpot.sendRescueNft(via, { value, nft, destination })

    done(ui, via)
}
