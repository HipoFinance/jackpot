import { NetworkProvider } from '@ton/blueprint'
import { Sender } from '@ton/core'
import { amount, askAmount, askInteger, confirmSend, openJackpot, warnIfNotRole } from './lib/common'

// Sets one governor parameter: burn share, smallest pot, burn batch or minimum deposit. Run it again for
// the next one. The contract refuses a burn share above 2000 basis points and a minimum deposit below 1.
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const jackpot = await openJackpot(provider)

    const state = await jackpot.getJackpotState()
    ui.write(`Burn share:      ${state.burnShare.toString()} basis points`)
    ui.write(`Smallest pot:    ${amount(state.minPot)} hGRAM`)
    ui.write(`Burn batch:      ${amount(state.burnBatch)} hGRAM`)
    ui.write(`Minimum deposit: ${amount(state.minDeposit)} GRAM`)

    const names = ['burn share', 'smallest pot', 'burn batch', 'minimum deposit']
    const name = await ui.choose('Which parameter', names, (x) => x)

    let send: (via: Sender, value: bigint) => Promise<void>
    let description: string
    if (name === 'burn share') {
        const burnShare = await askInteger(provider, 'Enter the new burn share in basis points (0 to 2000)')
        if (burnShare > 2000n) {
            throw new Error('The burn share is at most 2000')
        }
        description = `burn share:  ${burnShare.toString()} basis points`
        send = (via, value) => jackpot.sendSetBurnShare(via, { value, burnShare })
    } else if (name === 'smallest pot') {
        const minPot = await askAmount(provider, 'Enter the new smallest pot in hGRAM')
        description = `smallest pot:  ${amount(minPot)} hGRAM`
        send = (via, value) => jackpot.sendSetMinPot(via, { value, minPot })
    } else if (name === 'burn batch') {
        const burnBatch = await askAmount(provider, 'Enter the new burn batch in hGRAM')
        description = `burn batch:  ${amount(burnBatch)} hGRAM`
        send = (via, value) => jackpot.sendSetBurnBatch(via, { value, burnBatch })
    } else {
        const minDeposit = await askAmount(provider, 'Enter the new minimum deposit in GRAM')
        if (minDeposit < 1n) {
            throw new Error('The minimum deposit is at least 1 nano-GRAM')
        }
        description = `minimum deposit:  ${amount(minDeposit)} GRAM`
        send = (via, value) => jackpot.sendSetMinDeposit(via, { value, minDeposit })
    }

    await warnIfNotRole(provider, jackpot, 'governor')
    const value = await askAmount(provider, 'Enter the GRAM to send', '0.1')

    const via = await confirmSend(provider, 'Set a parameter', jackpot.address, value, [description])
    if (via == null) {
        return
    }

    await send(via, value)

    ui.write('Done')
}
