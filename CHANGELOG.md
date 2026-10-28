# Changelog

What changed in Hipo Jackpot, newest first.

## Unreleased

- Scripts and docs: `scripts/` (deploy, read-only `showState`, `submitRandomness`, one confirmed script
  per governor and halter operation) and `docs/architecture.md`. Nothing has been run against a network.
  The hand-operated scripts check
  hGRAM outside `T` and, for a failed payout, the bounced transfer on chain; `upgradeCode` replays the upgrade
  in a sandbox on a copy of the live account (`tests/UpgradeDryRun.spec.ts`) and wants the audited code hash
  typed back; every governor script can print its message (`b`) for the governor multisig to submit. Left
  open: a keeper service (its own spec).
- v1 contracts (FunC): `jackpot.fc`, `range.fc`, `node.fc` (exact draws over a 64-ary, 4-level sum tree,
  so withdrawn money leaves no gaps a whale could use), the drand quicknet check, wrappers, and sandbox
  tests against Hipo's real contracts (flows, every acceptance criterion, attacks, property sequences, gas
  pins). Money-audited (two opposite audits with two re-checks each) and code-reviewed (three rounds): no
  confirmed failing case. Fixed on the way: bill mints under an attacker-chosen query_id (mints now book at
  most `cap`), unsafe upgrades (migrate via set_c3), the whale gap attack (the tree), stuck tree hops
  (worst-case fees, mode-64 forwarding). Accepted: a forged success `gas_excess` only removes the governor's
  `settle_failed_payout` shortcut. Not done: a property run at the spec's 10,000 sequences (about 19 hours),
  testnet.
- v1 design approved: [`docs/specs/2026-10-27-jackpot-v1.md`](docs/specs/2026-10-27-jackpot-v1.md) — three
  ranked prizes every validation round, drand randomness, principal booked at Hipo's on-chain quote,
  payouts in hGRAM. Money-audited as a spec (all findings closed). Left for later: renumbering withdrawn
  ticket space, and keeper rewards paid from the pot.
- Repository created.
