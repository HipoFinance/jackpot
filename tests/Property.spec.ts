// The amendment's Property (extended), Winners recomputed, Fixed storage and Logs criteria. Random sequences of
// deposits (some to a frozen wallet, so that the full-body bounce brings them back), partial and full
// withdrawals, `w`, rewards in parts, gifts, pokes, boundaries, skips, hGRAM sent with no notification and
// full draws (some with a withdrawal between the submit and the searches, some with a node that never
// answers), against the real Hipo contracts and the test build of the Jackpot. After every chain:
// free_tokens·TC ≥ principal·TT, tickets = principal, held_tokens ≤ the real wallet, untracked hGRAM equals
// what the run injected, the principal is the sum of the balances, the tree and the wallets agree, the data has
// the cells it had at deploy, the treasury was asked for a quote only by a poke, and every log is an external out
// to addr_none that parses to its end. Every slot is recomputed from the logs alone: the round's drand
// signature and the mc_hash the boundary logged. At the end of a sequence everyone withdraws in full.
//
// PROPERTY_LOG=<file> is rewritten after every sequence with the running counts, so a stopped run still reports;
// PROPERTY_SEED shifts the seeds, so two processes can run different sequences.
// PROPERTY_EACH_TX=1 steps every chain one transaction at a time and checks solvency after each (slower).
//
// It runs PROPERTY_SEQUENCES sequences (default 10,000) or until PROPERTY_SECONDS have passed (default 540),
// whichever comes first, and prints how many ran. Each sequence has its own seed, PROPERTY_SEED + i; a
// failure prints that seed and the operations, and PROPERTY_SEED=<seed> PROPERTY_SEQUENCES=1 replays it.
import { writeFileSync } from 'fs'
import { SequenceFailure, makeWorld, runSequence } from './jackpot/sequences'

const sequences = Number(process.env.PROPERTY_SEQUENCES ?? '10000')
const seconds = Number(process.env.PROPERTY_SECONDS ?? '540')
const baseSeed = Number(process.env.PROPERTY_SEED ?? '20261027')

describe('Property: invariants, winners and logs over random sequences', () => {
    it(
        'keeps solvency, tickets = principal, tree = balances and fixed storage after every chain, recomputes every winner, and returns every principal',
        async () => {
            const world = await makeWorld()
            const started = Date.now()
            let ran = 0
            let transactions = 0
            let draws = 0
            let withdrawals = 0
            let winners = 0
            let misses = 0
            let rollovers = 0
            let interleaved = 0
            let stuck = 0
            let boundaries = 0
            let skips = 0
            let pokes = 0
            let bounces = 0
            let untracked = 0
            let logs = 0
            let midChecks = 0
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
                    rollovers += result.rollovers
                    interleaved += result.interleaved
                    stuck += result.stuck
                    boundaries += result.boundaries
                    skips += result.skips
                    pokes += result.pokes
                    bounces += result.bounces
                    untracked += result.untracked
                    logs += result.logs
                    midChecks += result.midChecks
                } catch (e) {
                    if (!(e instanceof SequenceFailure)) throw e
                    failures.push(e.message)
                    console.error(`property failure, seed ${seed.toString()}:\n${e.message}`)
                    if (failures.length >= 5) break
                }
                ran++
                if (process.env.PROPERTY_LOG)
                    writeFileSync(
                        process.env.PROPERTY_LOG,
                        `sequences ${ran.toString()} (seed ${baseSeed.toString()}+) transactions ${transactions.toString()} draws ${draws.toString()} misses ${misses.toString()} rollovers ${rollovers.toString()} failures ${failures.length.toString()} elapsed ${((Date.now() - started) / 1000).toFixed(0)} s\n`,
                    )
            }
            const elapsed = ((Date.now() - started) / 1000).toFixed(0)
            console.log(
                `property: ${ran.toString()} sequences (seeds ${baseSeed.toString()}..${(baseSeed + ran - 1).toString()}) in ${elapsed} s: ` +
                    `${transactions.toString()} transactions, ${draws.toString()} draws, ${withdrawals.toString()} withdrawals, ` +
                    `${winners.toString()} winners and ${misses.toString()} misses checked (${(draws ? misses / draws : 0).toFixed(2)} per draw), ` +
                    `${rollovers.toString()} rollovers, ${interleaved.toString()} draws with a withdrawal between submit and searches, ${stuck.toString()} stuck draws, ` +
                    `${boundaries.toString()} boundaries, ${skips.toString()} skips, ${pokes.toString()} pokes, ${bounces.toString()} bounced deposits, ${untracked.toString()} untracked transfers, ${logs.toString()} logs parsed, ` +
                    `${midChecks.toString()} per-transaction checks, ` +
                    `${failures.length.toString()} failure(s)`,
            )
            expect(failures).toEqual([])
            expect(ran).toBeGreaterThan(0)
        },
        (seconds + 120) * 1000,
    )
})
