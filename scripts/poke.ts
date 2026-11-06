import { NetworkProvider } from '@ton/blueprint'
import { amount, askAmount, confirmSend, done, openJackpot } from './lib/common'

// Pokes the Jackpot: it asks Hipo for its rate and makes a boundary if the rate rose by the rise minimum since
// the last boundary and the minimum gap has passed. Anyone may send it; it is no governor message, so there is no
// body to print. What the poke does not spend comes back.
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const jackpot = await openJackpot(provider)

    const boundary = await jackpot.getBoundary()
    const state = await jackpot.getJackpotState()
    const fees = await jackpot.getJackpotFees()
    const now = Math.floor(Date.now() / 1000)
    ui.write(`Last boundary:        ${new Date(boundary.lastBoundary * 1000).toISOString()}`)
    ui.write(
        `Earliest next:        ${new Date(boundary.earliestNextBoundary * 1000).toISOString()}` +
            (now < boundary.earliestNextBoundary ? ' (not yet)' : ''),
    )
    ui.write(`Boundary rate:        ${boundary.boundaryCoins.toString()} / ${boundary.boundaryTokens.toString()}`)
    ui.write(`Rise minimum:         ${String(boundary.riseMin)} parts per million`)
    if (state.halted || state.falling) {
        ui.write('The Jackpot is halted or the rate-fell flag is up: the poke stores the rate but makes no boundary.')
    }

    const value = await askAmount(provider, 'Enter the GRAM to send', amount(fees.poke))
    if (value < fees.poke) {
        throw new Error(`The poke needs at least ${amount(fees.poke)} GRAM`)
    }

    const via = await confirmSend(provider, 'Poke the Jackpot', jackpot.address, value, [], { allowBody: false })
    if (via == null) {
        return
    }

    await jackpot.sendPoke(via, { value })

    done(ui, via)
}
