import { NetworkProvider } from '@ton/blueprint'
import {
    amount,
    askAmount,
    askInteger,
    confirmSend,
    openJackpot,
    printPool,
    readPool,
    warnIfNotRole,
} from './lib/common'

// Books a stuck pending GRAM deposit: the mint notification never arrived (Hipo sends it with
// ignore_errors), so the tokens are in the Jackpot's wallet but were never counted. Book only tokens that
// actually sit in the wallet outside T, never more: with instant_mint off a record can match someone else's
// bill. The Jackpot books at most the record's cap, and only for a record older than two validation rounds.
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const jackpot = await openJackpot(provider)

    const pool = await readPool(provider, jackpot)
    printPool(ui, pool)

    const target = await askInteger(provider, 'Enter the query id of the pending record')
    const record = pool.books.pending.get(target)
    if (record == null) {
        throw new Error(`There is no pending record ${target.toString()}`)
    }
    const tokens = await askAmount(provider, 'Enter the hGRAM the mint gave, as found on chain')
    const booked = tokens < record.cap ? tokens : record.cap

    const rounds = await askInteger(provider, 'Enter validators_elected_for in seconds (config parameter 15)', '65536')
    const age = BigInt(Math.floor(Date.now() / 1000) - record.createdAt)
    const old = age >= 2n * rounds
    if (!old) {
        throw new Error(`The record is ${age.toString()} s old, under two rounds (${(2n * rounds).toString()} s)`)
    }
    if (booked > pool.outside) {
        throw new Error(`Booking ${amount(booked)} hGRAM, but only ${amount(pool.outside)} sits outside T`)
    }

    await warnIfNotRole(provider, jackpot, 'governor')
    const value = await askAmount(provider, 'Enter the GRAM to send', '0.5')

    const via = await confirmSend(provider, 'Book a stuck pending deposit', jackpot.address, value, [
        `query id:    ${target.toString()}`,
        `owner:       ${record.owner.toString()}`,
        `coins:       ${amount(record.coins)} GRAM`,
        `cap:         ${amount(record.cap)} hGRAM`,
        `booked:      ${amount(booked)} hGRAM (min of the tokens and the cap)`,
        `age:         ${age.toString()} s, at least 2 x ${rounds.toString()} s`,
        `outside T:   ${amount(pool.outside)} hGRAM`,
    ])
    if (via == null) {
        return
    }

    await jackpot.sendResolvePending(via, { value, target, tokens })

    ui.write('Done')
}
