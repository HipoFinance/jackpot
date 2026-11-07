# Hipo Jackpot: fees priced at current prices

**Status:** implemented

Amends [`2026-11-03-jackpot-v2-amendment-1.md`](2026-11-03-jackpot-v2-amendment-1.md), as built at 76e934c. That
spec holds except where this one changes it.

## Goal

Lower the GRAM a user must attach, from 0.51 GRAM for a deposit to about 0.091 at today's prices, by pricing every
user-side fee at the chain's current prices instead of fixed constants sized at 400 nano-GRAM per gas, while keeping
every chain safe if prices rise in flight.

## In plain terms

Today each step's fee is a fixed number, sized for gas six times dearer than it is now, and a deposit also pays
0.25 GRAM of insurance against a failure that has no known cause. So a user attaches 0.51 GRAM to enter. Most of it
comes back, but the number puts people off.

After this change the Jackpot reads the current gas, forwarding and storage prices from the chain and computes each fee
from them. It adds double the price (triple on the legs where a shortfall would be hardest to undo) on what a later
step spends, so a price jump during the few seconds a chain runs still leaves it room. The 0.25 GRAM insurance goes;
if that failure ever happens, the Jackpot's own GRAM covers it, at most about 0.066 GRAM. A deposit then needs about
0.091 GRAM, a burn 0.079. If prices rise to the old level, the fees rise with them, to about what they are now, and
nothing breaks for good.

**Decisions needed:** none open; see Open questions for the decided recommendations.

## Definitions

- **Current prices**: configs 20 and 21 (gas), 24 and 25 (forwarding) and 18 (storage), read on chain with
  `GETGASFEE`, `GETFORWARDFEE`, `GETFORWARDFEESIMPLE` and `GETSTORAGEFEE` (basechain).
- **`due_payment()`**: c7 parameter 15 (`DUEPAYMENT`, global version 6 and later; mainnet is at 17): the storage debt
  left after this transaction's storage phase. For a non-bounceable message it reads 0, since the debt is taken from
  the message's value first.
- **User-side fee**: a minimum a user's message must carry: deposit, burn, `w`, poke, submit, refill, TEP-89,
  `withdraw_for` per owner. **Float-side constant**: what the Jackpot's own GRAM pays: `fee::search`,
  `fee::draw_budget`, `fee::foreign_return`, `fee::burn_forward`; they stay constants.
- **Headroom**: the factor applied to value a later transaction spends, so it survives a price rise before that
  transaction runs. `H = 2` in general; 3 on `release` and on the refused-burn leg of the wallet's minimum.
- **Gas bound**: a gas figure the fee formulas use, at least 1.5 times the gas measured on the built code.
- **Wallet minimum (internal)**: what the jGRAM wallet checks on every burn, the owner's and the Jackpot's, a formula
  frozen in the wallet's fixed code: enough for the Jackpot to reach its own fee check, throw, and bounce the burn back
  to a wallet that can still run `on_bounce`. Apps attach
  `max(burn fee, get_wallet_minimum_internal() + payload_fee + fwd_simple(payload) + debt)` plus a small margin, with
  `debt = max(0, stored due_payment + storage_fee(now − last_paid) − balance)` from the wallet's account state;
  `burnAttach` in `wrappers/Jackpot.ts` computes it. The burn fee here is `get_burn_fee(forward, cells, bits)` for the
  burn's own payload and forward amount; `get_jackpot_fees().withdraw` is only the no-payload burn fee. A wallet in
  debt needs more than the burn fee; a wrong attach only causes a refusal, never a loss.

**Formula parameters** (all amounts in nano-GRAM; every price function rounds up, as the TVM's do)

| Name | Meaning | Unit | Rounding / value |
|---|---|---|---|
| `gas(g)` | `GETGASFEE(g, basechain)` | nano-GRAM | up |
| `fwd(c, b)` | `GETFORWARDFEE(c, b, basechain)`: lump + bits + cells beyond the root | nano-GRAM | up |
| `fwd_simple(c, b)` | `GETFORWARDFEESIMPLE`: the same without the lump | nano-GRAM | up |
| `store(c, b, s)` | `GETSTORAGEFEE(c, b, s, basechain)` | nano-GRAM | up |
| `H` | headroom on later-spent value | factor | 2 |
| `G_J` | gas bound, a Jackpot handler (`bound::jackpot`) | gas | 60,000: 1.5 times `burn_notification` with a cap-size payload, measured 39,386 (`deposit_ready` 35,825) |
| `G_W` | gas bound, a wallet handler (`bound::wallet`) | gas | 18,000: 1.5 times the wallet's `burn` with a cap-size payload, 11,709 |
| `G_T` | gas bound, the TEP-89 handler (`bound::tep89`) | gas | 28,000: 1.5 times the measured 18,126 with `include_address` (17,546 without) |
| `G_N` | gas bound, a node hop | gas | 110,000: 1.5 times the measured worst case, 73,226 (a level-1 fold of all 64 children plus `owners_set`; 66,625 at level 4) |
| `G_P` | gas bound, the poke handler | gas | 22,000: 1.5 times the measured 14,070 |
| `G_pre` | the Jackpot's gas up to its fee check in `burn_notification` | gas | 30,000, a rule for every future Jackpot; measured 12,087 (a short burn throws at the check) |
| `G_S` | gas bound, `submit_randomness` | gas | 150,000 |
| `hop` | one node hop: `gas(G_N) + fwd(1, 545)`, the update with an owner | nano-GRAM | sum of rounded terms |
| `update_min` | `4·hop`, a tree update at the current price | nano-GRAM | exact |
| `update_value` | `H·update_min`, what an update is sent with when the value allows | nano-GRAM | exact |
| `release` | `3·(gas(G_W) + fwd(0, 0))`: `deposit_cancelled`, `close_wallet` | nano-GRAM | exact |
| `hipo_send` | Hipo's `send_tokens_fee`: `store(2, 658, 5y) + gas(22,369) + fwd_simple(2, 543)` | nano-GRAM | as Hipo's |
| `hipo_unstake` | Hipo's `unstake_tokens_fee`, the same formula as Hipo's | nano-GRAM | as Hipo's |
| `payout_fee` | `2·hipo_send + 3·(fwd(10, 9,700) − fwd(2, 1,023))`: a payout with a cap-size payload, a move's `deposit_options` or a refund's `deposit_refused` | nano-GRAM | exact |
| `payload_fee` | `8·fwd_simple(c, b)` for the real payload size from `CDATASIZE`; cap 8 cells as now | nano-GRAM | up |
| `wallet_storage` | `store(c_W, b_W, 5 years)`, `c_W` and `b_W` the built wallet's size: 28 cells, 13,153 bits | nano-GRAM | up |
| `node_share` | as now: the float's share of node openings, kept for a new position | nano-GRAM | constant |
| `booked_min` | `node_share + fwd(1, 545) + fwd(log) + fwd(booked) + 2·fwd_simple(payload) + H·gas(G_W)`: what `deposit_ready` must keep for the update's forwarding, the log, `deposit_booked` carrying the payload and its bounce, and its handler | nano-GRAM | exact |
| `value_left` | the incoming value less this transaction's gas so far and what it has sent: the code's `value_left(spent)` | nano-GRAM | exact |
| message sizes outside the root cell | `prepare` (`c_W + 2`, `b_W + 1,241`) = (30, 14,394), `ready` (2, 1,241), `log` (1, 1,023), `booked` (1, 600), `burn_note` (2, 1,023), the refused burn's bounce (3, 1,176) | cells, bits | upper bounds |

**The fees.** Each line says where it is checked and against which value.

```
deposit      = max( gas(G_J) + fwd(prepare)
                    + H·(gas(G_W + G_J + G_W) + fwd(ready) + fwd(log) + fwd(booked) + 3·fwd(0,0))
                    + update_value + node_share + wallet_storage,
                    gas(G_J) + fwd(prepare) + H·(gas(G_W + G_J) + fwd(ready) + fwd(log)) + release + payout_fee )
               + inner forward amount + payload_fee
             checked at transfer_notification against its incoming value

burn         = gas(G_W) + fwd(2 + pc, 1,023 + pb) + H·(gas(G_J) + fwd(log) + fwd(0,0)) + update_value + release
               + payout_fee + forward amount + payload_fee
             what the owner attaches, (pc, pb) the payload's cells and bits: the wallet's leg carries the payload in
             burn_notification. The Jackpot checks, at burn_notification, the part that arrives:
             incoming ≥ burn_arrives = burn − gas(G_W) − fwd(2 + pc, 1,023 + pb)

wallet_minimum_internal
             = gas(G_W) + fwd(burn_note + payload)
               + 3·(gas(G_pre) + fwd(3, 1,176) + gas(G_W) + fwd(0,0))          (the refused-burn leg, headroom 3)
               + due_payment()
             checked by the wallet on an owner's burn: incoming ≥ wallet_minimum_internal

w            = gas(G_J) + fwd(prepare) + H·(gas(G_W) + fwd(burn_note)) + burn_arrives
             checked at the Jackpot's `w` handler against its incoming value; the burn it sends then arrives at
             burn_notification with at least burn_arrives, the same check as an owner's burn. The burn's comment is
             priced at (pc, pb) = (1, 256), an upper bound for "Hipo Jackpot withdrawal" (216 bits) and
             "Hipo Jackpot: moved" (184 bits)

burn fee for a payload and a forward amount: get_burn_fee(forward, cells, bits) gives `burn` above for that payload
             and forward amount; get_jackpot_fees().withdraw is the burn with no payload and no forward amount

poke         = gas(G_P) + fwd(1,1023) + H·(gas(40,000) + 2·fwd(1,1023))
             the 40,000 covers the treasury's quote and the reply: 21,854 measured (the quote alone 5,803)
submit       = gas(G_S) + fwd(1,1023) + 2·fwd(0,0)
refill       = gas(G_J) + fwd(1,1023) + unstake,        unstake = H·hipo_unstake
tep89        = gas(G_T) + fwd(1,1023)
withdraw_for : value_per_owner ≥ per, and incoming ≥ n·value_per_owner + gas(gas_consumed() + 10,000),
             per computed once, outside the loop; value_per_owner chosen by the governor and sent with each burn
```

## Context

- **Constants today**, sized at 400 nano-GRAM per gas: `fee::handler` 0.02, `fee::node_hop` 0.035, `fee::payout` 0.05,
  `fee::payload` 0.02, `fee::wallet_storage` 0.026 GRAM (`jackpot/contracts/imports/constants.fc:183-229`).
- **`fee::bounce_floor`** = update + release + payout + 2 handlers + 0.01 = 0.25 GRAM, inside `fee::deposit`
  (`constants.fc:234-240`); `fee::withdraw`, `fee::comment_withdraw`, `fee::submit`, `fee::poke`, `fee::refill`,
  `fee::wallet_address` (`:243-261`); `fee::withdraw_for_gas` (`:288`); float-side constants, `fee::draw_budget` built on
  `fee::unstake` (`:255`, `:290-296`).
- **The checks:** deposit at `transfer_notification` (`jackpot/contracts/jackpot.fc:751`); `deposit_ready` refusal and
  booking (`:771-842`); `burn_notification` sends the update before any fee check (`:867-908`); `pay_rest`'s
  drop-forward rule and `refund` on `fee::payout` (`:478-499`); `send_update` with `fee::update` (`:526-553`); poke
  `:939`, submit `:1128`, refill `:1156`, `w` `:1391`, TEP-89 `:1401`; `withdraw_for` (`:1443-1468`); the undo of a
  bounced `deposit_booked` (`:1324-1344`); `get_jackpot_fees` (`:2106-2124`).
- **The wallet** tops its reserve up to the constant `fee::wallet_storage` (`jackpot/contracts/wallet.fc:110`, `:180`,
  `:262`) and checks an owner's burn against `fee::withdraw (+ payload)` (`:190-203`). Its code is fixed once deployed.
- **Storage debt on a bounceable message.** The storage phase runs first and takes what it can from the account's
  balance; what it cannot is left as debt, not taken from the message. A non-bounceable message pays the debt from its
  own value first. Accounts stay active until the debt passes config 20's `freeze_due_limit`, 0.1 GRAM.
- **Hipo's fees:** `send_tokens_fee` and `unstake_tokens_fee` (`HipoFinance/contract/contracts/imports/utils.fc:438`,
  `:497`). Mainnet `get_wallet_fees`: send_tokens 2,360,624, unstake 11,852,611 nano-GRAM.
- **Mainnet prices,** read from both of our liteservers on 2026-11-06, masterchain seqno 103,697,796: gas 66.667
  nano-GRAM per gas (config 21); forwarding lump 66,667, 66.667 a bit, 6,666.7 a cell (config 25); storage 0 a bit,
  135 a cell, in 2⁻¹⁶ nano-GRAM a second (config 18); global version 17.
- **The formulas and figures** were computed with the design's calculator (`calc.py`, `calc2.py`), outside the repo.

## Approach

### Results

| Fee | Now (constants) | Today | At 400 |
|---|---|---|---|
| deposit | 0.512 | 0.0907 | 0.515 |
| burn, no payload | 0.26 | 0.0794 | 0.502 |
| `w` | 0.271 | 0.0862 | 0.557 |
| poke | 0.07 | 0.0075 | 0.051 |
| submit | 0.12 | 0.0103 | 0.064 |
| refill | 0.14 | 0.0282 | 0.211 |
| TEP-89 | 0.04 | 0.0020 | 0.013 |

GRAM attached, as measured from the built Jackpot's `get_jackpot_fees`, with the final bounds (`G_J` = 60,000,
`G_W` = 18,000, `G_N` = 110,000, `G_P` = 22,000, `G_T` = 28,000) and wallet size (28 cells, 13,153 bits). "At 400"
means 400 nano-GRAM per gas with the old forwarding prices. The burn is the no-payload fee; a burn with a payload or a
forward amount costs more, and `get_burn_fee` gives it. At 400 nano-GRAM per gas the deposit is about today's constant,
but only when prices really are that high. An app also attaches Hipo's own transfer fee on top of a deposit: 0.0024
GRAM today. Unspent value comes back as before.

### Rules

1. **Every user-side fee is computed at current prices** in a shared `imports/fees.fc`, used by the Jackpot and, for the
   wallet's minimum and `wallet_storage`, by the wallet.
2. **Headroom only on value a later transaction spends:** 2 in general, 3 on `release` and on the refused-burn leg. The
   first transaction's own gas and its outgoing forwarding are priced at the price it sees.
3. **Later hops check only their bare need at the price they see** and pass any headroom on.
4. **Gas bounds are at least 1.5 times the measured gas** on the built code, and tests pin them.

### Changes in behaviour

- **The wallet's burn check (F1).** An owner's burn must carry `incoming ≥ wallet_minimum_internal (+ payload_fee)`,
  and that minimum includes `due_payment()`. **Why:** on a bounceable burn, a wallet with storage debt leaves the debt
  owed instead of taking it from the burn's value. If the Jackpot then refuses the burn, its bounce arrives
  non-bounceable, and the storage phase takes the debt out of the bounce's value first. With a low minimum, nothing may be
  left for `on_bounce`'s gas: the balance is not restored and no further bounce comes, so the player's principal is
  lost. Requiring the burn to bring the debt as well leaves the bounce its gas. For a non-bounceable burn
  `due_payment()` reads 0, and the check stays right. Amendment 1's 0.26 GRAM floor was immune only by its size.
- **The refused-burn leg carries headroom 3**, so a price step between the wallet and the Jackpot that would leave the
  bounce without gas must exceed 3 times, the same jump that would lose a node update.
- **A burn the Jackpot sends (`w`, `withdraw_for`) gets the same protection.** The wallet's `from_jackpot?` branch
  (`jackpot/contracts/wallet.fc:174-186`) skipped the minimum and `due_payment()`. A small price rise between the `w` or
  `withdraw_for` handler and `burn_notification` could make the Jackpot refuse the burn, and the bounce, carrying about
  0.045 GRAM, would lose the balance at a wallet whose debt is above about 0.044 GRAM. Now, in that branch, if
  `incoming < wallet_minimum_internal` (`due_payment()` included), the wallet does not burn: it sends the value on to
  its owner, as the `balance == 0` branch does. The branch still never throws. Its minimum is
  `wallet_minimum(cells, bits)` with the size of the comment the burn carries (`Hipo Jackpot withdrawal` or
  `Hipo Jackpot: moved`), not `(0, 0)`, since the comment rides in `burn_notification` and its bounce.
- **`deposit_ready`** checks `value_left ≥ update_min + booked_min` before booking, else refuses with `low_value`. It
  sends the update with `min(update_value, value_left − booked_min)` and `deposit_booked` with the rest, which is at
  least `booked_min` less the update's and log's forwarding. So `deposit_booked` always has its handler's gas at twice
  the price; if it ran out of gas there would be no bounce and the booked principal would be lost. **The first booking
  (position 0, `b = 0`)** also deploys the top node: its StateInit forwarding, `fwd(43, 22,721)` = 1,868,068
  nano-GRAM today, is paid by the float out of the reserve in `deposit_ready`, once in the Jackpot's life; the node's
  size is pinned by `node::cells` = 43 and `node::bits` = 22,721. Before the
  code review it came out of `deposit_booked`'s value, which could then run out of gas after a 1.3–2× price step and
  lose the first depositor's principal. **A refusal's refund** no longer ignores errors: if its send fails, the action
  phase fails and `deposit_ready` bounces, and the governor's `return_tokens(…, true)` recovers the tokens, as for any
  failed `deposit_ready`.
- **`burn_notification`** checks `incoming ≥ burn_arrives` (the forward amount and `payload_fee` included) right after the sender check, before any state changes, and throws when short. The burn bounces, and
  the wallet restores the balance. **Rule for every future Jackpot:** it must reach this check within `G_pre` = 30,000
  gas, since the wallet's frozen minimum pays only that much before the throw and the bounce. More would let a burn run
  out of gas with nothing left to bounce, and the wallet would not restore. The built code throws at the check after
  13,626 gas with an 8-cell payload.
- **`fee::bounce_floor` is removed.** The undo of a bounced `deposit_booked` checks `c` and `b` as now, and that the
  bounce comes from the owner's jGRAM wallet, then raises its (the owner is read from the bounce: the Jackpot appends
  it last in the `deposit_booked` reply cell; see Changes, step 3)
  own gas limit with `set_gas_limit(G_J)`, a fixed bound, never `accept_message`, paid by the float, and sends its update
  and `deposit_cancelled` with explicit values out of the balance. It must reach `set_gas_limit` within 20,000 gas, so the
  smallest bounce `deposit_booked` can carry, `fwd(booked) + H·gas(G_W)`, pays for the checks before it. So every bounce
  that can actually occur commits; a bounce carrying no GRAM at all would get no gas and its compute phase would be
  skipped, but `deposit_ready` never sends `deposit_booked` with less than that. The float's exposure is
  `update_value + release + gas(G_J) + fwd(1, 545) + 2·fwd(log)` per event, the last two the update's forwarding and
  two logs (about 0.3–0.4M nano-GRAM today): about 0.066 GRAM today, 0.40 at 400 nano-GRAM per gas, before the
  recomputation with the new bounds. **When the
  bounce carries less than `update_value + release + payout_fee`** (the undo's own sends come first, then the refund), the counters and the tree are still undone, but the refund is
  not sent: the hGRAM is left untracked, with an `untracked` log, for `return_tokens`. This reverses
  the code review's fix (F2, amendment 1), which made every deposit carry 0.25 GRAM for it. **Why that is sound now:**
  the trigger, `deposit_booked` failing at the wallet, has no known path. The wallet code is fixed, nothing in its
  `deposit_booked` throws, and `deposit_ready` now leaves it its gas at twice the price; a wallet cannot freeze or close
  while `pending > 0`, since it answered `deposit_ready` seconds before and freezing needs 0.1 GRAM of debt. The auditor
  found the trigger unreachable. So the float carries a bounded cost for an event that cannot be caused, instead of
  every depositor paying 0.25 GRAM.
- **`pay_rest`'s drop-forward rule and `refund`** use `payout_fee()` in place of `fee::payout`. The move threshold
  becomes `value_left(spent) ≥ successor_fee + fwd + payout_fee()`, with `spent` the update value actually sent.
- **`withdraw_for`** gains a governor-chosen `value_per_owner`, sent with each owner's burn: it must be at least the
  formula's `per`, computed once outside the loop, and `incoming ≥ n·value_per_owner + gas(gas_consumed() + 10,000)`.
  So a wallet whose storage debt is above what `per` covers can still be emptied at the end of life; with `per` alone,
  its minimum would refuse the burn, and its principal would block `sweep`. `fee::withdraw_for_gas` is deleted.
- **`fee::draw_budget` stays a constant** sized at 400 nano-GRAM per gas, with a new constant `fee::unstake_bound` =
  0.2 GRAM in place of the old `fee::unstake`: at 400 nano-GRAM per gas with the old forwarding prices (lump 1,000,000)
  the run-time unstake is 184.7M nano-GRAM. So `draw_budget` = 48 × 0.07 + 4 × 0.05 + 3 × 0.01 + 0.5 + 0.02 + 0.2 +
  3 × 0.16 + 100,000 × 400 nano-GRAM = 4.83 GRAM, still under `float_low` = 8 GRAM. **Why:**
  the float's check must be stable and conservative; `float_low > draw_budget` is pinned by a test, and a run-time
  budget would let a price fall make a draw start with less float than a later rise needs. A test checks that the
  run-time `unstake` stays at or below `fee::unstake_bound` up to 400 nano-GRAM per gas. The unstake itself is sent with
  the run-time `unstake`.
- **`get_jackpot_fees`** changes shape: it adds `payout_fee`, and `payload` becomes the cap-size value. The wallet's
  minimum depends on that wallet's debt. The wallet's getter `get_wallet_minimum_internal()` shows it with no storage
  debt: it never calls `DUEPAYMENT`, since getters run without a storage phase, so it works on any API's emulator.
  **Apps attach `max(burn fee, get_wallet_minimum_internal() + payload_fee + fwd_simple(payload) + debt)`** plus a
  small margin for a burn, with
  `debt = max(0, stored due_payment + storage_fee(now − last_paid) − balance)` read from the wallet's account state;
  `burnAttach` in `wrappers/Jackpot.ts` computes it. **The burn fee is `get_burn_fee(forward, cells, bits)`** (wrapper
  `getBurnFee`), for the burn's own forward amount and payload, since the wallet's leg carries the payload;
  `get_jackpot_fees().withdraw` is the burn fee with no payload and no forward amount, so an app that sends either must
  use `get_burn_fee`. A wallet whose storage debt is above the burn fee less the wallet's minimum needs more than the
  burn fee. A wrong attach only causes a refusal, never a loss.
  Every figure is at the current price, so apps read them each time and do not cache them.
- **`scripts/setSuccessor.ts`** requires a successor fee of at least 3 times the successor's current deposit fee, since
  the fee is frozen when set.

### Rejected alternatives

- **Trimming the constants only:** the deposit stays at about 0.18 GRAM, and it still breaks for good above 400
  nano-GRAM per gas.
- **Lowering the real gas:** it saves too little to justify re-auditing the fixed node code.
- **Skipping the `prepare_deposit` round trip:** it would need a position given by the caller, against the no-records
  design.
- **A run-time `draw_budget`:** see above.
- **Dropping the "undo with nothing" case:** the float exposure is already accepted, and raising the gas limit after the
  checks makes the undo commit in every case.

## Changes

All in `HipoFinance/jackpot`:

1. **Before the build:**
   - measure the node hop's worst case, a fold with all 8 chunks changed plus `owners_set`, and set `G_N` to at least
     1.5 times it. **Done:** 73,226 gas at level 1 (66,625 at level 4), so `G_N` = 110,000, and the results table is
     recomputed;
   - measure the treasury's `provide_current_quote` on the sandbox's Hipo fixture and set the poke's bound from it.
     **Done:** the quote 5,803 gas, with the reply 21,854, inside the formula's 40,000; the poke handler 14,070, so
     `G_P` = 22,000;
   - after adding the fee functions to the wallet, measure the built wallet's size (`c_W`, `b_W`); `wallet_storage` and
     `fwd(prepare)` use it, and a test pins it. **Done:** 28 cells, 13,153 bits, with the fee functions and the
     `+ payload_fee` check;
   - **Done:** the handler bounds, `G_J` = 55,000 from `deposit_ready`'s 35,825 (`burn_notification` 33,369), and
     `G_W` = 14,000 from the wallet's `burn`, 9,067; `G_pre` measured at 12,087. **Raised by the code review**, with a
     cap-size payload: `G_J` = 60,000 from `burn_notification`'s 39,386, `G_W` = 18,000 from the wallet's `burn`, 11,709;
     `bound::tep89` set from a measurement the build reports. **Measured on the final build:** `deposit_ready` 36,600;
     `burn_notification` with a full cap payload 39,570; the `w` burn 38,870; the wallet's `burn` with a cap payload
     11,709; `G_pre` with an 8-cell payload 13,626; TEP-89 18,126 with `include_address` (17,546 without), so
     `G_T` = 28,000. The top node's size is pinned at `node::cells` = 43, `node::bits` = 22,721;
   - check what happens when `deposit_ready`'s action phase fails and the message bounces (see Risks), and add the
     criterion below.
2. `contracts/imports/fees.fc` (new): the price functions and every formula above.
3. `contracts/jackpot.fc`: the checks above; `burn_notification`'s check first; the undo with `set_gas_limit(G_J)`,
   reached within 20,000 gas, without `bounce_floor`, and with the owner's-wallet sender check; `deposit_ready`'s
   `booked_min` with the payload, the top node's StateInit paid from the reserve, and a refusal refund that does not
   ignore errors;
   `withdraw_for` with `value_per_owner`; `get_jackpot_fees`; a new getter `get_burn_fee(forward, cells, bits)`, the
   burn fee for a forward amount and a payload size (wrapper `getBurnFee`). `contracts/schema.tlb`:

   ```
   withdraw_for#2742c19b query_id:uint64 to_successor:Bool value_per_owner:Coins owners:^Cell = InternalMsgBody;
   ```

   **Layout addition:** the Jackpot appends the owner's address last in the `deposit_booked` reply cell, so the undo of
   a bounced `deposit_booked` can check that the bounce comes from the owner's jGRAM wallet. The wallet does not read
   that field, so its code is unchanged.
4. `contracts/wallet.fc`: `wallet_minimum_internal` with `due_payment()` on the owner's burn and, in the
   `from_jackpot?` branch, the same check, with the size of the comment the burn carries, and the value sent on to the
   owner when short; `wallet_storage`, from `fees.fc`; `get_wallet_minimum_internal()`, which never calls `DUEPAYMENT`.
5. `contracts/imports/constants.fc`: remove the user-side constants, `fee::bounce_floor`, `fee::withdraw_for_gas` and
   `fee::unstake`; add `fee::unstake_bound`; keep the gas bounds and the float-side constants.
6. Readers of the fees: `wrappers/Jackpot.ts` (with `burnAttach`, the burn-attach helper that adds the wallet's debt,
   one `fwd_simple(payload)` and a margin), `wrappers/Wallet.ts`, `tests/jackpot/setup.ts`; the scripts `poke`,
   `submitRandomness`, `refill`, `withdrawFor`, `sweep`, `deployJackpot`, `showState`, `lib/upgradeDryRun` (which also
   checks the 30,000-gas rule), `setSuccessor`; `scripts/graphs`. Outside the repo: the web app and the keepers.
7. `docs/architecture.md`, `README.md`, `CHANGELOG.md`.

## Acceptance criteria

- [x] **Formulas.** `get_jackpot_fees` and `get_wallet_minimum_internal` equal the formulas above, to the nano-GRAM, at
      the sandbox config and at a config with 400 nano-GRAM per gas and the old forwarding and storage prices.
      <!-- evidence: tests/Fees.spec.ts 'the formulas' (sandbox, and 400 nano-GRAM per gas with the old forwarding prices; the storage prices were left as the sandbox's) -->
- [x] **Gas bounds.** Gas pins become the bounds: each measured handler, the node hop's worst case included, is at most
      its bound divided by 1.5, measured with a cap-size payload where a payload rides (`G_J` 60,000, `G_W` 18,000,
      `bound::tep89` from its measurement). `burn_notification` reaches its fee check within 30,000 gas, and the upgrade
      dry run checks it.
      <!-- evidence: tests/Fees.spec.ts 'the gas pins' and the production submit test (bounds raised to 55,000 / 14,000 by the coordinator: deposit_ready 35,825, burn_notification 33,369, wallet burn 9,067, submit 97,679; node hop 73,226 in Gas.spec); scripts/lib/upgradeDryRun.ts checks the 30,000 rule (12,087 measured) -->
- [x] **Wallet size.** The built wallet's cells and bits equal `c_W` and `b_W`: 28 cells, 13,153 bits.
      <!-- evidence: tests/Fees.spec.ts pins the built wallet at 28 cells, 13,153 bits -->
- [x] **Wallet minimum getter.** `get_wallet_minimum_internal()` equals the formula with no storage debt; for a wallet
      in debt, the getter plus its storage stats' debt equals the minimum the wallet checks.
      <!-- evidence: tests/Fees.spec.ts formulas (getter = no-debt formula) and 'burnAttach' (a wallet in debt: the getter alone is refused, the helper's value passes) -->
- [x] **Real-chain fees.** The existing tests that check the GRAM sent and returned pass at both configs; the Jackpot's
      balance does not fall in any user chain.
      <!-- evidence: tests/Gas.spec.ts 'Fees against the real chains' at 400 nano-GRAM per gas, Verification 'Gas returned' and the Composable F7 test at the sandbox config; the full suite is green -->
- [x] **Price jumps.** Configs 20, 21, 24 and 25 raised mid-chain by 1.5, 2, 3 and 3.5 times: up to 2 times every chain
      books and pays; up to 3 times no update is lost, no `release` is lost and no refused burn loses its balance; above
      that every chain ends in a clean refusal or a bounce, with every counter right.
- [x] **The first booking.** The price-jump and threshold tests (`deposit_ready`'s, the smallest undo's) also run on a
      fresh Jackpot with position 0 not taken, so the first deposit deploys the top node; its StateInit forwarding is
      paid from the float in `deposit_ready`, and `deposit_booked` completes.
- [x] **Burn at the exact fee, by payload size.** An owner's burn attaching exactly the published burn fee for its
      payload is paid, with 0, 1, 3, 4, 6 and 8 cells of payload.
      <!-- evidence: tests/Fees.spec.ts 'price jumps' for 1.5, 2, 3 and 3.5 times, deposit at three legs and a burn -->
- [x] **Burn from a wallet in debt.** A wallet with an old `last_paid` and storage debt just below the freeze limit sends
      a burn carrying exactly `wallet_minimum_internal`, `due_payment()` included; the Jackpot refuses it; the bounce
      comes back and the wallet restores the balance.
      <!-- evidence: tests/Fees.spec.ts 'a wallet in storage debt' (a price step of 4 makes the Jackpot refuse; the bounce restores the balance) -->
- [x] **Jackpot-sent burns to a wallet in debt.** A `w` and a `withdraw_for` to a wallet with storage debt, with a price
      step that makes the Jackpot refuse the burn, lose nothing: either the wallet does not burn and the GRAM goes to the
      owner, or the bounce comes back and restores the balance. The `from_jackpot?` branch never throws, and its minimum
      counts the size of the comment the burn carries.
      <!-- evidence: tests/Fees.spec.ts (a burn from the Jackpot with too little value goes to the owner, nothing burned) and Retire.spec 'a wallet in storage debt above 0.07 GRAM' -->
- [x] **The smallest undo.** The undo of a bounced `deposit_booked` reaches `set_gas_limit(G_J)` within 20,000 gas, and a
      bounce carrying only `fwd(booked) + 2·fwd_simple(payload) + H·gas(G_W)`, the least `deposit_booked` can carry,
      tested with an 8-cell, cap-size payload, is undone in full, the float
      falling by at most `update_value + release + gas(G_J) + fwd(1, 545) + 2·fwd(log)`. The undo never calls
      `accept_message`. A bounced `deposit_booked` that does not come from the owner's jGRAM wallet changes nothing. With less than
      `payout_fee` left for the refund, the counters and the tree are undone, no refund is sent, and an `untracked` log
      records the hGRAM, which `return_tokens` then pays in full.
      <!-- evidence: tests/Fees.spec.ts 'the undo' (value = gas(20,000), also with a cap-size payload) and Races 'Bounce value'; the undo's refund is untracked in practice (see the report) -->
- [x] **Minimum and fee.** A burn with value between `wallet_minimum_internal` and the burn fee bounces, and the wallet
      restores the balance.
      <!-- evidence: tests/Fees.spec.ts 'a burn with a value between the wallet minimum and the burn fee bounces' -->
- [x] **`deposit_ready`.** A deposit whose value left at `deposit_ready` is below `update_min + booked_min` is refused
      with `low_value` and refunded; one at exactly that books, and `deposit_booked` completes.
      <!-- evidence: tests/Fees.spec.ts 'deposit_ready below update_min + booked_min' (bracketed, not the exact nano-GRAM: value_left subtracts the gas used) -->
- [x] **A failed `deposit_ready`.** A forced action-phase failure in `deposit_ready` bounces it; the wallet's `pending`
      falls back; `deposit_tokens` stays in `incoming_tokens`, and `return_tokens(…, true)` refunds it in full.
      <!-- evidence: existing Attacks / Verification tests of the failReady build (bounce, pending falls, incoming_tokens stays, return_tokens refunds); the full suite is green -->
- [ ] **A failed refusal refund.** A `deposit_ready` refusal whose refund send fails bounces `deposit_ready`, and
      `return_tokens(…, true)` recovers the tokens in full.
      Note: still open. No test produces a refusal whose refund send fails: the sandbox cannot make that send fail
      without a test build of the Jackpot that forces it.
- [x] **Wallet reserve.** A booking leaves the wallet holding `wallet_storage` at the current price, and the rest of the
      value reaches the response destination.
      <!-- evidence: tests/Fees.spec.ts 'a booking leaves the new wallet holding wallet_storage' -->
- [x] **`withdraw_for`.** It is refused with `value_per_owner < per` and below
      `n·value_per_owner + gas(gas_consumed() + 10,000)`, and passes at it with 100 owners. A wallet with storage debt above
      0.07 GRAM, which `per` alone leaves unburned, is emptied by a `withdraw_for` with a larger `value_per_owner`.
      <!-- evidence: Retire.spec 'withdraw_for needs ...' (refused below the floor, runs at the measured threshold, value_per_owner < per refused; 100 owners run at a generous value, not at the exact threshold) and the debt test -->
- [x] **App attach.** `burnAttach` in `wrappers/Jackpot.ts` returns
      `max(burn fee, get_wallet_minimum_internal() + payload_fee + fwd_simple(payload) + debt)` plus its margin for a
      wallet in debt, and a burn with that value passes the wallet's check; the getter runs
      without `DUEPAYMENT`.
      <!-- evidence: tests/Fees.spec.ts 'burnAttach' -->
- [x] **Unstake bound.** The run-time `unstake` stays at or below `fee::unstake_bound` up to 400 nano-GRAM per gas.
      <!-- evidence: tests/Fees.spec.ts 'the run-time unstake' asserts both 400 nano-GRAM per gas and with the old forwarding prices (fee::unstake_bound 0.2 GRAM) -->
- [x] Two money audits (one to prove it correct, one to make it lose money) and a code review pass on the code.
      <!-- evidence: tier-3 review 2026-11-07: both audits and the code review ran, every finding fixed (first booking, payload burn fee, TEP-89 gas, bounds, undo sender check) and re-checked with no confirmed failing case -->

## Risks & rollback

**Price steps in flight** (the auditor's table; "if short" is what happens when the step is exceeded). The measured
`G_N` doubles `update_value` in GRAM but keeps its ratio to the worst-case hop at 1.5, so the update rows are unchanged;
the other legs do not depend on `G_N`.

| Leg | Survives a step up to | If short |
|---|---|---|
| A move at its exact threshold | about 2.3× | Hipo throws; the hGRAM stays untracked for `return_tokens` |
| A payout at the exact burn fee | about 6× | the same |
| `release` (`deposit_cancelled`, `close_wallet`), at 3 | about 4.7× (3.15× at 2) | no bounce; `pending` stays raised. A refused first deposit leaves the wallet "opening", so every later deposit is answered busy |
| A node update sent at only `update_min` | 1.5× at the worst-case hop (73,226 gas against `G_N` = 110,000); more for an ordinary hop | the update is lost |
| A node update at the full `update_value` | 3× at the worst-case hop; more for an ordinary hop | the update is lost |
| A refused burn at the wallet's minimum, with the step between the wallet and the Jackpot | above 3× with the leg at 3 (about 2–3× at 2) | the bounce has no gas and `x` is lost |

- **Prices more than triple within seconds:** a node update in flight can be lost and the tree's sums go wrong; a
  refused burn's bounce can run dry and lose its principal. `release` and the refused-burn leg carry headroom 3 so that
  neither fails before the update does. Detect: a `lost` log, a sum mismatch. Today's constants already fail for good
  above about 1,000 nano-GRAM per gas; this design fails only on a jump of that size in seconds.
- **`deposit_booked` short of gas** would lose the booked principal with no bounce. `booked_min` leaves it its handler's
  gas at twice the price; it is not the only lasting harm, so it is in the table's terms too.
- **A short undo is paid by the float,** at most about 0.066 GRAM today per event (0.40 at 400 nano-GRAM per gas), plus
  the update's forwarding and two logs (about 0.3–0.4M nano-GRAM today), to be recomputed with the new bounds, for
  an event with no known trigger. If the bounce carries less than `payout_fee`, the undo still restores the counters and
  the tree, but its refund is not sent: the hGRAM stays untracked, with an `untracked` log, until the governor's
  `return_tokens` pays it. Nothing is lost; the depositor waits.
- **Apps must add a wallet's storage debt** to `get_wallet_minimum_internal()`, which is computed without a storage
  phase, through `burnAttach` in `wrappers/Jackpot.ts`. An app that skips it attaches too little for a wallet in debt
  and is refused without loss.
- **`booked_min` does not cover the depositor's forward amount or a top-up of the wallet reserve.** After a price rise
  before `deposit_ready` cuts the update's value, the beneficiary's notification can be skipped and the wallet's reserve
  stays short of `wallet_storage`; the GRAM goes to the response address. Composability only: the booking stands and no
  money is lost.
- **The top node's StateInit,** 1,868,068 nano-GRAM today, is paid once in the Jackpot's life by the float, in the
  first booking's `deposit_ready`.
- **A future Jackpot that spends more than 30,000 gas before its burn check** would let an underpaid burn fail with no
  bounce, and the wallet would not restore. The rule is in the spec, pinned by a test, and checked by every upgrade's
  dry run.
- **A failed `deposit_ready` (outside this change):** if its action phase fails and the message bounces, `t` appears to
  stay in `incoming_tokens` with nothing but the governor's `return_tokens(…, in_flight)` to clear it. The build checks
  this path (Changes, step 1) and a criterion covers it.
- **Hipo's fee formulas are mirrored** in `fees.fc`. If Hipo changes `send_tokens_fee` or `unstake_tokens_fee`, the
  Jackpot's figures drift; Hipo's upgrade checklist gets that line.
- **The wallet's reserve is smaller today:** 5 years of storage at the current price (about 0.0075 GRAM) in place of
  0.026. It is topped up at each booking and rises with storage prices; a wallet that runs out freezes only at 0.1 GRAM
  of debt, and with the burn check counting `due_payment()`, debt no longer opens a loss window.
- **`withdraw_for` near the gas limit:** 100 owners use about 833,000 of the 1,000,000 gas; `per` is computed once,
  outside the loop. If gas per owner grows, the governor sends smaller batches.
- **Apps that cache a fee** attach too little after a price rise and are refused or bounced; nothing is lost.
- **A successor fee set below the successor's later fee** after a price rise sends moves to the owner instead; the
  3 times rule makes that unlikely.

Rollback: nothing is deployed on mainnet. Before deploy, revert to 76e934c's constants. After deploy, the Jackpot's
code can be upgraded; the wallet's frozen minimum and reserve formula cannot, so they are the part to get right.

## Open questions

None open. Decided recommendations, unless the person says otherwise:

1. **Wallet reserve at 5 years of storage.** Kept, with the F1 fix: the time to freeze is dominated by the 0.1 GRAM
   `freeze_due_limit`, and with `due_payment()` in the burn check the reserve no longer opens a loss window.
2. **The poke's treasury gas** is measured on the sandbox's Hipo fixture in step 1, and the poke's bound is set from it.
3. **The 30,000-gas rule** is checked by every upgrade's dry run, since the wallet's minimum can never change.

**Decided 2026-11-07 (re-check 1):** the wallet's `from_jackpot?` branch checks `wallet_minimum_internal`, with
`due_payment()`, and sends the value on to the owner instead of burning when short; apps attach
`max(burn fee, get_wallet_minimum_internal() + payload_fee)` (superseded by re-check 2: plus the wallet's debt and a
margin); the undo uses `set_gas_limit(G_J)`, a fixed bound, reached
within 20,000 gas, and its criterion is the smallest bounce `deposit_booked` can carry, not a bounce with no GRAM.
`G_N` is set to 110,000 from the build's step-1 measurement, per this spec's own rule (1.5 times the measured worst
case, 73,226); `G_P` to 22,000 from the poke's 14,070; the treasury's quote with its reply (21,854) fits the poke
formula's 40,000. The results table and the undo's exposure are recomputed: deposit about 0.086 GRAM today, burn
0.077, undo exposure 0.066. (The figures are superseded by the build line below.)

**Decided 2026-11-07 (build):** `bound::jackpot` (`G_J`) = 55,000 from `deposit_ready`'s measured 35,825
(`burn_notification` 33,369); `bound::wallet` (`G_W`) = 14,000 from the wallet's `burn`, 9,067; `G_pre` measured at
12,087 against the 30,000 rule; the built wallet is 28 cells and 13,153 bits; `fee::unstake_bound` = 0.2 GRAM, since
the run-time unstake at 400 nano-GRAM per gas with a lump of 1,000,000 is 184.7M, and `draw_budget` is 4.83 GRAM; when
a `deposit_booked` bounce cannot pay the refund, the undo still restores the counters and the tree and leaves the hGRAM
untracked, logged, for `return_tokens`; `get_wallet_minimum_internal()` shows the minimum without storage debt, and apps
add the debt from the account's storage stats. The results table is recomputed: deposit 0.088 GRAM today, burn 0.078,
`w` 0.084. (The figures are superseded by the final build line below.)

**Decided 2026-11-07 (re-check 2):** apps attach `max(burn fee, get_wallet_minimum_internal() + payload_fee + debt)`
plus a small margin, with `debt = max(0, stored due_payment + storage_fee(now − last_paid) − balance)` from the
wallet's account state, through a helper (since the code review, `burnAttach` in `wrappers/Jackpot.ts`, with one
`fwd_simple(payload)` added); `get_wallet_minimum_internal` never calls
`DUEPAYMENT`, so it works on any API's emulator; a wrong attach only causes a refusal, never a loss. `withdraw_for`
takes a governor-chosen `value_per_owner`, at least the formula's `per`, so a wallet in debt can still be emptied at
the end of life. `booked_min` adds `2·fwd_simple(payload)`, and "the smallest undo" is tested with an 8-cell payload.
The `from_jackpot?` branch's minimum counts the size of the comment the burn carries.

**Decided 2026-11-07 (code review):** the first booking's top-node StateInit forwarding, about `fwd(43, 22,721)` =
1.87M nano-GRAM today, is paid by the float out of the reserve in `deposit_ready`, once in the Jackpot's life, not out
of `deposit_booked`'s value, which a 1.3–2× price step could leave short of gas; the price-jump and threshold tests also
run on a fresh Jackpot. The burn's wallet leg carries the payload: `burn` uses `gas(G_W) + fwd(2 + pc, 1,023 + pb)` and
`burn_arrives` subtracts the same term, tested at the exact fee with 0, 1, 3, 4, 6 and 8 cells. `G_J` = 60,000
(`burn_notification` with a cap-size payload, 39,386) and `G_W` = 18,000 (the wallet's `burn` with a cap-size payload,
11,709); `bound::tep89` comes from a measurement the build reports; the results table is recomputed once the build
reports the fees. The undo checks that the bounce comes from the owner's jGRAM wallet, and its stated exposure includes
the update's forwarding and two logs. `booked_min`'s gap (the forward amount, the reserve top-up) is a composability
risk, not a money one. A refusal refund that fails bounces `deposit_ready`, for `return_tokens(…, true)`. The `prepare`
size is (30, 14,394). The burn-attach helper is `burnAttach` in `wrappers/Jackpot.ts`, its floor with one
`fwd_simple(payload)`.

**Decided 2026-11-07 (final build):** the results table holds the fees measured from the built `get_jackpot_fees`:
deposit 0.0907 GRAM today (0.515 at 400 nano-GRAM per gas with the old forwarding prices), burn with no payload 0.0794
(0.502), `w` 0.0862 (0.557), poke 0.0075 (0.051), submit 0.0103 (0.064), refill 0.0282 (0.211), TEP-89 0.0020
(0.013). `G_T` (`bound::tep89`) = 28,000, from 18,126 measured with `include_address` (17,546 without). Measured:
`deposit_ready` 36,600, `burn_notification` with a full cap payload 39,570, the `w` burn 38,870, the wallet's `burn`
with a cap payload 11,709, `G_pre` with an 8-cell payload 13,626. A new getter `get_burn_fee(forward, cells, bits)`
(wrapper `getBurnFee`) gives the burn fee for a payload and a forward amount; `get_jackpot_fees().withdraw` is the
no-payload fee. The owner is appended last in the `deposit_booked` reply cell for the undo's sender check; the wallet
does not read it, so its code is unchanged. `node::cells` = 43 and `node::bits` = 22,721 are pinned; the float pays
1,868,068 nano-GRAM once, at the first booking. The `w` burn's comment is priced at (1, 256).
