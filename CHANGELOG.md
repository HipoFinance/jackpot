# Changelog

What changed in Hipo Jackpot, newest first.

## Unreleased

- v1 contracts in FunC: `contracts/jackpot.fc`, `contracts/range.fc`, their imports and `schema.tlb`,
  with wrappers and sandbox tests of each flow against Hipo's real contracts (deposits, withdrawals, draws,
  requote, halt, a falling rate) and a gas/fee spec that runs every entry message on its bare fee. Not yet
  money-audited. Open: the instant_mint-off path is untested (the sandbox treasury never defers), and query
  ids are randomised because anyone can mint to the Jackpot under a chosen id, which the spec did not foresee.
- v1 design approved: [`docs/specs/2026-10-27-jackpot-v1.md`](docs/specs/2026-10-27-jackpot-v1.md) — three
  ranked prizes every validation round, drand randomness, principal booked at Hipo's on-chain quote,
  payouts in hGRAM. Money-audited as a spec (all findings closed). Left for later: renumbering withdrawn
  ticket space, and keeper rewards paid from the pot.
- Repository created.
