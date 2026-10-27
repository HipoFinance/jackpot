# Changelog

What changed in Hipo Jackpot, newest first.

## Unreleased

- The amended spec built: exact draws over a 64-ary, 4-level tree of node contracts (`contracts/node.fc`),
  ranges keyed by booking index, withdrawals held back in a draw's window for the surcharge, A = 16,
  `locate(slot)` only, `lost` replies; GRAM deposit records store `coins` and `cap` and book at most `cap`;
  the 1% booking margin; prizes won while the rate has fallen go back into F and `other` claims still pay;
  the burn is taken on new yield only; upgrades migrate in the same transaction (set_c3) with a storage
  version, and the deploy checks its parameters. Fees resized for the tree, nodes in their worst case
  (a 64-child fold at every level): see `contracts/imports/constants.fc` and `tests/Gas.spec.ts`. Every
  former open bug now passes as a plain test. Not money-audited yet.
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
