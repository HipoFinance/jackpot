import { NetworkProvider } from '@ton/blueprint'
import { askAddress, askAmount, confirmSend, openJackpot, warnIfNotRole } from './lib/common'

export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const jackpot = await openJackpot(provider)

    const current = (await jackpot.getAddresses()).halter
    ui.write(`Current halter: ${current.toString()}`)
    const halter = await askAddress(provider, 'Enter the friendly address of the new halter')

    await warnIfNotRole(provider, jackpot, 'governor')
    const value = await askAmount(provider, 'Enter the GRAM to send', '0.1')

    const via = await confirmSend(provider, 'Set the halter', jackpot.address, value, [
        `new halter:  ${halter.toString()}`,
    ])
    if (via == null) {
        return
    }

    await jackpot.sendSetHalter(via, { value, halter })

    ui.write('Done')
}
