import { NetworkProvider } from '@ton/blueprint'
import { DrawState } from '../wrappers/Jackpot'
import { amount, askAmount, confirmSend, done, openJackpot } from './lib/common'

// Asks the Jackpot to unstake some of the pot to refill its float. Anyone may send it. The Jackpot accepts it
// only while its float is below the draw budget, no draw is resolving, and no unstake is waiting (or the last
// was over 7 days ago). It asks for no quote: the unstake is sized at the stored rate. What the message does not
// spend comes back.
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const jackpot = await openJackpot(provider)

    const state = await jackpot.getJackpotState()
    const draw = await jackpot.getDrawState()
    const fees = await jackpot.getJackpotFees()
    const balance = await jackpot.getBalance()
    ui.write(
        `Float:          ${amount(balance)} GRAM (draw budget ${amount(fees.drawBudget)}, low mark ${amount(fees.floatLow)})`,
    )
    ui.write(`U:              ${amount(state.unstakingTokens)} hGRAM`)

    if (balance >= fees.drawBudget) {
        ui.write('The float covers the draw budget. The Jackpot would refuse this message. Nothing to do.')
        return
    }
    if (draw.state === DrawState.resolving) {
        ui.write('A draw is resolving. Run this again when it has ended.')
        return
    }
    if (state.unstakingTokens > 0n) {
        ui.write(
            'An unstake is still waiting. The Jackpot refuses this message unless the last unstake was over 7 days ago.',
        )
    }
    if (state.falling) {
        ui.write('The rate-fell flag is up: the Jackpot unstakes nothing and returns the rest.')
    }

    const value = await askAmount(provider, 'Enter the GRAM to send', amount(fees.refill))
    if (value < fees.refill) {
        throw new Error(`The refill needs at least ${amount(fees.refill)} GRAM`)
    }

    const via = await confirmSend(provider, 'Refill the float', jackpot.address, value, [], { allowBody: false })
    if (via == null) {
        return
    }

    await jackpot.sendRefill(via, { value })

    done(ui, via)
}
