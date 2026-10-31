import { NetworkProvider } from '@ton/blueprint'
import { DrawState, QuoteKind } from '../wrappers/Jackpot'
import { amount, openJackpot, payoutKindName, readPool } from './lib/common'

// Read-only: prints every getter of the Jackpot in readable units. Sends nothing.
export async function run(provider: NetworkProvider) {
    const jackpot = await openJackpot(provider)

    // One getter at a time: a keyless toncenter rate-limits parallel reads (as in the Hipo contract repo).
    const version = await jackpot.getStorageVersion()
    const state = await jackpot.getJackpotState()
    const draw = await jackpot.getDrawState()
    const quote = await jackpot.getQuote()
    const fees = await jackpot.getJackpotFees()
    const addresses = await jackpot.getAddresses()
    const books = await jackpot.getBooks()
    const balance = await jackpot.getBalance()
    const pool = await readPool(provider, jackpot, false)
    const [quoteCoins, quoteTokens] = quote
    const free = state.totalTokens - state.inFlight - state.setAside

    console.info()
    console.info('JACKPOT %s', jackpot.address.toString())
    console.info('Storage version:       %s', String(version))
    console.info('GRAM balance:          %s GRAM', amount(balance))
    console.info('Halted:                %s', String(state.halted))
    console.info('Rate fell (flag):      %s', String(state.falling))

    console.info()
    console.info('COUNTERS')
    console.info('T  hGRAM held:         %s hGRAM', amount(state.totalTokens))
    console.info('W  hGRAM wallet:        %s hGRAM', amount(pool.wallet))
    console.info('W - T (outside T):   %s hGRAM', amount(pool.outside))
    console.info('I  in flight:          %s hGRAM', amount(state.inFlight))
    console.info('O  set aside:          %s hGRAM', amount(state.setAside))
    console.info('F  free (T - I - O):   %s hGRAM', amount(free))
    console.info('P  principal owed:     %s GRAM', amount(state.principal))
    console.info('n  next booking:       %s', state.nextBooking.toString())
    console.info('K_next:                %s', state.kNext.toString())
    console.info('L_lo (b < K_next):     %s GRAM', amount(state.lLo))
    console.info('L_hi (b >= K_next):    %s GRAM', amount(state.lHi))
    console.info('Carried prizes:        %s hGRAM', amount(state.carried))
    console.info('Burn owed:             %s hGRAM', amount(state.burnOwed))
    console.info('Node float:            %s GRAM', amount(state.nodeFloat))

    console.info()
    console.info('QUOTE')
    console.info('total_coins:           %s GRAM', amount(quoteCoins))
    console.info('total_tokens:          %s hGRAM', amount(quoteTokens))
    if (quoteTokens > 0n && quoteCoins > 0n) {
        console.info('Rate:                  %s GRAM per hGRAM', (Number(quoteCoins) / Number(quoteTokens)).toFixed(9))
        const needed = (state.principal * quoteTokens + quoteCoins - 1n) / quoteCoins
        console.info('Kept for principal:    %s hGRAM', amount(needed))
        console.info('Pot now:               %s hGRAM', amount(free > needed ? free - needed : 0n))
    }
    console.info('Last start:            %s (round since, unix time)', state.lastRoundSince.toString())
    console.info('Rate at last start:    %s GRAM / %s hGRAM', amount(state.lastCoins), amount(state.lastTokens))

    console.info()
    console.info('DRAW')
    console.info('State:                 %s', drawStateName(draw.state))
    console.info('Draw id:               %s', draw.drawId.toString())
    console.info('Cutoff E:              %s bookings', draw.cutoff.toString())
    console.info('Eligible (draw_L):     %s GRAM', amount(draw.eligible))
    console.info('drand round:           %s', draw.round.toString())
    console.info('Seed:                  %s', draw.seed === 0n ? '-' : draw.seed.toString(16))
    console.info('Randomness stored at:  %s', draw.randomnessTime.toString())
    console.info('Prizes:                %s hGRAM', draw.prizes.map(amount).join(' / '))
    console.info('Open slots (bitmask):  %s', openSlotList(draw.openSlots))
    console.info('Attempts per slot:     %s', draw.attempts.join(' / '))
    if (draw.state === DrawState.resolving) {
        for (let slot = 0; slot < 3; slot++) {
            const position = await jackpot.getPosition(slot)
            console.info('Slot %s next position:  %s', String(slot), position < 0n ? '-' : position.toString())
        }
    }

    console.info()
    console.info('PARAMETERS')
    console.info('Burn share:            %s basis points', state.burnShare.toString())
    console.info('Smallest pot:          %s hGRAM', amount(state.minPot))
    console.info('Burn batch:            %s hGRAM', amount(state.burnBatch))
    console.info('Minimum deposit:       %s GRAM', amount(state.minDeposit))

    console.info()
    console.info('FEES (minimum value of each entry message)')
    console.info('deposit:               %s GRAM', amount(fees.deposit))
    console.info('hGRAM deposit:         %s GRAM', amount(fees.hgramDeposit))
    console.info('withdraw:              %s GRAM', amount(fees.withdraw))
    console.info('start_draw:            %s GRAM', amount(fees.startDraw))
    console.info('submit_randomness:     %s GRAM', amount(fees.submitRandomness))
    console.info('locate:                %s GRAM', amount(fees.locate))
    console.info('requote:               %s GRAM', amount(fees.requote))
    console.info('expire:                %s GRAM', amount(fees.expire))
    console.info('claim:                 %s GRAM', amount(fees.claim))
    console.info('attempt (surcharge basis): %s GRAM', amount(fees.attempt))

    console.info()
    console.info('ADDRESSES')
    console.info('Treasury:              %s', addresses.treasury.toString())
    console.info('Parent:                %s', addresses.parent.toString())
    console.info('hGRAM wallet:          %s', addresses.wallet.toString())
    console.info('Burner:                %s', addresses.burner.toString())
    console.info('Governor:              %s', addresses.governor.toString())
    console.info('Halter:                %s', addresses.halter.toString())
    console.info('Wallet code hash:      %s', addresses.walletCode.hash().toString('hex'))
    console.info('Range code hash:       %s', addresses.rangeCode.hash().toString('hex'))
    console.info('Node code hash:        %s', addresses.nodeCode.hash().toString('hex'))

    console.info()
    console.info('BOOKS')
    console.info('Pending deposits:      %s', String(books.pending.size))
    for (const [id, p] of books.pending) {
        console.info(
            '  query %s: %s sent %s GRAM (cap %s hGRAM) at %s',
            id.toString(),
            p.owner.toString(),
            amount(p.coins),
            amount(p.cap),
            String(p.createdAt),
        )
    }
    console.info('Open quote requests:   %s', String(books.quotes.size))
    for (const [id, q] of books.quotes) {
        console.info('  query %s: %s at %s', id.toString(), quoteKindName(q.kind), String(q.createdAt))
    }
    console.info('Payouts in flight:     %s', String(books.payouts.size))
    for (const [id, p] of books.payouts) {
        console.info(
            '  query %s: %s %s hGRAM to %s',
            id.toString(),
            payoutKindName(p.kind),
            amount(p.amount),
            p.recipient.toString(),
        )
    }
    console.info('Claimable balances:    %s', String(books.claimable.size))
    for (const [owner, c] of books.claimable) {
        console.info('  %s: prize %s, other %s hGRAM', owner, amount(c.prize), amount(c.other))
    }
}

function drawStateName(state: number) {
    return (Object.keys(DrawState) as (keyof typeof DrawState)[]).find((k) => DrawState[k] === state) ?? String(state)
}

function quoteKindName(kind: number) {
    return (Object.keys(QuoteKind) as (keyof typeof QuoteKind)[]).find((k) => QuoteKind[k] === kind) ?? String(kind)
}

// Bit i of the mask is set while slot i is open: 7 is "0,1,2", 0 is "none".
function openSlotList(mask: number) {
    const open = [0, 1, 2].filter((i) => (mask >> i) & 1)
    return open.length === 0 ? 'none' : open.join(',')
}
