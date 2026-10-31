import { NetworkProvider } from '@ton/blueprint'
import {
    amount,
    askAmount,
    askInteger,
    askVerifyOnly,
    conclude,
    confirmSend,
    done,
    openJackpot,
    payoutKindName,
    printPool,
    readPool,
    readWalletAddress,
    verifyBouncedReceive,
    warnIfNotRole,
} from './lib/common'

// Closes a payout whose second hop failed: the recipient's wallet bounced the transfer after the Jackpot's
// wallet had sent it. The amount goes back into T and O, so the tokens must really be in the wallet outside T.
// A success gas_excess that never arrived is NOT evidence of a failure (Hipo sends it with ignore_errors), and
// settling a payout that did arrive would pay the owner twice. The proof is the aborted receive_tokens at the
// recipient's wallet, whose transaction hash this script asks for and checks on chain.
//
// The check is against W - T alone: the payout being settled is itself the record that draws on it. Answer
// "v" at the first prompt to run the checks and send nothing (for signers, just before signing).
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const verifyOnly = await askVerifyOnly(provider)
    const jackpot = await openJackpot(provider)

    const pool = await readPool(provider, jackpot)
    printPool(ui, pool)

    const target = await askInteger(provider, 'Enter the query id of the payout to close')
    const record = pool.books.payouts.get(target)
    if (record == null) {
        conclude(ui, [`There is no open payout ${target.toString()}`], verifyOnly)
        return
    }

    const addresses = await jackpot.getAddresses()
    const recipientWallet = await readWalletAddress(provider, addresses.parent, record.recipient)
    ui.write(`\nThe recipient's hGRAM wallet is ${recipientWallet.toString()}.`)
    ui.write(
        "Find the aborted receive_tokens there, sent by the Jackpot's wallet with this query id. A missing success\n" +
            'gas_excess is not evidence: Hipo sends it with ignore_errors, and the payout may have arrived.',
    )
    const hash = (await ui.input('Enter the hash of that bounced receive_tokens transaction')).trim()

    const problems: string[] = []
    if (record.amount > pool.outside) {
        problems.push(`the payout is ${amount(record.amount)} hGRAM, but only ${amount(pool.outside)} sits outside T`)
    }
    const proof = await verifyBouncedReceive(provider, hash, recipientWallet, addresses.wallet, target)
    problems.push(...proof.map((p) => `the transaction does not prove a failed payout: ${p}`))
    if (!conclude(ui, problems, verifyOnly)) {
        return
    }
    ui.write('The transaction checks out on chain (confirm it on an explorer as well).')

    await warnIfNotRole(provider, jackpot, 'governor')
    const value = await askAmount(provider, 'Enter the GRAM to send', '0.1')

    const via = await confirmSend(
        provider,
        'Settle a failed payout',
        jackpot.address,
        value,
        [
            `query id:    ${target.toString()}`,
            `kind:        ${payoutKindName(record.kind)}`,
            `recipient:   ${record.recipient.toString()}`,
            `amount:      ${amount(record.amount)} hGRAM`,
            `proof:       ${hash}`,
        ],
        {
            bodyNotes: [
                `checked against W - T = ${amount(pool.outside)} hGRAM`,
                `this order consumes ${amount(record.amount)} hGRAM of it`,
                'valid only if no other recovery order is pending: rerun this script with "v" just before signing',
            ],
        },
    )
    if (via == null) {
        return
    }

    await jackpot.sendSettleFailedPayout(via, { value, target })

    done(ui, via)
}
