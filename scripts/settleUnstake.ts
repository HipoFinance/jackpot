import { NetworkProvider } from '@ton/blueprint'
import {
    amount,
    askAmount,
    askVerifyOnly,
    conclude,
    confirmSend,
    done,
    openJackpot,
    printPool,
    readPool,
    warnIfNotRole,
} from './lib/common'

// Settles the Jackpot's count of hGRAM sent to unstake (U) when it is stuck, which also blocks the sweep. Only the
// governor may. Two cases. After Hipo rolled the unstake back (credit): U falls and T rises by the amount. When the
// unstake's GRAM in fact arrived but its notification was missed (no credit): U falls and nothing else changes. Hipo's rollback puts the hGRAM back in the Jackpot's wallet but
// its only signal can be forged, so the Jackpot ignores it and the tokens wait outside T. Check on chain that
// the rollback happened (the unstake's transactions at the treasury and the wallet) before running this. The
// amount may not exceed U, nor the hGRAM outside T (a prize or burn still on its way also shows there, so wait until none is). Answer "v" at the first prompt to
// run the checks and send nothing (for signers, just before signing).
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const verifyOnly = await askVerifyOnly(provider)
    const jackpot = await openJackpot(provider)

    const state = await jackpot.getJackpotState()
    ui.write(`U (hGRAM sent to unstake, not reported back): ${amount(state.unstakingTokens)} hGRAM`)

    const pool = await readPool(provider, jackpot)
    printPool(ui, pool)
    const available = pool.outside
    ui.write(`Available for this settlement: ${amount(available)} hGRAM (W - T)`)

    const choice = await ui.choose(
        'What happened to the unstake',
        ['rolled back: the hGRAM is back in the wallet (credit)', 'paid: the GRAM arrived, the notification was missed (no credit)'],
        (x) => x,
    )
    const credit = choice.startsWith('rolled back')
    const tokens = await askAmount(provider, 'Enter the hGRAM to settle')

    const problems: string[] = []
    if (tokens <= 0n || tokens > state.unstakingTokens) {
        problems.push(`settling ${amount(tokens)} hGRAM, but U is ${amount(state.unstakingTokens)} hGRAM`)
    }
    if (credit && tokens > available) {
        problems.push(
            `settling ${amount(tokens)} hGRAM, but only ${amount(available)} hGRAM is outside T: the rollback has not returned it`,
        )
    }
    if (!conclude(ui, problems, verifyOnly)) {
        return
    }

    await warnIfNotRole(provider, jackpot, 'governor')
    const value = await askAmount(provider, 'Enter the GRAM to send', '0.1')

    const via = await confirmSend(
        provider,
        credit ? 'Settle a rolled-back unstake' : 'Settle a paid unstake without credit',
        jackpot.address,
        value,
        [
            `amount:      ${amount(tokens)} hGRAM (U ${amount(state.unstakingTokens)} -> ${amount(state.unstakingTokens - tokens)})`,
            `credit:      ${String(credit)} (T ${credit ? 'rises' : 'does not change'})`,
        ],
        {
            bodyNotes: [
                `checked against W - T = ${amount(pool.outside)} hGRAM`,
                `this order consumes ${amount(tokens)} hGRAM of it`,
                'valid only if no other recovery order is pending: rerun this script with "v" just before signing',
            ],
        },
    )
    if (via == null) {
        return
    }

    await jackpot.sendSettleUnstake(via, { value, amount: tokens, credit })

    done(ui, via)
}
