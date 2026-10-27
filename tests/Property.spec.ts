// The property test of the spec's first two acceptance criteria. Random sequences of GRAM and hGRAM
// deposits, partial and full withdrawals, rate rises, validation-round changes and full draws, against the
// real Hipo contracts. After every transaction on the Jackpot or its hGRAM wallet: F·TC ≥ P·TT, F ≥ 0, and
// the real wallet holds at least T. Every slot's answer comes from the range holding the k(i, j)-th eligible
// live ticket, recomputed here from the logs as of the draw's start, while players withdraw in the draw's
// window; after each draw every node's committed less held equals the live tickets below it, and
// L_lo + L_hi all of them. At the end everyone withdraws, and each player's hGRAM must be worth at
// least their principal, less 1 nano-hGRAM per withdrawal; nothing may be left stranded or unconfirmed.
//
// It runs PROPERTY_SEQUENCES sequences (default 10,000) or until PROPERTY_SECONDS have passed (default 540),
// whichever comes first, and prints how many ran. Each sequence has its own seed, PROPERTY_SEED + i; a
// failure prints that seed and the operations, and PROPERTY_SEED=<seed> PROPERTY_SEQUENCES=1 replays it.
import { SequenceFailure, makeWorld, runSequence } from './jackpot/sequences'

const sequences = Number(process.env.PROPERTY_SEQUENCES ?? '10000')
const seconds = Number(process.env.PROPERTY_SECONDS ?? '540')
const baseSeed = Number(process.env.PROPERTY_SEED ?? '20261027')

describe('Property: solvency and principal over random sequences', () => {
    it(
        'keeps F·TC ≥ P·TT and wallet ≥ T after every transaction, and returns every principal',
        async () => {
            const world = await makeWorld()
            const started = Date.now()
            let ran = 0
            let transactions = 0
            let draws = 0
            let withdrawals = 0
            let winners = 0
            let misses = 0
            const failures: string[] = []
            for (let i = 0; i < sequences; i++) {
                if ((Date.now() - started) / 1000 > seconds) break
                const seed = baseSeed + i
                try {
                    const result = await runSequence(world, seed)
                    transactions += result.transactions
                    draws += result.draws
                    withdrawals += result.withdrawals
                    winners += result.winners
                    misses += result.misses
                } catch (e) {
                    if (!(e instanceof SequenceFailure)) throw e
                    failures.push(e.message)
                    console.error(`property failure, seed ${seed.toString()}:\n${e.message}`)
                    if (failures.length >= 5) break
                }
                ran++
            }
            const elapsed = ((Date.now() - started) / 1000).toFixed(0)
            console.log(
                `property: ${ran.toString()} sequences (seeds ${baseSeed.toString()}..${(baseSeed + ran - 1).toString()}) in ${elapsed} s: ` +
                    `${transactions.toString()} transactions, ${draws.toString()} draws, ${withdrawals.toString()} withdrawals, ` +
                    `${winners.toString()} winners and ${misses.toString()} misses checked, ` +
                    `${failures.length.toString()} failure(s)`,
            )
            expect(failures).toEqual([])
            expect(ran).toBeGreaterThan(0)
        },
        (seconds + 120) * 1000,
    )
})
