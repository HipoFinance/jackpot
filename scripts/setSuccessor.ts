import { NetworkProvider } from '@ton/blueprint'
import { Address } from '@ton/core'
import { Jackpot } from '../wrappers/Jackpot'
import { amount, askAmount, confirmSend, openJackpot, warnIfNotRole, done } from './lib/common'

// Sets the successor of a retired Jackpot: where a withdrawal with "to successor" is sent, as a deposit for its
// owner. successor_deposit_fee is the GRAM a move sends along for that deposit. The script refuses a fee below
// the successor's deposit fee + return fee + payload fee, read from the successor's get_jackpot_fees, because the
// successor would refuse the deposit and return the hGRAM. Enter nothing for the address to clear the successor.
// Only the governor may, and only after retire.
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const jackpot = await openJackpot(provider)

    const retirement = await jackpot.getRetirement()
    ui.write(`Retired:        ${String(retirement.retired)}`)
    ui.write(`Successor now:  ${retirement.successor?.toString() ?? 'none'}`)
    ui.write(`Deposit fee:    ${amount(retirement.successorDepositFee)} GRAM`)
    if (!retirement.retired) {
        throw new Error('Retire the Jackpot first (retire)')
    }

    const answer = (await ui.input('Enter the friendly address of the successor (empty: clear it)')).trim()
    let successor: Address | null = null
    let depositFee = 0n
    if (answer !== '') {
        successor = Address.parse(answer)
        if (successor.workChain !== 0) {
            throw new Error('The successor must be a basechain address')
        }
        if (successor.equals(jackpot.address)) {
            throw new Error('The successor cannot be this Jackpot')
        }
        const fees = await provider.open(Jackpot.createFromAddress(successor)).getJackpotFees()
        // at least 3 times the successor's deposit fee: its price may rise before the move is made
        const needed = 3n * fees.deposit + fees.return + fees.payload
        ui.write(
            `The successor's fees: 3 x deposit ${amount(fees.deposit)} + return ${amount(fees.return)} + payload ` +
                `${amount(fees.payload)} = ${amount(needed)} GRAM`,
        )
        depositFee = await askAmount(provider, 'Enter the deposit fee a move carries, in GRAM', amount(needed))
        if (depositFee < needed) {
            throw new Error(`The deposit fee is below the successor's ${amount(needed)} GRAM. Nothing sent.`)
        }
    }

    await warnIfNotRole(provider, jackpot, 'governor')
    const value = await askAmount(provider, 'Enter the GRAM to send', '0.1')

    const via = await confirmSend(provider, 'Set the successor', jackpot.address, value, [
        `successor:    ${successor?.toString() ?? 'none'}`,
        `deposit fee:  ${amount(depositFee)} GRAM per move`,
    ])
    if (via == null) {
        return
    }

    await jackpot.sendSetSuccessor(via, { value, successor, depositFee })

    done(ui, via)
}
