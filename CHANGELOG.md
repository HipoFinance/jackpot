# Changelog

What changed in Hipo Jackpot, newest first.

## Unreleased

- Fix round after the tier-3 review of amendment 2: the first booking's top-node StateInit forwarding is paid by the float
  (a price step could leave `deposit_booked` without gas and lose the principal); the burn fee prices the wallet's leg
  with the payload (`get_burn_fee`); TEP-89 bound 28,000; bounds 60,000 (Jackpot) and 18,000 (wallet) for the cap-payload,
  full-burn and `w` paths; the undo checks the bounce comes from the owner's wallet (the owner rides last in the booking's
  reply); `booked_min` counts the payload; the wallet's `from_jackpot?` branch is sized for the Jackpot's comment; the
  getter `get_wallet_minimum_internal` counts no debt; `withdraw_for` takes `value_per_owner`. **A `deposit_ready` refusal's
  refund no longer ignores errors:** a failed refund now bounces `deposit_ready`, and the governor's `return_tokens(…,
  true)` recovers it.
- Amendment 2, fees priced at current prices (`docs/specs/2026-11-06-jackpot-fees.md`): `contracts/imports/fees.fc`
  computes the deposit, burn, `w`, poke, submit, refill, TEP-89 and `withdraw_for` fees from the chain's gas, forwarding
  and storage prices, with gas bounds of at least 1.5 times the measured gas and a headroom of 2 (3 on `release`).
  `burn_notification` checks its fee first, within 30,000 gas, and throws when short, so the wallet restores the balance;
  the wallet's frozen minimum now counts its storage debt (`get_wallet_minimum_internal`); a burn from the Jackpot to a
  wallet in debt goes to the owner. `deposit_ready` refuses with `low_value` below `update_min + booked_min`. The undo of
  a bounced `deposit_booked` sets its own gas limit and drops `fee::bounce_floor`. `get_jackpot_fees` has new fields and
  `get_fee_parts` is new; `setSuccessor` wants 3 times the successor's deposit fee. Declined: a fee per call rather than
  per handler (the bounds are fixed in code); the undo's refund is not guaranteed (untracked and recoverable).
- Verification tests for the criteria that were open (`tests/Verification.spec.ts`): the boundary rule at the exact
  threshold, 1,000 pokes, a placed boundary, the deposit, burn and `w` chains, every bounceable message's `extra_flags`,
  the Failures table row by row, a bounced `deposit_booked`, the rate in exact fractions, the end of the tree (the excess,
  a node with a sum, `withdraw_surplus`, the order, the split to the nano-GRAM) and the value returned. The property run
  also asserts the data's full-width bits bound. `tools/lintNames.mjs` (in `npm run lint`) fails on a lone T, I, O, F, U,
  P, L or G in contracts, wrappers, the docs' prose and the scripts' output; the scripts and docs were renamed to match.
  `npm test` now runs the message-graph story. Still open: the long runs and `migrate`.
- Message graphs (spec §13): `tests/story/story.spec.ts` runs one story against the amended contracts and Hipo's real
  contracts, `scripts/graphs/` turns its transactions into DOT (`dot.ts`), renders light and dark SVG with
  `@hpcc-js/wasm-graphviz` 1.13.0 (`render.ts`) and writes `docs/message-graphs.md` (`markdown.ts`, `captions.ts`).
  `npm run graphs` writes `docs/graphs/` and the page; `npm test` runs the story too (about a minute) and fails on a
  difference (`SKIP_GRAPHS=1` skips it). The prototype's Python is not kept; labels carry no
  GRAM value, `query_id` or lt, so they do not move with gas prices.
- R1 from the re-check: a move chosen on the value left now keeps its forward fields (it could be chosen and then sent
  without them, leaving the hGRAM untracked at the successor); the refund guards judge the value left; the governor's
  move comment says "moved" only with a successor; `closeSubtree` refuses a frozen node; the dry run compares the halted
  flag.
- Fixes from the tier-3 review of amendment 1. **An owner's move** and a payout's forward fields are judged on the value
  left after the update, the close, the gas and the forwarding, not on the incoming value, so a move can no longer fail
  at Hipo's wallet and leave untracked hGRAM. **The undo of a bounced `deposit_booked`** is funded: `fee::bounce_floor`
  is 0.25 GRAM (update + cancel + refund + two handlers + forwarding) and its refund send ignores errors.
  `withdraw_for` needs `fee::withdraw_for_gas` (0.0048 GRAM) an owner, so the float never pays its gas;
  `fee::wallet_deploy_forward` is 0.008 GRAM and `fee::payload` 0.02 GRAM, sized with the real forwarding. Also: `gas_excess`
  is handled before the data is loaded; the governor's move says `Hipo Jackpot: moved`; the wallet's old-format
  `burn_notification` bounce leaves `pending`; the boundary rise check uses `muldiv`; the upgrade dry run compares the
  addresses, boundary, retirement, rate and derived addresses; `closeSubtree` counts a frozen node as standing.
  `foreign::gas` measured at 18,200 (set 30,000). Left open: the two spec Risks added (the wallet's fixed `fee::withdraw`,
  the poker paying the boundary log's forwarding).
- Decisions of 2026-11-04 built into amendment 1. **The close of the tree is funded by `sweep`'s sender**: `sweep`
  brings `fee::sweep + close_cost(next_position)`, each node keeps `term - fwd` and splits the rest among its children by
  their subtree cost, nodes never call `accept_message` for a close, and the float changes by 0 for the close;
  `fee::close_hop` and `close_hop_value()` are removed. `sweep` also needs `unstaking_tokens = 0`; `close_subtree` brings
  its subtree's cost and refuses a node past `next_position`; `settle_unstake` gains `credit`. Gas bounds measured on the
  new node code: 11,388 (level 1) and 290,166 (64 children), set to 20,000 and 450,000. **Foreign jettons and NFTs**
  go back to their sender when their value covers it, else wait for `rescue_jetton` or `rescue_nft`.
  **`set_treasury`** is new; it and `set_hipo_wallet` need the Jackpot halted and a basechain address, and write logs
  (`hipo_wallet_log`, `treasury_log`, `foreign_return_log`, in `abi/jackpot.xml`). Scripts: `rescueJetton`, `rescueNft`,
  `setTreasury`; `settleUnstake` asks for the credit flag; `sweep` reads the cost; `closeSubtree` offers only the highest
  standing nodes. Also found by the new tests: the payload cap was never enforced (an unused call dropped by the
  compiler), and a refusal for unreadable options carried no reason; both fixed. `fee::wallet_storage` is 0.026 GRAM
  and `fee::boundary_max` 100,000 gas, as measured. Declined: `migrate` (it belongs to a future upgrade); an
  automatic skip of Hipo's bill collection (the Jackpot cannot tell its items). Left open: the 10,000-seed runs.
- Amendment 1 to v2, [`docs/specs/2026-11-03-jackpot-v2-amendment-1.md`](docs/specs/2026-11-03-jackpot-v2-amendment-1.md),
  to make the Jackpot cheaper to run and easy for other contracts to use. **Poke boundaries** in place of the fixed
  clock: anyone's `poke` asks Hipo for its rate, and the reply is a boundary when the rate rose by `rise_min` since the
  last one and `min_gap` has passed; `set_period` is replaced by `set_rise_min` and `set_min_gap`. **The pot is fixed
  at the boundary**, in the same transaction, so there is no quoting state, no `requote`, and no quote on a submit. The
  seed mixes in a masterchain block hash from the boundary. **Withdrawals are TEP-74 burns**, or the comment `w`,
  paid at the stored rate in one step. **No records:** no dictionaries of quotes, payouts or claims, so `claim`
  and `settle_failed_payout` are gone; each step carries its context in the messages, and a bounce
  carries the whole body back (full-body bounces). Payouts are not awaited: hGRAM that comes back sits outside the
  count until `return_tokens` (which gains `in_flight`). **Composability:** deposit and withdrawal options, a reason
  code on a refusal, the caller's `query_id` and payload on every notification, prizes with a note and 0.01 GRAM,
  TEP-89. **Retire and the end:** `retire`, `set_successor`, `withdraw_for`, `sweep`, `close_subtree`. **Logs:** a new
  set, with their layouts in `contracts/schema.tlb` and in tongo's ABI form in `abi/jackpot.xml`. Scripts: new
  `poke`, `setRiseMin`, `setMinGap`, `retire`, `setSuccessor` (refuses a deposit fee below the successor's own),
  `withdrawFor`, `sweep`, `closeSubtree`; `deployJackpot` reads the first rate on chain, checks the settings and the
  `jGRAM` symbol, and offers a poke after the deploy; removed `settleFailedPayout`, `setPeriod`; `settle_unstake` and its script stay.
  Declined: library code for wallets or nodes (their code stays in the Jackpot's data in full, as in v2); a fixed
  clock (its boundaries fell wherever the schedule put them, so the stored rate could miss a reward, and the pot
  was fixed only after the seed was public); a live quote for each withdrawal; a reward for a poke; a seal
  transaction between the boundary and the drand round. The spec lists the other alternatives.
  Left open: keepers poking after each reward, and the alarm on a missing boundary (separate changes), testnet.
- v2 redesign, [`docs/specs/2026-10-31-jackpot-v2.md`](docs/specs/2026-10-31-jackpot-v2.md), so that the Jackpot is
  simple to hold and cheap to run. hGRAM deposits only. One non-transferable jGRAM wallet per player, in place of one
  range per booking. An entry price in place of a one-period wait. Draws on a fixed clock from one
  `submit_randomness`, reimbursed with a reward, in place of `start_draw` and `locate`. Tree changes held in `added`
  and `removed` until the next snapshot, so withdrawals are never refused and pay no surcharge. Unused gas returned;
  draws paid from a GRAM float that unstakes a little of the pot. v1 was never deployed, so nothing migrates. Spec
  money-audited (one audit, two re-checks). Code money-audited twice and code-reviewed: the blocker was a withdrawal
  record keyed by the player's `query_id`, now the Jackpot's own id. Declined: library code for wallets or nodes.
  Accepted: a stranger can confirm a payout early, which leaves the recipient's excess in the float, and `claim` leaves
  about 0.05 GRAM per payout there.
  Left open: a keeper service (its own spec), testnet.
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
