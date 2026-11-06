import { NetworkProvider } from '@ton/blueprint'
import { DrawState } from '../wrappers/Jackpot'
import { amount, askAmount, confirmSend, done, openJackpot } from './lib/common'

// Ends a retired Jackpot. Anyone may send it, with the sweep fee and the funding of the close (get_close_cost: the
// cascade's cost at current prices times the margin). The Jackpot accepts it only when it is retired, owes nothing
// (principal 0), has no deposit on its way, no unstake out and no draw resolving. It ends a waiting draw, sends all
// its hGRAM to the burner, and starts closing the tree of nodes from the top on the sender's value: the Jackpot's own
// balance does not pay for it. What the message does not spend comes back to the sender, and what the nodes do not
// spend comes back to the Jackpot with their reserves. If a node is left standing, the governor restarts the close
// there with closeSubtree.
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const jackpot = await openJackpot(provider)

    const retirement = await jackpot.getRetirement()
    const state = await jackpot.getJackpotState()
    const draw = await jackpot.getDrawState()
    const fees = await jackpot.getJackpotFees()
    ui.write(`Retired:           ${String(retirement.retired)}`)
    ui.write(`Principal:         ${amount(state.principal)} GRAM`)
    ui.write(`Incoming tokens:   ${amount(state.incomingTokens)} hGRAM`)
    ui.write(`Unstaking tokens:  ${amount(state.unstakingTokens)} hGRAM`)
    ui.write(`Held tokens:       ${amount(state.heldTokens)} hGRAM (go to the burner)`)
    ui.write(`Draw state:        ${String(draw.state)}`)

    const problems: string[] = []
    if (!retirement.retired) problems.push('the Jackpot is not retired')
    if (state.principal !== 0n) problems.push('players are still owed principal')
    if (state.incomingTokens !== 0n) problems.push('a deposit is still on its way')
    if (state.unstakingTokens !== 0n) problems.push('an unstake is out (settleUnstake clears a stuck one)')
    if (draw.state === DrawState.resolving) problems.push('a draw is resolving')
    if (problems.length > 0) {
        ui.write(`The Jackpot would refuse this message: ${problems.join('; ')}. Nothing to do.`)
        return
    }

    const closeCost = await jackpot.getCloseCost()
    const need = fees.sweep + closeCost
    ui.write(`The close of the tree costs ${amount(closeCost)} GRAM (${state.nextPosition.toString()} positions)`)
    const value = await askAmount(provider, 'Enter the GRAM to send', amount(need))
    if (value < need) {
        throw new Error(`The sweep needs at least ${amount(need)} GRAM`)
    }

    const via = await confirmSend(provider, 'Sweep the retired Jackpot', jackpot.address, value, [], {
        allowBody: false,
    })
    if (via == null) {
        return
    }

    await jackpot.sendSweep(via, { value })

    done(ui, via)
}
