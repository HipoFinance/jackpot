import { NetworkProvider } from '@ton/blueprint'
import { beginCell } from '@ton/core'
import { buildWitness, currentRound, fetchRound, roundTime } from '../wrappers/drand'
import { DrawState, submitCutoff } from '../wrappers/Jackpot'
import { amount, askAmount, confirmSend, openJackpot, done } from './lib/common'

// Sends the drand round the open draw waits for, between its publication and the cut-off before the earliest next
// boundary. Anyone may run this; the contract checks the signature
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

    const earliestNext = (await jackpot.getBoundary()).earliestNextBoundary
    if (now >= earliestNext - submitCutoff) {
        ui.write(
            `Too late: submits close ${String(submitCutoff)} seconds before the earliest next boundary. The draw will skip if a boundary comes.`,
        )
        return
    }
    if ((await jackpot.getBalance()) < (await jackpot.getJackpotFees()).drawBudget) {
        ui.write('The float is below the draw budget, so the Jackpot refuses a submit. Run refill first.')
        return
    }

    const fetched = await fetchRound(round)
    const signature = beginCell().storeBuffer(fetched.signature).endCell()
    const witness = buildWitness(round)

    const fees = await jackpot.getJackpotFees()
    const value = await askAmount(provider, 'Enter the GRAM to send', amount(fees.submit))

    const via = await confirmSend(
        provider,
        'Submit the drand randomness',
        jackpot.address,
        value,
        [
            `snapshot:    tag ${draw.tag.toString()}, ${amount(draw.snapshotTickets)} tickets`,
            `round:       ${String(round)}`,
            `signature:   ${fetched.signature.toString('hex')}`,
            `randomness:  ${fetched.randomness.toString('hex')} (sha256 of the signature)`,
        ],
        { allowBody: false },
    )
    if (via == null) {
        return
    }

    await jackpot.sendSubmitRandomness(via, { value, signature, witness })

    done(ui, via)
}
