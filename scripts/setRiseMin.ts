import { NetworkProvider } from '@ton/blueprint'
import { askAmount, askInteger, confirmSend, openJackpot, warnIfNotRole, done } from './lib/common'

// Sets the rise minimum: the rise of Hipo's rate since the last boundary, in parts per million, that a poke needs
// before it makes the next boundary. It takes effect at once. The contract refuses a value outside 1 to 10000.
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const jackpot = await openJackpot(provider)

    const boundary = await jackpot.getBoundary()
    ui.write(`Rise minimum now: ${String(boundary.riseMin)} parts per million`)

    const riseMin = await askInteger(provider, 'Enter the new rise minimum in parts per million (1 to 10000)')
    if (riseMin < 1n || riseMin > 10000n) {
        throw new Error('The rise minimum is between 1 and 10000')
    }

    await warnIfNotRole(provider, jackpot, 'governor')
    const value = await askAmount(provider, 'Enter the GRAM to send', '0.1')

    const via = await confirmSend(provider, 'Set the rise minimum', jackpot.address, value, [
        `rise minimum:  ${riseMin.toString()} parts per million`,
    ])
    if (via == null) {
        return
    }

    await jackpot.sendSetRiseMin(via, { value, riseMin: Number(riseMin) })

    done(ui, via)
}
