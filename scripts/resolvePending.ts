import { NetworkProvider } from '@ton/blueprint'
import {
    amount,
    askAmount,
    askInteger,
    askVerifyOnly,
    availableOutside,
    conclude,
    confirmSend,
    done,
    openJackpot,
    printPool,
    readPool,
    warnIfNotRole,
} from './lib/common'

// Books a stuck pending GRAM deposit: the mint notification never arrived (Hipo sends it with
// ignore_errors), so the tokens are in the Jackpot's wallet but were never counted. Book only tokens that
// actually sit in the wallet outside T, never more: with instant_mint off a record can match someone else's
// bill. The Jackpot books at most the record's cap, and only for a record older than two validation rounds.
//
// The tokens are checked against W - T less the open payouts, one pool for every recovery. Answer "v" at the
// first prompt to run the checks and send nothing (signers do this just before signing).
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const verifyOnly = await askVerifyOnly(provider)
    const jackpot = await openJackpot(provider)

    const pool = await readPool(provider, jackpot)
    printPool(ui, pool)
    const { available, excluded } = await availableOutside(provider, pool)
    ui.write(`Available for this recovery: ${amount(available)} hGRAM (W - T less open payouts not excluded)`)

    const target = await askInteger(provider, 'Enter the query id of the pending record')
    const record = pool.books.pending.get(target)
    if (record == null) {
        conclude(ui, [`There is no pending record ${target.toString()}`], verifyOnly)
        return
    }
    const tokens = await askAmount(provider, 'Enter the hGRAM the mint gave, as found on chain')
    const booked = tokens < record.cap ? tokens : record.cap

    const rounds = await askInteger(provider, 'Enter validators_elected_for in seconds (config parameter 15)', '65536')
    const age = BigInt(Math.floor(Date.now() / 1000) - record.createdAt)

    const problems: string[] = []
    if (age < 2n * rounds) {
        problems.push(`the record is ${age.toString()} s old, under two rounds (${(2n * rounds).toString()} s)`)
    }
    if (booked > available) {
        problems.push(`booking ${amount(booked)} hGRAM, but only ${amount(available)} hGRAM is available outside T`)
    }
    if (!conclude(ui, problems, verifyOnly)) {
        return
    }

    await warnIfNotRole(provider, jackpot, 'governor')
    const value = await askAmount(provider, 'Enter the GRAM to send', '0.5')

    const via = await confirmSend(
        provider,
        'Book a stuck pending deposit',
        jackpot.address,
        value,
        [
            `query id:    ${target.toString()}`,
            `owner:       ${record.owner.toString()}`,
            `coins:       ${amount(record.coins)} GRAM`,
            `cap:         ${amount(record.cap)} hGRAM`,
            `booked:      ${amount(booked)} hGRAM (min of the tokens and the cap)`,
            `age:         ${age.toString()} s, at least 2 x ${rounds.toString()} s`,
            `outside T:   ${amount(pool.outside)} hGRAM, ${amount(available)} hGRAM available`,
        ],
        {
            bodyNotes: [
                `checked against W - T = ${amount(pool.outside)} hGRAM, ${amount(available)} hGRAM after open payouts` +
                    (excluded.length > 0 ? ` (excluded payouts: ${excluded.join(', ')})` : ''),
                `this order consumes ${amount(booked)} hGRAM of it`,
                'valid only if no other recovery order is pending: rerun this script with "v" just before signing',
            ],
        },
    )
    if (via == null) {
        return
    }

    await jackpot.sendResolvePending(via, { value, target, tokens })

    done(ui, via)
}
