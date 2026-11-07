# Jackpot Architecture

This document explains how the Jackpot contracts work together, how a boundary and a draw run, and which invariants
any change must preserve. The decisions and their reasons are in the approved specs,
[`specs/2026-10-31-jackpot-v2.md`](specs/2026-10-31-jackpot-v2.md) and its
[amendment 1](specs/2026-11-03-jackpot-v2-amendment-1.md), which this document follows (the amendment's names replace
the v2 spec's single-letter symbols outside formulas); the message layouts and logs are in `contracts/schema.tlb`, and
the logs in tongo's ABI form in `abi/jackpot.xml`.

Terminology: GRAM is the network coin (rebranded from TON), hGRAM is Hipo's jetton. The network itself is
still called the TON blockchain.

## The big picture

Players stake on Hipo first, then send hGRAM to the **Jackpot**, which keeps it in one hGRAM wallet. For each
deposit it books a **principal**: the GRAM the player is owed back, shown as **jGRAM** in the player's own
wallet contract. Because Hipo's rate only rises, the hGRAM held is worth more than the principal owed. The
difference is the **pot**.

There is no clock. Each time Hipo's rate has risen enough and a minimum time has passed, a **poke** makes a
**boundary**: the Jackpot snapshots who is in and fixes the pot in the same transaction. A **draw** then pays that pot
to three winners (50% / 30% / 20%) chosen at random in proportion to principal. Part of the pot, 10% at first, goes to
the HPO **burner**. A deposit pays an **entry price** into the pot instead of waiting a period. A player can withdraw
their principal at any time.

Nothing in Hipo changes for this. The Jackpot is an ordinary hGRAM holder that asks Hipo's treasury for its
exchange rate with a message the treasury already answers. It depends on the treasury answering a
`provide_current_quote` only to the sender, echoing its `custom_payload` unchanged, and on Hipo's rate never falling;
if it does fall, the Jackpot stops moving money (see the invariants).

## The contracts

| Contract | How many | What it does |
| --- | --- | --- |
| **Jackpot** (`contracts/jackpot.fc`) | one | Holds all hGRAM and all counters, makes boundaries, runs deposits, withdrawals and draws, verifies drand, pays out. It is the jGRAM master. Upgradable by the governor. |
| **jGRAM wallet** (`contracts/wallet.fc`) | one per player | Holds the owner, the balance, the position `b` and `pending`. Address follows from (Jackpot, owner). The owner withdraws by burning. Closes when empty. Sending tokens throws. |
| **Node** (`contracts/node.fc`) | one per 64 children | Holds three arrays of 64 ticket sums. Four levels, room for 16,777,216 positions. A level-1 node also holds each position's owner and answers hit or miss. Closes on `close_node`. |
| **Hipo treasury, parent, wallet** | Hipo's | The exchange rate, unstaking, and the Jackpot's hGRAM wallet. |
| **drand** (`contracts/imports/drand.fc`) | code in the Jackpot | Checks a drand quicknet signature on chain. |
| **Burner** | Hipo's | Swaps the hGRAM it receives into HPO and burns it. |

Wallet and node code are fixed: the Jackpot stores them to deploy them and compute their addresses, and they
cannot be upgraded. Only the Jackpot's own code can be. None of them uses library cells.

### The tree

One nano-GRAM of principal is one **ticket**, and tickets line up by position. A node holds, per child:

- `committed`: the tickets below that child at the snapshot. Draws read only this.
- `added` and `removed`: tickets booked and tickets withdrawn since the snapshot.

The truth is `committed + added - removed`. Every change goes down as `update(tag, b, delta)` and only touches
`added` or `removed`, whether a draw is open or not. A node that sees a later tag folds first: `committed` takes
the sum and both arrays clear. A search goes down as `descend(tag, slot, attempt, k, offset)`. The level-1 node
answers `hit` with the owner if the offset inside the position is below `committed - removed`, and `miss` otherwise.

Updates and searches start at the Jackpot and share each parent-child pair, and TON delivers messages between
two accounts in order, so a search with tag `q` sees every update sent before snapshot `q` and no later one. A
node accepts messages only from its parent. `close_node` is accepted from the parent (the Jackpot for the top node);
see Retire and the end.

## Boundaries

A **poke** is a message from anyone with at least the poke fee (`get_jackpot_fees`). The Jackpot sends the treasury a
`provide_current_quote` whose `custom_payload` is the **poke context** (a tag, the time, the poker), carrying the rest
of its value (mode 64). The treasury answers `take_current_quote` to the Jackpot with the context unchanged. Nothing is
stored between the two messages. If the request bounces (the bounce carries the whole body), the rest of the value goes
back to the poker.

The reply is accepted only from the treasury, with a context of the right tag, and never throws (it is not bounceable).
It stores the rate as the **stored rate** (`quote_coins`, `quote_tokens`); deposits, withdrawals and refills use it.
A rate lower than the stored one is stored too and raises the `falling` flag. The reply is a **boundary** when all of
these hold:

- the rate rose by at least `rise_min` parts per million over the **boundary rate** (the rate at the last boundary);
- `min_gap` seconds have passed since `last_boundary`;
- the `falling` flag is down and the Jackpot is not halted.

`rise_min` (initially 50 ppm) and `min_gap` (initially 32,768 s, half a round) are the governor's; `set_min_gap` takes
effect at the next boundary. Otherwise the poke only refreshes the stored rate, and the rest of the value goes back to
the poker. A poke never makes a boundary earlier than `last_boundary + min_gap`, and a gift to Hipo's rate that is
below `rise_min` makes none, so nobody gains from choosing the moment.

What a boundary does, in the reply's transaction, with the float paying the gas it really used (at most
`fee::boundary_max`) and any unstake fee:

- **A draw is waiting:** a **skip**. The draw keeps its snapshot, its tag and its pot; the stored `mc_hash` is
  refreshed and the draw now waits for the new boundary's drand round. No new snapshot. A `skip` log is an alarm.
- **A draw is resolving:** every open slot rolls over (`expired`), its prize goes back to free hGRAM and into
  `carried`, and the draw ends. Then the next case.
- **Otherwise:** `tag += 1`, `snapshot_tickets = tickets`, the seed cleared. The **pot is fixed here**, at the
  boundary's rate: `pot` is the free hGRAM above what covers all principal. With tickets, and a pot of at least
  `min_pot`, the Jackpot may unstake `u` first (when its float is under `float_low`; see Gas and the float), takes
  `burn = (pot - u - carried) * burn_share`, splits the rest 50% / 30% / 20% into three prizes, moves `pot - u` into
  `reserved_tokens`, zeroes `carried`, and the draw is waiting. Otherwise there is no draw.
- In every case the boundary rate becomes the reply's rate, `last_boundary` becomes now, and a waiting
  `set_min_gap` takes over.

Because the pot is fixed at the boundary and set aside in `reserved_tokens`, a deposit after it neither pays for nor
can win that pot, and a withdrawal after it cannot take the prizes. Nothing is read at the draw but the stored seed.

`boundary` and `skip` logs carry the drand round `R` and the masterchain block the boundary saw.

## Message flows

### Fees

Every fee a user attaches is computed on the chain from the current prices (`contracts/imports/fees.fc`: `GETGASFEE`,
`GETFORWARDFEE`, `GETFORWARDFEESIMPLE`, `GETSTORAGEFEE`), so a change of the network's prices moves the fees with it.
Each handler has a gas bound at least 1.5 times what the built code uses (`tests/Gas.spec.ts`, `tests/Fees.spec.ts`),
and a fee adds a headroom of 2 (3 for `release`, the value that closes a wallet) on the value a later transaction spends.
The bounds are the Jackpot 60,000 gas (`bound::jackpot`), a wallet 18,000, a node 110,000, a submit 150,000, TEP-89 28,000
and the poke handler 22,000; the treasury's quote 40,000. `get_jackpot_fees` returns the fees at today's prices and `get_fee_parts` the parts they
are built from.

- `deposit`: the larger of two chains (a booking, and a refusal that pays a refund), plus the options' forward amount
  and the payload's forwarding. `burn`: the wallet's leg, the Jackpot's, the update, the release, a payout, and the
  forward amount and payload. `w`, `poke`, `submit`, `refill` and TEP-89 are priced the same way.
- **The burn check.** `burn_notification` checks its fee first, within 30,000 gas, before any state changes; a short
  burn throws, bounces, and the wallet restores the balance. This is a rule for every future Jackpot (the upgrade
  dry run checks it). The wallet's code is fixed, so its own minimum (`get_wallet_minimum_internal`: its gas, the
  bounce, three times a refusal's legs; the getter excludes the storage debt, which the wallet adds in a transaction with
  `DUEPAYMENT`) is frozen with it, and the 30,000 bound is
  what keeps that minimum enough.
  **What an app attaches to a burn** (one rule, `burnAttach` in `wrappers/Jackpot.ts`): `max(burn fee, minimum +
  payload fee + the wallet's debt) + a small margin`. The burn fee is `jackpot.getBurnFee(forward amount, payload cells,
  payload bits)`, which already counts the forward amount and the payload; the minimum is `get_wallet_minimum_internal`
  and the payload fee is eight times the payload's forwarding plus one more. The getter shows the minimum with **no**
  storage debt (a getter runs without a storage phase); in a transaction the wallet also counts its debt. A wallet in
  debt above about 0.066 GRAM today therefore needs more than the burn fee. Read the debt from the account's storage
  stats: `max(0, due_payment + storage fee for (now - last_paid) - balance)`.
- **The first booking.** The forwarding of the top node's StateInit (about 1.87M today) is paid by the float, taken out of
  the reserve, so a price step cannot leave `deposit_booked` short; the node's size is pinned by a test.
- **The update.** `deposit_ready` refuses with `low_value` (and refunds) when the value left is below `update_min +
  booked_min`; the update gets `update_value` when there is room, else what is left after `deposit_booked`'s minimum.
- **The undo** of a bounced `deposit_booked` raises its own gas limit to `bound::jackpot` once its checks pass (the bounce comes from the owner's own wallet, which
  the booking carries), and sends its
  update and cancel with explicit values from the balance; the float is exposed to `update_value + release +
  gas(bound::jackpot)` at most. Its refund is paid only when the bounce carries more than the update, the release and the
  payout fee; a bounce of `deposit_booked` does not (it cannot happen for a wallet that just answered), so the tokens
  leave the count untracked, with an untracked log, and `return_tokens` recovers them.
- A jGRAM wallet keeps `wallet_storage`: five years at the current price.
- The float side is sized at 400 nano-GRAM per gas (`fee::draw_budget`, `fee::unstake_bound` 0.2 GRAM for Hipo's
  unstake), since a draw must never find the float short.

### Deposit

The player transfers hGRAM to the Jackpot with `forward_ton_amount` of at least the deposit fee (`get_jackpot_fees`, `deposit`; plus the options'
forward amount, plus the payload's fee with a payload), and optionally a forward payload, `deposit_options`: the smallest
principal accepted, a beneficiary, a response destination, a forward amount and a forward payload. The Jackpot reads it
inline or in a ref; a ref is recommended, since with its addresses it does not fit inline beside the transfer's other
fields.
Without options the beneficiary and the response destination are the depositor and the price limit is 1%. Each step is
one transaction, and the Jackpot stores nothing about a deposit in flight: the **deposit context** (id, tokens,
options, parties) rides in the messages.

1. **Notification,** from the Jackpot's hGRAM wallet only. A mint to the Jackpot, an amount of 0 and an
   off-basechain sender are ignored, and those tokens stay outside `held_tokens`. Options that cannot be read, a
   halted or retired Jackpot, or too little value are a refusal. Otherwise `held_tokens += t`, `incoming_tokens += t`,
   and `prepare_deposit` with the context goes to the beneficiary's jGRAM wallet, with the wallet's StateInit.
2. **Wallet.** An opening wallet (no position, `pending` > 0) answers `busy` and changes nothing. Otherwise
   `pending += 1`. It answers `deposit_ready` with its position, if any, and the context. A frozen wallet bounces the
   prepare, and the bounce refunds with `wallet_unavailable`.
3. **`deposit_ready`,** taken only from the wallet of the context's beneficiary. `busy` is refused. Otherwise, at the
   stored rate, `incoming_tokens -= t` and the deposit is refused or booked.
4. **Refused:** `held_tokens` stays, `deposit_cancelled` goes to the wallet, a `refused` log is written, and the hGRAM
   goes to the response destination. **Booked:** `principal += c`, `tickets += c`, a new wallet takes
   `b = next_position`, `update(tag, b, +c)` goes down the tree, `deposit_booked` goes to the wallet, and a `booking`
   log is written.
5. **`deposit_booked`:** `balance += c`, `pending -= 1`, the wallet stores `b`, keeps its reserve, sends the
   beneficiary a standard jetton `transfer_notification` (with the caller's `query_id` and forward payload, if the
   forward amount is above 0) and the rest as `gas_excess` to the response destination. **`deposit_cancelled`:**
   `pending -= 1`, and an empty wallet closes.

If a `deposit_booked` bounces (it cannot, for a wallet that just answered), the bounce carries the whole booking: it is
undone, a `booking_undone` log is written and the tokens it was worth go back. A wallet never holds a balance without
a position.

**Refusals** return the hGRAM to the response destination. With options, the transfer's forward payload is
`deposit_refused` with a **reason code** and the caller's own payload (absent when the options could not be read), and
the caller's forward amount; without options, a text comment names the reason. Reasons: 1 halted, 2 retired, 3 rate
fell, 4 below the minimum deposit, 5 price above the limit, 6 first deposit still being booked, 7 tree full, 8 bad
options, 9 too little value, 10 wallet unavailable. A refusal the Jackpot cannot pay for leaves the hGRAM outside
`held_tokens` and writes an `untracked` log.

### Entry price

```
c = v                              if principal = 0
c = floor(v * P / (P + pot_v))     otherwise
```

`v` is the deposit's value at the stored rate; `pot_v` is the pot's value in GRAM, rounded up, at the same rate, with
the deposit's own tokens not yet counted. The deposit pays `v - c` into the pot, which leaves pot per principal
unchanged, and its expected prize equals what it paid, at any size. The burn makes it worse than even. `min_c`
defaults to `v - floor(v / 100)`, so a price above 1% is refused unless the app asks for it.

### Withdrawal

A withdrawal is a standard TEP-74 `burn` sent to the wallet by its owner, or the comment `w` (below).

1. The owner sends `burn(x)` to their wallet (`x = 0` means all, and needs a balance), with at least the burn fee (`getBurnFee`)
   and optional `withdraw_options` (send to the successor, a forward amount and payload). A partial burn takes at
   least 1 GRAM of principal. The wallet checks the owner and the fee, lowers the balance, and sends
   `burn_notification`. When that empties it (`last`), `pending += 1`.
2. The Jackpot takes `burn_notification` only from the wallet of the owner it names, and, once its fee check has passed, never throws. `tickets -= x`,
   `update(tag, b, -x)`, `close_wallet` to the wallet if `last`, and the payment is made in the same transaction, at the
   stored rate: `w = min(floor(x * TT / TC), floor(F * x / P))`, then `principal -= x`. The hGRAM goes to the owner
   with the caller's `query_id`, forward amount and payload, and the leftover GRAM to the response destination. A
   `withdrawal` log is written.

No quote is asked for and no record is kept. Withdrawals work while halted, retired, with the rate fallen, in every
draw state and with an empty float. Every action carries +16, and the message asks for a full-body bounce: if the
action phase fails, the bounce brings the whole `burn_notification` back to the wallet, which restores `x` and the
`pending` count from it. `close_wallet` lowers `pending`; the wallet closes at balance 0 and `pending` 0 and sends all
its GRAM to the owner in the message that deletes the account. A later deposit deploys it again with a new position.
Positions are never reused.

**`w`.** A plain message to the Jackpot with the text comment `w` (or `W`), at least the `w` fee (`get_jackpot_fees`, `commentWithdraw`), from a
basechain address, makes the Jackpot send that sender's wallet a burn of everything, with the wallet's StateInit (so a
sender with no wallet deploys one that returns the value). The hGRAM comes back with the comment
`Hipo Jackpot withdrawal`. An empty comment is a top-up; any other text is refused with `bad_comment`.

### Draw

The states are none, waiting and resolving. A boundary that sets a pot aside opens a draw in state waiting. There is no
quoting state.

1. **Submit.** Anyone sends `submit_randomness(signature, witness)` with at least the submit fee (`get_jackpot_fees`), from when drand
   publishes `R` (the round at `last_boundary + 60 s`) until 1,800 s (`submit_cutoff`) before the earliest next
   boundary, `last_boundary + min_gap`. The Jackpot checks, cheapest first: the fee, the state, the cut-off, halted,
   the flag, its float against `fee::draw_budget`, then the drand check. A failed check throws, so junk pays for
   itself. The seed is `sha256(signature || mc_hash)`, the hash being the masterchain block the boundary saw, so a
   signature alone cannot be used to steer the pot. State resolving; three `descend` go out from the float, and the
   submitter gets the rest of its value plus 0.02 GRAM.
2. **Searches.** `k = sha256(seed, slot, attempt) mod snapshot_tickets`. On `hit` the prize leaves `reserved_tokens` and is paid
   in hGRAM to the owner, with `fee::prize_notify` (0.01 GRAM) as the forward amount and the comment
   `Hipo Jackpot prize: draw <tag>, <1st|2nd|3rd>`. On `miss` or `lost` the next attempt goes out from the float. After
   16 the prize rolls over into `carried`. A hit while the rate has fallen is `returned` to free hGRAM instead.
3. **End.** When all slots are closed the state is none. Once the burn owed reaches `burn_batch` (and the rate has not
   fallen) it goes to the burner, forwarding 0.5 GRAM for the swap.

A slot still open at the next boundary rolls over; later answers carry an old tag and are ignored. A draw that nobody
submits for waits, and the next boundary skips it.

### Payouts and bounces

The Jackpot sends hGRAM (prizes, burn, withdrawals, refunds) and **does not wait to hear that it arrived**. It keeps
no record of a payout. Almost always the recipient's wallet takes it. In the rare case that it does not, the hGRAM comes
back to the Jackpot's wallet, outside `held_tokens` and counted nowhere; the governor sends it on with `return_tokens`.
`scripts/showState.ts` prints it as untracked (the wallet's balance less `held_tokens`).

Every bounceable message the Jackpot and its wallets send sets `extra_flags = 3`, which asks for a **full-body
bounce**: `new_bounce_body#fffffffe`, with the whole original body as a ref. So a bounce of `prepare_deposit`,
`deposit_booked`, `burn_notification` or `provide_current_quote` brings back everything the step needs, and the step
is finished from the bounce. The Jackpot reads only that format and ignores an old-format bounce; the wallet, which
cannot be upgraded, reads both for its two bounceable messages. This needs TON's global version 12 or later (mainnet
has had it since November 2025).

### Gas and the float

Users pay for their own chains. The entry minimums are sized at 400 nano-GRAM per gas, and each handler passes on
what it received less its gas, reserving the Jackpot's balance from before the message, so a user chain doesn't
move the float.

Boundaries and draws are paid from the float: the boundary's gas, the submitter's reward, searches, prize payouts, burn
gas. At a boundary with the float `G < float_low` (8 GRAM), if `unstaking_tokens = 0` or the last unstake was over 7
days ago, the Jackpot unstakes `u = min(ceil((float_high - G) * TT / TC), floor(pot / 5))` through its hGRAM wallet
(`float_high` is 15 GRAM). `u` leaves `held_tokens` at once and is taken from the pot before the burn and the prizes.
Once `G < fee::draw_budget` no draw can run, so anyone may send `refill` in state none or waiting; it asks for no
quote and unstakes at the stored rate.

`withdrawal_notification` from the Jackpot's hGRAM wallet lowers `unstaking_tokens`, matched by sender and never by
`query_id`. A bounce of `unstake_tokens` restores `held_tokens`. A Hipo rollback's only signal is a `gas_excess` anyone
can forge, so the Jackpot ignores it and the tokens sit outside `held_tokens` until the governor, after checking the
rollback on chain, sends `settle_unstake(amount, credit)` (`0 < amount <= unstaking_tokens`). With `credit = true`
it moves them from `unstaking_tokens` back into `held_tokens`; with `credit = false` (the GRAM in fact arrived but the
notification was missed) it only lowers `unstaking_tokens`. A stuck count blocks `sweep`, so this clears it.

### For apps and contracts

- **Deposit:** a `deposit_options` payload, read inline or in a ref (a ref is recommended), names the beneficiary, the
  smallest principal, the response destination and an inner payload. The beneficiary's wallet sends the standard `transfer_notification` with the
  caller's `query_id` and payload when the deposit is booked. A refusal returns the hGRAM with `deposit_refused`.
- **Withdraw:** a standard burn, answered by an hGRAM transfer with the caller's `query_id` and payload.
- **Prizes** arrive with 0.01 GRAM and a note naming the draw.
- **TEP-89:** `provide_wallet_address` is answered with `take_wallet_address`. `get_jetton_data` reports `mintable`
  false once retired.

## Retire and the end

- **`retire`** (governor): no message undoes it. Deposits are refused with reason `retired`, including those whose
  `deposit_ready` comes later. Boundaries, draws, refills, withdrawals, `w`, prizes and the burn go on.
- **`set_successor(successor, successor_deposit_fee)`** (governor, retired only): a basechain address that is not the
  Jackpot, or `addr_none` to clear it. A withdrawal with `to_successor` is paid, if the value covers the fee, as a
  `deposit_options` deposit for the same owner into the successor, with `successor_deposit_fee` attached; if the
  successor refuses, the hGRAM goes to the owner. `scripts/setSuccessor.ts` refuses a fee below the successor's
  three times the successor's deposit fee (its prices may rise before the move) plus `fee::return` and the payload's fee,
  read from its `get_jackpot_fees`.
- **`withdraw_for(to_successor, owners)`** (governor, retired only): up to 100 owner hashes, sent as `w` burns. For
  `n` owners the governor pays at least `n·per + gas(gas_consumed() + 10,000)`, where `per` is the value sent to each
  wallet (the `w` value, plus the successor fee for a move), and gets back what is above that; what an owner's wallet does not spend goes to that owner. The
  successor fee is charged whenever `to_successor` is set, even with no successor set; that is harmless, since the
  governor pays.
- **`sweep`** (anyone, with `fee::sweep + close_cost(next_position)`, read from `get_close_cost`): only when retired,
  `principal = 0`, `incoming_tokens = 0`, `unstaking_tokens = 0` and no draw resolving. A waiting draw is ended first
  (no ticket is left to win it). All of `held_tokens` goes to the burner, the reserved and carried counters are zeroed,
  and `close_node(next_position)` goes to the top node carrying `close_cost(next_position)`, taken from the sender's
  value: the float changes by 0 for the close. With `next_position = 0` no node was ever deployed and no `close_node`
  is sent.
- **Closing the tree.** A node accepts `close_node` only from its parent (the Jackpot for the top node), checks the
  sender first and never calls `accept_message`, so a forged close cannot spend its reserve. It ignores the message
  unless all its sums are 0. Its value is the funding: it keeps `term - fwd` (its gas bound priced at the current gas
  price plus the forwarding of its own `close_node`, which its parent's value already paid), and if the value covers
  that plus the unscaled sum of its children's `subtree_cost` it sends each child that exists (a child exists exactly
  when its first position is below `next_position`) its share of the rest in proportion to the child's `subtree_cost`,
  in mode 0 with the forwarding inside the share. Then it deletes itself, sending its whole balance to the Jackpot. A
  node that is short does nothing and keeps the value. `close_cost(n)` is the top node's `subtree_cost` times the
  margin (3/2), so the margin reaches the leaves. The gas bounds are `close::gas_1 = 20,000` (measured 11,388) and
  `close::gas_inner = 450,000` (measured 290,166 for 64 children), both over 1.5 times the measure.
  **`close_subtree(level, index)`** (governor, after the sweep, with that subtree's cost times the margin from
  `get_subtree_close_cost`) restarts the close at one node the cascade left behind; it refuses a node whose first
  position is at or past `next_position`. The governor closes only the highest nodes still standing, and
  `scripts/closeSubtree.ts` offers only those.

### Foreign jettons and NFTs

A `transfer_notification` from any wallet but the Jackpot's hGRAM wallet, and an `ownership_assigned` from any item,
is sent back to its sender (`prev_owner` for an NFT) with a TEP-74 or TEP-62 transfer, the comment `Hipo Jackpot: this
token is not accepted` and `response_destination` the sender, when its value is at least `fee::foreign_return`. The
return reserves the balance the Jackpot had before the message and sends everything above it, so the gas, the log
and the transfer come out of the incoming value and the float ends where it was. With less value, or for a mint
(`addr_none`) or the Jackpot as sender, the token is held and `foreign_return_log` (`sent = false`) is written only if
the value covers it. A return that bounces changes nothing. The governor's `rescue_jetton(jetton_wallet, amount,
destination)` and `rescue_nft(nft, destination)` send a held token on, on the governor's value; `rescue_jetton` refuses
the current hGRAM wallet (matched by parsed workchain and hash), and both need basechain `addr_std` addresses. An item
of Hipo's bill collection is never returned by itself; the Jackpot has no way to tell one, so this relies on Hipo's
bills sending no ownership notice (see the spec's Risks).

### Hipo setters

`set_hipo_wallet` and the new `set_treasury` (governor) need the Jackpot halted and basechain `addr_std` addresses
without anycast, and each writes a log. They are only for a change that keeps one token worth the same (k = 1). A
migration with another k is done by the Hipo migration upgrade, a future code upgrade written for Hipo's actual
migration and not built here; like every upgrade, its work runs inside its `migrate` method (see Upgrades).

## Logs

The Jackpot writes external-out messages to `addr_none` whose body starts with a 32-bit op, `crc32("jackpot::<name>")`,
so explorers decode them with `abi/jackpot.xml`. A log over 654 bits goes in a ref. The wrappers parse them
(`parseLog`).

| Log | When |
| --- | --- |
| `booking` | a deposit is booked: beneficiary, depositor, position, principal, tokens |
| `withdrawal` | a withdrawal is paid: owner, position, principal, tokens, last, moved, the rate |
| `refused` | a deposit is refused at `deposit_ready`: owner, tokens, value, principal, reason |
| `booking_undone` | a `deposit_booked` bounced |
| `boundary` | a boundary: tag, time, rate, snapshot tickets, pot, burn, carried, unstaked, and the prizes, the drand round and the block |
| `skip` | a boundary found a draw still waiting (alarm on any) |
| `randomness` | a submit was accepted: tag, drand round, seed |
| `slot` | an attempt or the end of a slot: hit, miss, rolled over, expired, returned, lost |
| `unstake` | an unstake was sent |
| `untracked` | a refund could not be paid for, so its hGRAM left the count |
| `settings` | `rise_min` or `min_gap` changed |
| `retired`, `successor`, `swept` | the matching governor or sweep step |

## The state

The Jackpot's storage does not grow with the number of players, and holds no records. Its counters:

| Name | Meaning |
| --- | --- |
| `held_tokens` (`T`) | hGRAM held, by its own count, without what was sent to unstake |
| `incoming_tokens` (`I`) | hGRAM received and not yet booked or returned |
| `reserved_tokens` (`O`) | hGRAM set aside: prizes of the open draw and burn owed |
| `free_tokens` (`F`) | free hGRAM, `held_tokens - incoming_tokens - reserved_tokens` |
| `unstaking_tokens` (`U`) | hGRAM sent to unstake and not reported back; a monitoring counter, in no solvency sum |
| `principal` (`P`) | principal owed |
| `tickets` (`L`) | live tickets, the total supply of jGRAM; always equal to `principal` |
| `next_position` (`n_b`) | the next new position |
| `tag` | the snapshot counter |
| `snapshot_tickets` (`draw_L`) | tickets in the snapshot |
| `carried` | prizes gone back into free hGRAM since the last paying draw, already counted for the burn |
| `quote_coins`, `quote_tokens` (`TC`, `TT`) | the stored rate: Hipo's `total_coins`, `total_tokens` at the last poke |
| `boundary_coins`, `boundary_tokens` | the rate at the last boundary |
| `last_boundary`, `rise_min`, `min_gap`, `next_min_gap` | the boundary rule |
| `retired`, `successor`, `successor_deposit_fee`, `swept` | the end |

The getters are `get_jackpot_state`, `get_boundary`, `get_retirement`, `get_draw_state`, `get_position`, `get_quote`,
`get_jackpot_fees`, `get_addresses`, `get_node_address`, `get_storage_version` and TEP-74's `get_wallet_address` and
`get_jetton_data`. `npx blueprint run showState` prints them in readable units.

## Invariants

A change must keep all of these.

- **Solvency: `F * TC >= P * TT`.** The free hGRAM covers all principal at the stored rate. Every rounding goes in
  the pool's favour: bookings round principal down, withdrawals round hGRAM down, the pot rounds what is kept for
  principal up, and the price rounds up. The `min` in the withdrawal formula is for the one case where the rate
  falls: then the loss is shared pro rata.
- **Counters add up.** `T = I + O + F`, and `T` is at most the hGRAM the Jackpot's wallet holds. What sits outside `T`
  (transfers without a notification, mints, a payout that came back, a rolled-back unstake) only the governor can
  return.
- **No records, no keys a player picks.** Nothing is stored for a step in flight; the context travels in the
  messages. A step is finished only from a message the right contract could send: `deposit_ready` from the beneficiary's
  wallet, `burn_notification` from the owner's wallet, `take_current_quote` from the treasury, a bounce by the network's
  flag.
- **The pot is fixed at the boundary.** The snapshot, the pot, the burn and the prizes are decided in one transaction,
  before the seed exists, and the prizes sit in `reserved_tokens` until paid or rolled over. The seed also depends on a
  block hash fixed at the boundary.
- **The snapshot is exact.** Every handler that changes `tickets` sends its update before the next boundary's tag can
  reach a node, so a deposit is in a draw if and only if its booking was handled before the boundary.
- **Split-neutrality.** Each attempt gives every ticket the same chance, `1 / snapshot_tickets`, so a player's chance
  depends on their total tickets, not on how many wallets hold them.
- **Positions cannot be moved after the seed is known.** `committed` cannot change until the next snapshot. A deposit
  lands in `added`. A withdrawal lands in `removed`, which can only turn the owner's own hit into a miss, and
  `removed` never falls, so withdraw-then-deposit stays a miss.
- **Tree consistency.** `committed + added - removed` equals the balances below, and nothing touches `committed`
  except a fold. `array_add` clamps at 0, which is why every change is held until a snapshot.
- **`pending` has one lowering per raise.** `prepare_deposit` is lowered by `deposit_booked`, `deposit_cancelled` or a
  bounced `deposit_ready`; a full burn by `close_wallet` or its bounce. A wallet closes only at balance 0 and `pending`
  0.
- **Replies never throw.** `take_current_quote`, notifications, `deposit_ready`, `burn_notification`, `hit`, `miss`,
  `lost`, bounces and `gas_excess` refund, return or hold instead of throwing, because Hipo's replies are not
  bounceable and a throw would lose the value. Actions in `deposit_ready` and `burn_notification` carry +16.
- **Every entry message pays its whole chain.** Each carries a fixed minimum value, checked before any change, and
  nothing an outsider starts is paid from the float, except a boundary's gas, which the float pays as measured.
  `submit_randomness` pays until its reimbursement.
- **A falling rate stops the money moving.** Any quote lower than the stored one is stored and raises a flag. No
  boundary is made, deposits are refused, submits are refused, prizes go back to free hGRAM, the burn is held, and
  withdrawals pay pro rata. Only the governor clears the flag (`scripts/clearFalling.ts`), which also resets the
  boundary rate.
- **Retirement is one way.** No message clears `retired`; `sweep` needs no principal and nothing incoming.

## Recovery operations and the verify mode

`returnTokens` gives out hGRAM from one pool: the Jackpot wallet's balance less `held_tokens` (what the Jackpot
counts as its own), or, with `in_flight`, from the incoming count. Because the Jackpot keeps no record of its payouts,
a prize or burn still on its way also shows as untracked. The wallet's balance and `held_tokens` are read twice, about 10 seconds apart, and the smaller
untracked figure is used; a recovery should wait until nothing is in transit. A wallet that does not exist yet counts as a balance of 0.

When the governor is a multisig, a printed order (`b`) states what it was checked against and what it consumes, and is
valid only if no other recovery order is pending. Signers should run the same script with `v` at the first prompt
just before signing: it re-reads everything, runs every check, prints PASS or FAIL and sends nothing.

## Roles

- **The governor** (Hipo's; a contract, see below) can upgrade the Jackpot's code, set its hGRAM wallet and the Hipo
  parent and wallet code, return hGRAM that arrived without a notification or came back from a payout, settle a rolled-back unstake, set the
  parameters (burn share up to 20%, smallest pot, burn batch, minimum deposit, `rise_min`, `min_gap`), set the jetton
  content, set the halter, clear the falling flag, withdraw GRAM above `float_high` and the node float, and retire,
  set the successor, withdraw for owners and close subtrees.
- **The halter** can halt deposits, submits and boundaries. Only the governor resumes. Withdrawals never stop.
- **The keeper** is whoever sends `poke` after a reward, `submit_randomness` for a waiting draw, and `refill` when the
  float is low. Anyone can be one; a submitter is refunded plus 0.02 GRAM, and a poke is paid by its sender. If nobody
  pokes, no boundary is made and nothing is lost; if nobody submits, the draw is skipped at the next boundary. Any
  `skip` is an alarm.
- **Anyone** can `sweep` a retired Jackpot that owes nothing.

All governor and halter operations have a script in `scripts/` that prints what it will send and asks for confirmation
before it sends it.

**The governor is a multisig contract.** On 2026-10-28 the Hipo treasury's governor
(`EQCmLCYAu1Phlkb3cUIKDFwDpBfP2vXDCjFCUmgpimCR73gf`) answered `get_multisig_data` with threshold 2, so a single wallet
cannot send a governor message. Check again before relying on it. The governance scripts therefore also offer `b` at
the confirmation: it sends nothing and prints the destination, value and message body (base64), for the multisig's own
flow to submit as an order. Without `b` a script sends from the connected wallet, which works only if that wallet is
the governor (the scripts warn when it is not). The halter may be a plain wallet.

## Upgrades

The old code calls the new code's `migrate` by its method id, in the same transaction (`set_c3`). So every future
version must define `migrate` as a `method_id` under exactly that name. `migrate` must keep `tag` and the draw state,
must end with `throw(0)` (so the old code never saves over it), must accept data already at its own version (an upgrade
to the same code must succeed; the dry run does exactly that), and must never lower `tag`: nodes compare it with the tag
of each message to decide when to fold. `upgrade_code` saves the data before `set_code`, because the tick may have
changed it in memory. If `migrate` cannot read the stored layout, the transaction throws and the old code and data stay.
Wallet and node code cannot be upgraded. The undo of a bounced `deposit_booked` expects the owner's address at the end of
the booking's reply cell, so a future upgrade must keep that layout while a `deposit_booked` may be in flight.

## Operator's checklist

- **A Hipo treasury or wallet upgrade:** its checklist must include the Jackpot. Check that `provide_current_quote`
  still answers only the sender and echoes `custom_payload` unchanged, that the rate never falls, that `unstake_tokens`,
  `withdrawal_notification` and the rollback path still behave the same, that `send_tokens` honours `return_excess`
  and the notification rules, and that the Jackpot's wallet and the wallet code are still right
  (`scripts/setHipoWallet.ts` for a k = 1 change; the Hipo migration upgrade otherwise).
- **The keepers:** run two. Poke shortly after each reward and submit for each waiting draw. A skip is an alarm, so is
  `float < float_low`, and so is no boundary for one and a half times the expected rhythm. Any `lost` log means a node's
  sums disagree.
- **Before a deploy or upgrade:** `npm run check`, read the code hashes the script prints, and for an upgrade halt
  deposits and wait until no draw is resolving. One that is waiting is fine.
- **Monitoring** (the keepers' operators run it):
  - wallet and node balances. A frozen node loses updates, so top nodes up before the reserve runs out. A wallet frozen
    with a balance can be revived with its exact last state (`scripts/reviveWallet.ts`).
  - the top node's `committed + added - removed` must equal `tickets` once settled (`get_node_data`,
    `get_jackpot_state`). A difference means an update was lost.
  - `unstaking_tokens > 0` past two rounds: check the wallet, then `scripts/settleUnstake.ts`.
  - hGRAM outside `held_tokens` (the untracked hGRAM): a payout that came back, to return with `scripts/returnTokens.ts`.
  - the fees are sized at 400 nano-GRAM per gas unit; mainnet config 21 is 66.67. Re-measure if the price rises.
- **The tree:** watch `next_position`. At 16,777,216 positions new wallets get their tokens back, and existing wallets,
  withdrawals and draws go on.
- **If drand stops:** the waiting draw waits, and the next boundary skips it; deposits and withdrawals go on.
- **Moving to a new Jackpot:** `retire`, `setSuccessor`, let players withdraw to the successor (or `withdrawFor`),
  then `sweep`, and `closeSubtree` for any node left standing.

## Scripts

Run with `npx blueprint run <name>`. They send nothing until they have printed the message and asked.

| Script | What it does |
| --- | --- |
| `deployJackpot` | Deploys against Hipo's mainnet contracts; reads the first rate on chain, checks the settings and the `jGRAM` symbol, shows the deploy data; sends only on typing `deploy`, then offers a poke |
| `showState` | Prints every getter (read-only) |
| `poke` | Pokes the Jackpot (anyone) |
| `submitRandomness` | Fetches the drand round the draw waits for and submits it |
| `refill` | Refills a float too low to run a draw |
| `sweep` | Ends a retired Jackpot that owes nothing (anyone); brings the cost of closing the tree |
| `reviveWallet` | Revives a frozen jGRAM wallet with its exact last state |
| `setHalted` | Halt (halter or governor) or resume (governor) |
| `clearFalling` | Clears the falling-rate flag |
| `setParams` | Burn share, smallest pot, burn batch or minimum deposit |
| `setRiseMin` | Sets the rise of the rate that makes a boundary |
| `setMinGap` | Sets the least time between boundaries, from the next boundary |
| `setHalter` | Sets the halter |
| `withdrawSurplus` | Sends GRAM above the float to the governor |
| `settleUnstake` | Clears a stuck unstake: back into `held_tokens` (rolled back) or only the count (paid) |
| `returnTokens` | Returns hGRAM that arrived without a notification, or came back from a payout |
| `setHipoWallet` | Sets the Hipo parent, the Jackpot's wallet and the wallet code (halted, k = 1) |
| `setTreasury` | Sets the Hipo treasury the pokes ask (halted, k = 1) |
| `rescueJetton` | Sends a held foreign jetton on (never the hGRAM wallet) |
| `rescueNft` | Sends a held NFT item on |
| `retire` | Retires the Jackpot: no more deposits, for good |
| `setSuccessor` | Sets the successor of a retired Jackpot, checking its deposit fee against the successor's |
| `withdrawFor` | Withdraws everything for a batch of up to 100 owners |
| `closeSubtree` | Lists the highest nodes still standing after a sweep and restarts the close at one |
| `upgradeCode` | Upgrades the Jackpot's code |
