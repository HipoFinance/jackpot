import { NetworkProvider } from '@ton/blueprint'
import { beginCell } from '@ton/core'
import { buildWitness, currentRound, fetchRound, roundTime } from '../wrappers/drand'
import { DrawState } from '../wrappers/Jackpot'
import { amount, askAmount, confirmSend, openJackpot } from './lib/common'

// Sends the drand round the running draw waits for. Anyone may run this; the contract checks the signature
// on chain, and a wrong signature or witness only costs the sender the gas.
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const jackpot = await openJackpot(provider)

    const draw = await jackpot.getDrawState()
    if (draw.state !== DrawState.waiting) {
        ui.write(`The draw is not waiting for randomness (state ${String(draw.state)}). Nothing to do.`)
        return
    }

    const round = Number(draw.round)
    const now = Math.floor(Date.now() / 1000)
    ui.write(`The draw waits for drand round ${String(round)}, published at unix time ${String(roundTime(round))}.`)
    if (currentRound(now) < round) {
        ui.write(`Not yet: ${String(roundTime(round) - now)} seconds to go. Run this again then.`)
        return
    }

    const fetched = await fetchRound(round)
    const signature = beginCell().storeBuffer(fetched.signature).endCell()
    const witness = buildWitness(round)

    const fees = await jackpot.getJackpotFees()
    const value = await askAmount(provider, 'Enter the GRAM to send', amount(fees.submitRandomness))

    const via = await confirmSend(provider, 'Submit the drand randomness', jackpot.address, value, [
        `draw id:     ${draw.drawId.toString()}`,
        `round:       ${String(round)}`,
        `signature:   ${fetched.signature.toString('hex')}`,
        `randomness:  ${fetched.randomness.toString('hex')} (sha256 of the signature)`,
    ])
    if (via == null) {
        return
    }

    await jackpot.sendSubmitRandomness(via, { value, signature, witness })

    ui.write('Done')
}
