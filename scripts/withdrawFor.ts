import { NetworkProvider } from '@ton/blueprint'
import { Address, toNano } from '@ton/core'
import { maxWithdrawFor } from '../wrappers/Jackpot'
import { amount, askAmount, confirmSend, openJackpot, warnIfNotRole, done } from './lib/common'

// Withdraws everything for a batch of owners of a retired Jackpot: the Jackpot burns each owner's jGRAM balance, and
// the hGRAM goes to the owner, or to the successor as a deposit for the owner. Only the governor may. A batch has at
// most 100 owners; run the script again for the next. The governor pays: each owner needs the comment-withdraw fee
// (plus the successor's deposit fee for a move), what is above comes back, and what an owner's wallet does not
// spend goes to that owner.
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const jackpot = await openJackpot(provider)

    const retirement = await jackpot.getRetirement()
    if (!retirement.retired) {
        throw new Error('Retire the Jackpot first (retire)')
    }
    const fees = await jackpot.getJackpotFees()

    const typed = await ui.input("Enter the owners' friendly addresses, separated by commas or spaces (up to 100)")
    const owners = typed
        .split(/[\s,]+/)
        .filter((x) => x !== '')
        .map((x) => Address.parse(x))
    if (owners.length === 0) {
        throw new Error('At least one owner is needed')
    }
    if (owners.length > maxWithdrawFor) {
        throw new Error(`At most ${String(maxWithdrawFor)} owners in one batch, got ${String(owners.length)}`)
    }
    for (const owner of owners) {
        if (owner.workChain !== 0) {
            throw new Error(`${owner.toString()} is not a basechain address`)
        }
    }
    if (new Set(owners.map((o) => o.toRawString())).size !== owners.length) {
        throw new Error('An owner is listed twice')
    }

    let toSuccessor = false
    if (retirement.successor != null) {
        ui.write(
            `Successor: ${retirement.successor.toString()} (deposit fee ${amount(retirement.successorDepositFee)} GRAM)`,
        )
        toSuccessor = (await ui.input('Move them to the successor? [yN]')).trim().toLowerCase() === 'y'
    }

    // what each owner's wallet is sent; the Jackpot's own gas is priced on what it has used, so add a margin
    const parts = await jackpot.getFeeParts()
    const formula = parts.wValue + (toSuccessor ? retirement.successorDepositFee : 0n)
    // a wallet in storage debt above about 0.07 GRAM needs more than the formula; a larger value per owner empties it
    const answer = (await ui.input(`Value per owner in GRAM (empty: the formula, ${amount(formula)})`)).trim()
    const per = answer === '' ? formula : toNano(answer)
    if (per < formula) {
        throw new Error(`The value per owner is below the formula's ${amount(formula)} GRAM. Nothing sent.`)
    }
    const gasEach = fees.commentWithdraw - parts.wValue
    const needed = per * BigInt(owners.length) + gasEach * BigInt(owners.length + 2)
    ui.write(`Owners:   ${String(owners.length)}`)
    ui.write(`Per owner: ${amount(per)} GRAM; at least ${amount(needed)} GRAM in all`)

    await warnIfNotRole(provider, jackpot, 'governor')
    const value = await askAmount(provider, 'Enter the GRAM to send', amount(needed))
    if (value < needed) {
        throw new Error(`The batch needs at least ${amount(needed)} GRAM`)
    }

    const via = await confirmSend(provider, 'Withdraw for a batch of owners', jackpot.address, value, [
        `owners:       ${String(owners.length)}`,
        `per owner:    ${amount(per)} GRAM`,
        `paid to:      ${toSuccessor ? 'the successor, as a deposit for each owner' : 'each owner'}`,
        ...owners.map((o) => `  ${o.toString()}`),
    ])
    if (via == null) {
        return
    }

    await jackpot.sendWithdrawFor(via, { value, toSuccessor, owners, valuePerOwner: per })

    done(ui, via)
}
