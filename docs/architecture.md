# Jackpot Architecture

This document explains how the Jackpot contracts work together, how a draw runs, and which invariants
any change must preserve. The decisions and their reasons are in the approved spec,
[`specs/2026-10-27-jackpot-v1.md`](specs/2026-10-27-jackpot-v1.md); the message layouts are in
`contracts/schema.tlb`.

Terminology: GRAM is the network coin (rebranded from TON), hGRAM is Hipo's jetton. The network itself is
still called the TON blockchain.

## The big picture

Players deposit GRAM or hGRAM. The **Jackpot** contract keeps everything as hGRAM in its own hGRAM
wallet, so all the money keeps earning Hipo's staking yield. For each player it books a **principal**:
the GRAM they are owed back, fixed at the moment of booking at Hipo's own exchange rate. Because the
rate only rises, the hGRAM held is worth more than the principal owed. The difference is the **pot**.

After each validation round, a **draw** pays the pot to three winners (50% / 30% / 20%) chosen at random
in proportion to the principal each player had booked early enough. Part of the pot, 10% at first, is
sent to the HPO **burner**. A player can withdraw their principal at any time.

Nothing in Hipo changes for this. The Jackpot is an ordinary hGRAM holder that asks Hipo's treasury for
its exchange rate with a message the treasury already answers.

## The contracts

| Contract | How many | What it does |
| --- | --- | --- |
| **Jackpot** (`contracts/jackpot.fc`) | one | Holds all hGRAM and all counters, runs deposits, withdrawals and draws, verifies drand, pays out. Upgradable by the governor. |
| **Range** (`contracts/range.fc`) | one per booking | Records one booking: owner, principal booked (`length`) and what is still in (`live`). Address follows from (Jackpot, `b`, the hash of its level-1 node's address). The owner withdraws by sending to it. Never deletes itself. |
| **Node** (`contracts/node.fc`) | one per 64 children | Holds, for each of 64 children, the live tickets below it. Four levels. The top node covers 16,777,216 bookings. |
| **Hipo treasury, parent, wallet** | Hipo's | The exchange rate, the mint of hGRAM, and the Jackpot's hGRAM wallet. |
| **drand** (`contracts/imports/drand.fc`) | library code | Checks a drand quicknet signature on chain. |
| **Burner** | Hipo's | Swaps the hGRAM it receives into HPO and burns it. |

The range and node code are fixed. They are stored in the Jackpot's data so that it can deploy them and
compute their addresses, and they cannot be upgraded. Only the Jackpot's own code can be.

### The tree

The Jackpot counts every live deposit in a tree of small contracts. One nano-GRAM of a range's live part
is one **ticket**, and tickets are numbered by booking order (`b`), then by offset in the range. A draw
picks a random position among the eligible tickets and walks down the tree to the range that holds it.
Money that left takes no space in later draws.

- A level-1 node has the ranges `64q ... 64q+63` as children. A level-`l` node has the level-`l-1` nodes
  `64q ... 64q+63`. The Jackpot is the parent of the top node.
- Every change of live tickets goes down as `update(tag, deferred, b, delta)`; every draw search goes down
  as `descend(draw, slot, attempt, k)`. Both travel the same parent-to-child pairs, and TON delivers
  messages between two accounts in order, so a search sees exactly the updates sent before it.
- A node accepts messages only from its parent, a range accepts `check` only from its level-1 node, and
  the Jackpot accepts `withdrawn`, `hit` and `miss` only from the range at the `b` the message names.

Each deposit fee carries a share of the cost of opening nodes and ranges, so storage rent for them is paid
up front, for at least ten years.

## Message flows

### Deposit

GRAM:

1. The player sends `deposit` with GRAM to the Jackpot.
2. The Jackpot keeps its fee, sends the treasury `deposit_coins` with `owner` = the Jackpot and a fresh
   `query_id`, and records `query_id -> (player, coins, cap, time)` as pending, where `cap` is the most the mint may book at the stored quote.
3. The treasury mints hGRAM to the Jackpot's wallet, which sends `transfer_notification` with that
   `query_id`.
4. The Jackpot matches the record and, only when the minted amount is at least `cap - cap/100`, puts `min(amount, cap)` in flight and goes on as for an hGRAM deposit. Anything above `cap`, or a mint below that band, stays in the wallet outside `T` for the governor.

hGRAM: the player transfers hGRAM to the Jackpot with a forward amount large enough for the deposit fee.
The notification from the Jackpot's wallet names the player and puts the tokens in flight (`I`).

### Booking

1. The Jackpot asks the treasury for a quote (`provide_current_quote`) and keeps the request under a fresh
   `query_id`.
2. On `take_current_quote` it stores the rate and computes the principal `c = floor(t * TC / TT)` for the
   `t` hGRAM received.
3. If `c` is below the minimum deposit (less 1%), the Jackpot is halted, the tree is full or the rate has
   fallen, the hGRAM goes back to the player. Otherwise it books `c`: it gives the booking index `b = n`,
   deploys the range with its one-time setup, and sends the top node `update(+c)`. The first booking of a
   node opens that node on the way.

Booking what the minted tokens are worth, not the GRAM sent, means a fee inside Hipo can never make the
Jackpot owe more than it holds.

### Withdrawal

1. The owner sends `withdraw(x)` to their range (`x = 0` means everything). The range checks the owner and
   the fee, lowers `live`, and sends `withdrawn(b, owner, x)` to the Jackpot. If that bounces, `live` is
   restored.
2. The Jackpot checks that the sender is the range at `b`, lowers the eligible count, sends the node tree
   `update(-x)`, and asks for a quote.
3. On the quote it pays `w = min(floor(x * TT / TC), floor(F * x / P))` hGRAM to the owner and lowers `P` by
   `x`. Until then `x` stays in `P`, so a draw in between cannot pay out tokens that are owed.

Withdrawals work while the Jackpot is halted and while the rate has fallen. A withdrawal made during a
draw's window from a range that can win that draw is held back in the tree for that draw only (so its
positions do not move) and pays a surcharge for the retries it can cause, priced at the measured cost of one attempt (`fee::attempt`, last value of `get_jackpot_fees`).

### Draw

A draw moves through four states: idle, quoting, waiting for drand, resolving.

1. **Start.** Anyone sends `start_draw`. It is refused unless the draw is idle, the Jackpot is not halted,
   the rate-fell flag is down, and a new validation round has begun since the last start (config parameter 34). The Jackpot asks for a
   quote. On the reply, if the rate has not risen or the pot is below the smallest pot, it goes back to
   idle with nothing changed. If nobody is eligible yet, the start only records the new period (the cutoff moves up, no draw opens, the pot rolls over). Otherwise it fixes the pot, the burn and the three prizes, fixes the drand
   round `R` about a minute ahead, sets the cutoff `E` and the eligible count, and waits for drand. This is
   the start of the **draw window**.
2. **Randomness.** After drand publishes `R`, anyone sends `submit_randomness(signature, witness)`. The
   Jackpot checks the witness for the hash-to-curve reduction, then the BLS pairing on chain. A wrong
   signature throws, so the sender pays. The seed is `sha256(signature)`. The `scripts/submitRandomness.ts`
   script fetches the round and builds the witness.
3. **Descent.** For each open slot anyone sends `locate(slot)`. The Jackpot computes the position
   `k = sha256(seed, slot, attempt) mod eligible` itself and sends `descend` to the top node. The search
   reaches a range, which answers `hit` (the ticket is live: the owner wins) or `miss` (the ticket was
   withdrawn in the window: try the next attempt). After 16 misses the prize rolls over into the next pot.
   A node whose sums do not cover the position answers `lost`, which counts as a miss and is logged.
4. **Payout.** On a `hit` the Jackpot pays the prize in hGRAM to the winner as a recorded payout.
5. **Burn.** When the draw is idle again, once the burn owed reaches the burn batch the Jackpot sends it
   to the burner as an hGRAM transfer that forwards 0.5 GRAM, which pays for the swap.

A slot nobody located within one validation round after the randomness may be expired by anyone, and its
prize rolls over.

### Payouts

Every outgoing hGRAM transfer is bounceable and recorded under a fresh `query_id` until the recipient's
wallet confirms it with `gas_excess`. `claim` pays the owner's prize balance and other balance as two payouts. A bounce from the Jackpot's wallet returns the amount to the counters; a bounced burn goes back to
`burn_owed`, and any other payout becomes the owner's claimable balance. A `gas_excess` from the Jackpot's own wallet proves nothing, because
anyone can make it send one; the governor closes a payout whose second hop really failed with
`settle_failed_payout`, after finding the bounce on chain.

## The state

The Jackpot's storage does not grow with the number of players. Its counters:

| Name | Meaning |
| --- | --- |
| `T` | hGRAM held, by its own count |
| `I` | hGRAM received and not yet booked |
| `O` | hGRAM set aside: prizes of the running draw, burn not yet sent, bounced payouts |
| `F` | free hGRAM, `T - I - O` |
| `P` | principal owed, including withdrawals not yet paid |
| `n` | the next booking index |
| `E` | the running draw's cutoff: only ranges with `b < E` can win |
| `L_lo`, `L_hi` | live tickets of ranges below and above the next draw's cutoff |
| `TC`, `TT` | the latest quote: Hipo's `total_coins`, `total_tokens` |

`npm run start showState` prints all of them in readable units.

## Invariants

A change must keep all of these.

- **Solvency: `F * TC >= P * TT`.** The free hGRAM covers all principal at the latest quote. Every
  rounding goes in the pool's favour: bookings round principal down, withdrawals round hGRAM down, the pot
  rounds what is kept for principal up, the surcharge rounds up. The `min` in the withdrawal formula is
  for the one case where the rate falls: then the loss is shared pro rata.
- **Counters add up.** `T = I + O + F`, and `T` equals the hGRAM the Jackpot's wallet holds, less what
  sits outside `T` (transfers without a notification, the excess of a mint over its cap), which only the
  governor can return.
- **Eligibility lags one period.** A deposit booked after a draw starts has `b >= E` for that draw and
  for the next one's cutoff. Nobody can join a draw that has already started, and every position below the
  eligible count is a ticket of a range with `b < E`.
- **Split-neutrality.** Each attempt gives every eligible ticket the same chance, `1/draw_L`, so a player's
  chance depends on their total eligible principal, not on how many wallets or ranges hold it.
- **Positions cannot be moved after the seed is known.** From the draw's start, withdrawals from ranges
  with `b < E` are deferred, so the positions below the eligible count stay as they were; bookings and
  other withdrawals only change positions past it. A player can only empty their own position.
- **Tree consistency.** Every node's sums equal the live tickets of its children, outside the draw window
  and after deferred updates are folded in. A withdrawn ticket takes no position in any later draw.
- **Handlers of replies never throw.** The quote reply, the mint notification, `hit`, `miss`, `lost`,
  bounces and `gas_excess` refund, return or hold instead of throwing, because Hipo's replies are not
  bounceable. A reply with an unknown or stale `query_id` is ignored.
- **Every entry message pays its whole chain.** Each carries a fixed minimum value (`get_jackpot_fees`);
  nothing an outsider starts is paid from the Jackpot's own GRAM.
- **A falling rate stops the money moving.** If a quote is lower than the stored one, the Jackpot stores it,
  raises a flag, starts no draw, books nothing new, and gives prizes back to `F`. Only the governor clears
  the flag (`scripts/clearFalling.ts`).

## Recovery operations and the verify mode

`resolvePending`, `returnTokens` and `settleFailedPayout` all give out hGRAM from one pool: the Jackpot
wallet's balance W less T (what the Jackpot counts as its own). Open payouts may still be in transit and
pending mints may land, so the first two check against W - T less every open payout record; an operator can
leave a payout out only by typing its id after checking that it was delivered, and each excluded record is
shown. `settleFailedPayout` checks against W - T alone, because the payout it closes is itself a claim on the
pool. W and T are read twice, about 10 seconds apart, and the smaller W - T is used. A wallet that does not
exist yet counts as W = 0.

When the governor is a multisig, a printed order (`b`) states the W - T it was checked against and what it
consumes, and is valid only if no other recovery order is pending. Signers should run the same script with
`v` at the first prompt just before signing: it re-reads everything, runs every check, prints PASS or FAIL
and sends nothing.

## Roles

- **The governor** (Hipo's; a contract, see below) can upgrade the Jackpot's code, set its hGRAM wallet and the Hipo parent and
  wallet code, book a stuck pending deposit (`resolve_pending`), return hGRAM that arrived without a
  notification, settle a failed payout, set the parameters (burn share up to 20%, smallest pot, burn
  batch, minimum deposit), set the halter, clear the falling flag, and withdraw GRAM above the storage
  float.
- **The halter** can halt deposits and draw starts. Only the governor resumes. A running draw completes
  and withdrawals never stop.
- **The keeper** is whoever sends `start_draw`, `submit_randomness` and `locate`. Hipo runs one, at about
  0.3 GRAM a round, but every step is open to anyone. If it stops, draws pause and nothing is lost.

All governor and halter operations have a script in `scripts/` that prints what it will send and asks for
confirmation before it sends it.

**The governor is a multisig contract.** On 2026-10-28 the Hipo treasury's governor
(`EQCmLCYAu1Phlkb3cUIKDFwDpBfP2vXDCjFCUmgpimCR73gf`) answered `get_multisig_data` with threshold 2, so a
single wallet cannot send a governor message. Check again before relying on it. The governance scripts
therefore also offer `b` at the confirmation: it sends nothing and prints the destination, value and message
body (base64), for the multisig's own flow to submit as an order. Without `b` a script sends from the
connected wallet, which works only if that wallet is the governor (the scripts warn when it is not). The
halter may be a plain wallet.

## Upgrades

The old code calls the new code's `migrate` by its method id, in the same transaction (`set_c3`). So every
future version must define `migrate` as a `method_id` under exactly that name. `migrate` must keep
`draw_id` and the draw state, must end with `throw(0)` (so the old code never saves over it), must accept data
already at its own version (an upgrade to the same code must succeed; the dry run does exactly that), and must
never lower `draw_id`: nodes compare it with the tag of each
message to decide what is held back. If `migrate` cannot read the stored layout, the transaction throws
and the old code and data stay. Range and node code cannot be upgraded.

## Operator's checklist

- **Hipo turns `instant_mint` off:** halt the Jackpot's GRAM deposits first (`scripts/setHalted.ts`). With
  it off, a deposit becomes a bill that mints at the end of a round, under a `query_id` the Jackpot cannot
  match one-to-one; deposits left pending are booked with `scripts/resolvePending.ts` once they are older
  than two validation rounds. Book only tokens that actually sit in the Jackpot's wallet outside `T`, never
  more: with `instant_mint` off a record can match someone else's bill. hGRAM deposits are not affected.
- **A Hipo treasury or wallet upgrade:** its checklist must include the Jackpot. Check that
  `provide_current_quote` still answers with the same message, and that the Jackpot's wallet and the
  wallet code are still right (`scripts/setHipoWallet.ts` when Hipo migrates wallets).
- **The keeper:** a draw should start within two rounds of a round change, and a draw waiting for drand
  longer than ten minutes is a signal. Any `lost` log means a node's sums disagree with the ranges.
- **Before a deploy or upgrade:** `npm run check`, read the code hashes the script prints, and for an
  upgrade halt deposits and wait until no draw is running.
- **Monitoring** (the keeper's operators run it):
  - node and range balances. Their storage reserve is sized for ten years; a frozen node or range cannot
    be revived with its original StateInit, so top them up well before the reserve runs out.
  - the top node's `committed` sum minus what it holds back (`held`) must equal the Jackpot's
    `L_lo + L_hi` (`get_node_data`, `get_jackpot_state`). A difference means an update was lost.
  - the fees are sized at 400 nano-GRAM per gas unit, as the basechain config had when they were
    measured; mainnet config 21 is now 66.67. The fees are therefore generous. Re-measure if the price
    rises.
- **The tree:** watch `n`; at 16,777,216 bookings new bookings are returned until an upgrade adds room.
- **If drand stops:** draws wait; deposits and withdrawals go on. Withdrawals made while a draw waits pay
  the surcharge.

## Scripts

Run with `npx blueprint run <name>`. They send nothing until they have printed the message and asked.

| Script | What it does |
| --- | --- |
| `deployJackpot` | Deploys against Hipo's mainnet contracts; shows the deploy data; sends only on typing `deploy` |
| `showState` | Prints every getter (read-only) |
| `submitRandomness` | Fetches the drand round the draw waits for and submits it |
| `setHalted` | Halt (halter or governor) or resume (governor) |
| `clearFalling` | Clears the falling-rate flag |
| `setParams` | Burn share, smallest pot, burn batch or minimum deposit |
| `setHalter` | Sets the halter |
| `withdrawSurplus` | Sends GRAM above the float to the governor |
| `resolvePending` | Books a stuck pending GRAM deposit |
| `returnTokens` | Returns hGRAM that arrived without a notification |
| `settleFailedPayout` | Closes a payout whose second hop failed |
| `setHipoWallet` | Sets the Hipo parent, the Jackpot's wallet and the wallet code |
| `upgradeCode` | Upgrades the Jackpot's code |
