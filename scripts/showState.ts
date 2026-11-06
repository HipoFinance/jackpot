import { NetworkProvider } from '@ton/blueprint'
import { DrawState } from '../wrappers/Jackpot'
import { amount, openJackpot, readPool } from './lib/common'

// Read-only: prints every getter of the Jackpot in readable units. Sends nothing.
export async function run(provider: NetworkProvider) {
    const jackpot = await openJackpot(provider)

    // One getter at a time: a keyless toncenter rate-limits parallel reads (as in the Hipo contract repo).
    const version = await jackpot.getStorageVersion()
    const state = await jackpot.getJackpotState()
    const boundary = await jackpot.getBoundary()
    const retirement = await jackpot.getRetirement()
    const draw = await jackpot.getDrawState()
    const quote = await jackpot.getQuote()
    const fees = await jackpot.getJackpotFees()
    const addresses = await jackpot.getAddresses()
    const balance = await jackpot.getBalance()
    const pool = await readPool(provider, jackpot, false)
    const [quoteCoins, quoteTokens] = quote
    const free = state.heldTokens - state.reservedTokens

    console.info()
    console.info('JACKPOT %s', jackpot.address.toString())
    console.info('Storage version:       %s', String(version))
    console.info('GRAM balance:          %s GRAM', amount(balance))
    console.info('Halted:                %s', String(state.halted))
    console.info('Rate fell (flag):      %s', String(state.falling))

    console.info()
    console.info('COUNTERS')
    console.info('held hGRAM (T):       %s hGRAM', amount(state.heldTokens))
    console.info('wallet hGRAM (W):     %s hGRAM', amount(pool.wallet))
    console.info('untracked (W - T):    %s hGRAM (reaches no one until return_tokens)', amount(pool.outside))
    console.info('incoming (in T):      %s hGRAM, deposits not yet booked', amount(state.incomingTokens))
    console.info('reserved (in T):      %s hGRAM, prizes of the open draw and burn owed', amount(state.reservedTokens))
    console.info('free (T - reserved):  %s hGRAM', amount(free))
    console.info('principal owed:        %s GRAM', amount(state.principal))
    console.info('tickets:              %s (jGRAM supply, equal to principal)', amount(state.tickets))
    console.info('unstaking:            %s hGRAM', amount(state.unstakingTokens))
    console.info('next position:     %s', state.nextPosition.toString())
    console.info('tag (snapshots):       %s', state.tag.toString())
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

    console.info()
    console.info('BOUNDARY')
    console.info('Last boundary:         %s', boundary.lastBoundary === 0 ? '-' : timeString(boundary.lastBoundary))
    console.info(
        'Boundary rate:         %s GRAM / %s hGRAM',
        amount(boundary.boundaryCoins),
        amount(boundary.boundaryTokens),
    )
    console.info('Rise minimum:          %s parts per million', String(boundary.riseMin))
    console.info('Minimum gap:           %s seconds', String(boundary.minGap))
    console.info(
        'Pending minimum gap:   %s',
        boundary.nextMinGap === 0 ? '-' : `${String(boundary.nextMinGap)} seconds, from the next boundary`,
    )
    console.info('Earliest next:         %s', timeString(boundary.earliestNextBoundary))
    console.info('drand round (last + D): %s', boundary.drandRound.toString())

    console.info()
    console.info('RETIREMENT')
    console.info('Retired:               %s', String(retirement.retired))
    console.info('Successor:             %s', retirement.successor?.toString() ?? '-')
    console.info('Successor deposit fee: %s GRAM', amount(retirement.successorDepositFee))

    console.info()
    console.info('DRAW')
    console.info('State:                 %s', drawStateName(draw.state))
    console.info('Snapshot tag:          %s', draw.tag.toString())
    console.info('Snapshot tickets:      %s', amount(draw.snapshotTickets))
    console.info('drand round:           %s', draw.round.toString())
    console.info('Masterchain block hash: %s', draw.mcHash === 0n ? '-' : draw.mcHash.toString(16))
    console.info('Seed:                  %s', draw.seed === 0n ? '-' : draw.seed.toString(16))
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
    console.info('deposit (forward amount): %s GRAM', amount(fees.deposit))
    console.info('withdraw:              %s GRAM', amount(fees.withdraw))
    console.info('submit_randomness:     %s GRAM', amount(fees.submit))
    console.info('poke:                  %s GRAM', amount(fees.poke))
    console.info('w (comment withdraw):  %s GRAM', amount(fees.commentWithdraw))
    console.info('refill:                %s GRAM', amount(fees.refill))
    console.info('sweep:                 %s GRAM', amount(fees.sweep))
    console.info('return_tokens:         %s GRAM', amount(fees.return))
    console.info('unstake:               %s GRAM', amount(fees.unstake))
    console.info('draw budget:           %s GRAM (the most one draw spends from the float)', amount(fees.drawBudget))
    console.info('float low / high:      %s / %s GRAM', amount(fees.floatLow), amount(fees.floatHigh))
    console.info('wallet / node storage: %s / %s GRAM', amount(fees.walletStorage), amount(fees.nodeStorage))
    if (balance < fees.floatLow) {
        console.info('WARNING: the float is below its low mark; send "refill" (scripts/refill.ts) or top it up')
    }

    console.info()
    console.info('ADDRESSES')
    console.info('Treasury:              %s', addresses.treasury.toString())
    console.info('Parent:                %s', addresses.parent.toString())
    console.info('hGRAM wallet:          %s', addresses.wallet.toString())
    console.info('Burner:                %s', addresses.burner.toString())
    console.info('Governor:              %s', addresses.governor.toString())
    console.info('Halter:                %s', addresses.halter.toString())
    console.info('Hipo wallet code hash:  %s', addresses.walletCode.hash().toString('hex'))
    console.info('jGRAM wallet code hash: %s', addresses.jettonWalletCode.hash().toString('hex'))
    console.info('Node code hash:        %s', addresses.nodeCode.hash().toString('hex'))
}

function drawStateName(state: number) {
    return (Object.keys(DrawState) as (keyof typeof DrawState)[]).find((k) => DrawState[k] === state) ?? String(state)
}

// Bit i of the mask is set while slot i is open: 7 is "0,1,2", 0 is "none".
function openSlotList(mask: number) {
    const open = [0, 1, 2].filter((i) => (mask >> i) & 1)
    return open.length === 0 ? 'none' : open.join(',')
}

function timeString(unix: number) {
    return `${String(unix)} (${new Date(unix * 1000).toISOString()})`
}
