import { NetworkProvider } from '@ton/blueprint'
import { askAmount, askInteger, confirmSend, openJackpot, warnIfNotRole, done } from './lib/common'

// Sets the minimum gap: the seconds that must pass after a boundary before the next one. It takes effect at the
// next boundary, which checks its own rule with the old value. The contract refuses a value outside 3600 to
// 2592000 (one hour to thirty days).
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const jackpot = await openJackpot(provider)

    const boundary = await jackpot.getBoundary()
    ui.write(`Minimum gap now: ${String(boundary.minGap)} s`)
    if (boundary.nextMinGap !== 0) {
        ui.write(`A change to ${String(boundary.nextMinGap)} s is already waiting for the next boundary.`)
    }

    const minGap = await askInteger(provider, 'Enter the new minimum gap in seconds (3600 to 2592000)')
    if (minGap < 3600n || minGap > 2592000n) {
        throw new Error('The minimum gap is between 3600 and 2592000 seconds')
    }

    await warnIfNotRole(provider, jackpot, 'governor')
    const value = await askAmount(provider, 'Enter the GRAM to send', '0.1')

    const via = await confirmSend(provider, 'Set the minimum gap', jackpot.address, value, [
        `minimum gap:  ${minGap.toString()} s, from the next boundary`,
    ])
    if (via == null) {
        return
    }

    await jackpot.sendSetMinGap(via, { value, minGap: Number(minGap) })

    done(ui, via)
}
