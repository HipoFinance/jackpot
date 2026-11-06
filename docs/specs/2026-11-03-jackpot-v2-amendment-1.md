# Hipo Jackpot v2, amendment 1

**Status:** approved

Amends [`2026-10-31-jackpot-v2.md`](2026-10-31-jackpot-v2.md). **v2 holds except where this document changes it.**
Nothing is deployed, so storage and messages change freely. The v2 text is not edited; the list below says which
parts of it no longer hold.

**In one paragraph.** The Jackpot keeps no records; its storage has a fixed size whatever anyone sends. There is no
clock: a boundary is the first quote reply that shows Hipo's rate risen past a threshold since the last boundary, at
least `min_gap` later, so each boundary follows Hipo's reward. At the boundary, in that same transaction, the Jackpot
takes the snapshot and sets the pot aside, before any random number exists. `submit_randomness` then only checks drand
and starts the searches. Anyone may `poke` to ask for a quote; pokes are the only quotes. Deposits and withdrawals use
the stored rate: deposits always pay the normal entry price, and withdrawals are paid in the step that receives them.
Every bounceable message asks for TON's full-body bounce, so a bounce brings its context back and the Jackpot recovers
by itself. Payouts go out without confirmation. Every interaction has a reply another contract can act on. A text
comment `w` withdraws everything. The governor can retire the Jackpot, pay the last pot and empty it, closing the tree
of nodes, and move players to a new Jackpot. Logs follow the format explorers decode. Single-letter names become words.
Message graphs come from a sandbox story.

## What this replaces in v2

| v2 part | Now |
|---|---|
| In plain terms: "How a draw runs", "During a draw", "If nobody brings the number" | Replaced by In plain terms below. |
| In plain terms: "all the rules about recorded payouts stay" | Removed. See Payouts. |
| Definitions: Boundary, Period, Tick, `anchor`, `period`, `T_n`, `S` relative to the next boundary | Replaced: a boundary is a quote reply, see Boundaries. No tick, no period. `S` counts back from the earliest next boundary. |
| Definitions: Open draw states *waiting*, *quoting*, *resolving* | *waiting* (pot set aside, waiting for randomness) and *resolving*. No *quoting*. |
| Definitions: Skip, `R` | Redefined under Boundaries: `R` is the first drand round at or after the boundary's time + 60 s. |
| Definitions: Quote, "The Jackpot stores the latest" | Holds: every quote reply, all of them a poke's now, stores its rate after the fall check. Deposits and withdrawals use the stored rate. |
| Definitions: Booking, "when the Jackpot handles the treasury's quote reply" | When the Jackpot handles `deposit_ready`. |
| Definitions: `O` "prizes of the open draw, burn owed, claimable" | `reserved_tokens`: prizes of the open draw and burn owed. Nothing is claimable. |
| Definitions: `L ≤ P` | `tickets = principal` at all times: both change together in every handler. |
| Definitions: all single-letter quantities | Renamed, see Names. Formula blocks keep the symbols. |
| Approach, Contracts, item 1: "without the pending dict", the schedule fields | No dictionary at all. The schedule gives way to the boundary fields. |
| Approach, Contracts, item 3, `node`: "see The tree" | Gains `close_node`, see Closing the tree. |
| Approach, The clock (all of it) | Replaced by Boundaries. |
| Approach, Deposit: steps 1 to 6, and "A `prepare` that bounces ..." | Replaced by Deposit below. No quote. |
| Approach, Deposit: "Why the quote comes after the wallet" | Holds for the booking at `deposit_ready`: price, principal, tree update and the side of the boundary are decided in one Jackpot transaction. |
| Approach, Deposit: "A `credit` that bounces" | Holds for `deposit_booked`, except that the tokens go back to the response destination at once and the wallet gets `deposit_cancelled`. |
| Approach, Entry price: "`c = v` if `P = 0`, or the draw state is waiting or quoting" | `c = v` only if `P = 0`. Otherwise always the normal formula. |
| Approach, Entry price: "A deposit in an open draw" | Replaced by Deposits and the pot under Boundaries. |
| Approach, Entry price: the timing table and its notes | Replaced by Timing around Hipo's reward under Boundaries. |
| Approach, Entry price: `min_c` and "the app sends an explicit `min_c`" | `min_principal`, given in `deposit_options`. |
| Approach, Entry price, other limits: "A prize that rolls over during resolving ..." | Holds, without the part about tickets booked at `c = v`. |
| Approach, Entry price, other limits: "A draw that ends with `pot < m` ..." | Removed: that pot stays free and later deposits pay for it; and the pot is fixed before any seed, so a deposit's rounding cannot flip a draw. |
| Approach, Entry price, other limits: "`P` lags `L` by one hop" (accepted) | Removed: a withdrawal lowers `principal` and `tickets` in the same step. |
| Approach, Withdrawal: steps 1 to 3 | Replaced by Withdrawal below: `burn`, `burn_notification` (which pays), the payout. No quote. |
| Approach, Withdrawal, Closing: `withdrawn` | `burn_notification`. |
| Approach, Withdrawal, A frozen wallet: "refuses `prepare`, so a deposit returns its `t`" | Holds: the full-body bounce brings the context back, and `t` goes to the response destination. |
| Approach, Withdrawal, Races: row "Two deposits, new wallet" | The second deposit is refused with reason `wallet_busy`; nothing bounces. |
| Approach, Draw, steps 1 and 2 | Replaced: the pot is fixed at the boundary; `submit_randomness` checks drand and starts the searches, with no quote. See The draw. |
| Approach, Draw, step 3: prize "as a recorded payout" | An unconfirmed payout with a comment, see Prizes. |
| Approach, Draw: "Boundary while a draw is running, in one place" | Replaced by the rules under Boundaries and The draw. |
| Approach, Gas: "User chains (deposit, withdrawal, claim)" | No claim, and no quote in either chain. |
| Approach, Gas: "A reply short of value aborts and its record stays for `requote`" | Removed. A poke whose reply is lost has lost only its own gas. |
| Approach, Gas: "`return_excess` stays the Jackpot ..." | Removed. `return_excess` is the response destination of the person the payout is for, or the Jackpot for prizes and burns. |
| Approach, Refilling: "a record `(refill, sender)`"; "only the draw refills ... so nobody can shrink a pot once the seed is public" | `refill` asks for no quote and uses the stored rate; the boundary unstakes before any seed exists. A new accepted limit, see Refill. |
| Approach, Costs: nodes are never removed | The end closes the tree and returns each node's balance, see Closing the tree. |
| Rules kept from v1: Senders | Replaced by Senders below. |
| Rules kept from v1: Records used once | Removed. Replaced by "each context is acted on once", see Why forged messages gain nothing. |
| Rules kept from v1: Reply handlers never throw | Holds for `take_current_quote`, notifications, `burn_notification`, `hit`, `miss`, `lost`, bounces and `update` at a node. `gas_excess` is ignored. |
| Rules kept from v1: Payout records and the `gas_excess` facts, `settle_failed_payout`, the two kinds of claim | Removed. |
| Rules kept from v1: Deploy checks and setters, `3600 ≤ period ≤ 2,592,000` | Replaced by the bounds of `rise_min` and `min_gap`. |
| Rules kept from v1: Governor | Drops `set_period` and `settle_failed_payout`; adds `set_rise_min`, `set_min_gap`, `retire`, `set_successor`, `withdraw_for`, `close_subtree`, `set_treasury`, `rescue_jetton`, `rescue_nft`. `clear_falling` also resets the boundary rate. |
| Messages `requote`, `claim`, `settle_failed_payout`, `set_period`, `withdraw`, `withdrawn`; `fee::requote`, `fee::claim`; getters `get_books`, `get_claimable`, `get_schedule` | Removed. |
| Logs: external-out messages to a 256-bit `addr_extern` topic; `snapshot_log`, `draw_log`, `withdrawn_log` | Replaced by Logs below: destination `addr_none`, a 32-bit op first; `boundary_log` records the rate and the pot; one `withdrawal_log` per withdrawal. |
| Risks: "A stranger can confirm a payout early" and "`claim` keeps a little" (accepted 2026-11-01) | Removed: there are no confirmations and no claims. |
| Acceptance, carried over: "lost quote and `requote`, repeated and late; payout bounce, claim, second-hop failure, forged `gas_excess`; two claims; failed burn" | Replaced by the Failures criterion below. |
| Acceptance, new: Timing, Open draw, Skip, The tick sends nothing, Submit cut-off, Stale draw reply, Clock, Period change, Hands-free, Outage, Boundary mid-search | Replaced by the criteria under Boundaries and the draw below. |
| Acceptance, new: "A failed action loses nothing" | Holds for `burn_notification` in place of `withdrawn`. Its second sentence (`ready` and `requote`) is removed. |
| Acceptance, new: "Stale `ready`" | Removed. |
| Acceptance, new: "`min_c`" | Holds with `min_principal`. |
| Acceptance, new: "Zero withdrawal" | Holds for `burn` with amount 0 at balance 0. |
| Acceptance, new: "Closed and frozen wallets", bullets 3 and 4 | Replaced by the Failures criterion. |
| Message names `prepare`, `ready`, `credit`, `release`, `close` | `prepare_deposit`, `deposit_ready`, `deposit_booked`, `deposit_cancelled`, `close_wallet`. |
| Approach, Costs: `fee::wallet_storage` = 0.02 GRAM | 0.026 GRAM: the built wallet is 23 cells and 12,373 bits (`contracts/imports/constants.fc`). |
| Approach, Withdrawal: a bounced `withdrawn` keeps `fee::wallet_bounce` (0.005 GRAM) at the wallet | Removed: a bounced `burn_notification` restores the amount and sends the whole bounced value to the owner. |

## Goal

Make the Jackpot's storage fixed in size, tie each draw to Hipo's reward instead of a clock, fix each pot before any
random number exists, keep the treasury out of every player's chain, make every interaction usable by another
contract, let people withdraw with a plain comment, and give the Jackpot a clean end, its tree included, and a way to
move players to a successor.

## In plain terms

**No records.** Until now the Jackpot remembered every request it had sent and every payout it was waiting to hear
about. Anyone could make that memory grow. Now each message carries its own context, so the Jackpot remembers nothing
between steps.

**Draws follow Hipo's reward.** There is no clock. Each round, Hipo's reward raises the value of hGRAM. Shortly after,
a keeper (or anyone) pokes the Jackpot, which asks Hipo for its rate. If the rate has risen since the last draw and
enough time has passed (`min_gap`, half a round by default), that moment is a boundary. In the same step the Jackpot
fixes who is in the draw and sets the pot aside: the yield since the last boundary, the fresh reward included. A minute
later drand publishes a number, and anyone can bring it to start the draw. Nothing about the pot or the players can
change after the number is known. A longer `min_gap` gives fewer, larger draws: 2.5 rounds gives a draw every third
round.

**Joining and leaving.** A deposit pays the entry price for the pot building up for the next draw, and joins that
draw. It never pays for a pot it cannot win. A withdrawal pays back principal at once, at the rate the Jackpot last
read from Hipo; a player who leaves gives up their chance in any draw they are in.

**If drand is silent** until the next boundary, the waiting draw keeps its pot and waits for the new boundary's drand
round. The yield since then stays for the draw after it, which everyone in by then shares. Nothing is lost.

**When a message bounces.** TON can return a bounced message whole. The Jackpot asks for that on every bounceable
message it sends, so a bounce brings back everything the step needs, and the Jackpot finishes the step by itself.

**Payouts.** The Jackpot sends hGRAM and does not wait to hear that it arrived. Almost always it does. In the rare
case that it does not, the hGRAM is back in the Jackpot's hGRAM wallet, outside its count, and the governor sends it
to its owner.

**For apps and contracts.** A deposit can name who it is for, the smallest principal it accepts, and what to send
back. When it is booked, the player's jGRAM wallet notifies them as any jetton wallet does, with the caller's
`query_id` and payload. When it is refused, the hGRAM comes back with a reason. A withdrawal is a standard jetton burn;
it pays hGRAM with the caller's `query_id` and payload, and the leftover GRAM goes where the burn said. A prize arrives
with a short note naming the draw, and with 0.01 GRAM, enough for a receiving contract to act on it.

**A comment to leave.** Send the Jackpot GRAM with the comment `w`, and all your principal comes back as hGRAM.

**The end.** The governor can retire the Jackpot. Deposits stop for good, and withdrawals keep working. The next draw
pays the pot to the players. Then the governor withdraws for everyone, each to themselves, in batches of 100. When
nobody is owed anything, `sweep` sends what is left, a little yield and rounding, to the HPO burn, and closes the tree
of nodes, whose storage reserves come back.

**Moving.** When a new Jackpot replaces this one, the old one pays a player's hGRAM straight into the new one as a
deposit for that player. Players can do it themselves, or the governor can do it for them. If the new Jackpot
refuses, the hGRAM goes to the player.

**Trade-offs.** Draws depend on someone poking after each reward; an alarm fires if no boundary comes within 1.5 times
the expected rhythm (`min_gap` rounded up to the next reward). Anyone can choose a boundary's moment within limits, but it gains nothing. Between a reward and the poke,
the Jackpot's rate is a few minutes old, which costs nobody. The governor acts by hand in the few failures that leave
nothing to recover from. The Jackpot depends on TON's full-body bounce, and on Hipo's treasury echoing quote payloads to
the sender only and never lowering its rate.

**Decisions needed:** none; see Open questions.

## Definitions

**Concepts**

- **Stored rate**: `quote_coins`, `quote_tokens` from the last poke's quote reply, or from the deploy data before the
  first. Deposits, withdrawals and refills use it.
- **Boundary rate**: `boundary_coins`, `boundary_tokens`, the rate at the last boundary, stored apart from the stored
  rate. At deploy it is the deploy data's rate.
- **Boundary**: a poke's quote reply that meets the boundary rule, see Boundaries. Its time is `last_boundary`.
- **Poke**: a message from anyone that asks the treasury for a quote, so that the stored rate is fresh and a boundary
  can happen.
- **Open draw**: from a boundary that sets a pot aside until the draw ends. *Waiting*: the pot is set aside and the
  draw waits for drand's round `R`. *Resolving*: randomness checked, searches running. With no open draw the state is
  *none*.
- **Skip**: a boundary that finds a draw still waiting. The draw keeps its snapshot and pot and waits for the new
  boundary's round.
- **Earliest next boundary**: `last_boundary + min_gap`. No boundary can come before it.
- **Context**: what a step needs to finish, built by the Jackpot and carried by the messages of the flow, never
  stored. A **deposit context** rides in `prepare_deposit` and comes back in `deposit_ready`. A **poke context** rides
  in `provide_current_quote`'s `custom_payload` and comes back in `take_current_quote`.
- **Untracked hGRAM**: hGRAM in the Jackpot's hGRAM wallet that `held_tokens` does not count: the wallet's balance less
  `held_tokens`, computed off chain. The governor pays it out with `return_tokens`.
- **Caller**: whoever sent the message that starts a flow: the depositor, the owner who burns, or the poker.
- **Beneficiary**: the owner a deposit is booked for. By default the depositor.
- **Response destination**: for a deposit, the address that receives the leftover GRAM and, if the deposit is refused,
  its hGRAM; by default the depositor. For a withdrawal, the burn's `response_destination`, which receives the leftover
  GRAM; by default the owner.
- **Reason code**: why a deposit was refused, see Refusals.
- **Comment**: a TEP-74 text comment, a 32-bit zero followed by text.
- **Retired**: a state set by the governor's `retire`, cleared by no message. Deposits are refused; everything else
  runs.
- **Successor**: the address of a new Jackpot, set by the governor after `retire`, that moved principal is deposited
  into.
- **Move**: a withdrawal paid into the successor as a deposit for the same owner.
- **End**: retired, no principal, nothing incoming, and `sweep` has sent the rest to the burner and closed the tree.

**Names** (they replace the symbols outside formula blocks; the first twelve rows were set with the request for this
amendment, the rest are chosen here)

| Symbol | Name | Meaning | Unit |
|---|---|---|---|
| `T` | `held_tokens` | hGRAM the Jackpot holds by its own count | nano-hGRAM |
| `I` | `incoming_tokens` | deposits received, not yet booked or returned | nano-hGRAM |
| `O` | `reserved_tokens` | prizes of the open draw and burn owed | nano-hGRAM |
| `F` | `free_tokens` | `held_tokens − incoming_tokens − reserved_tokens` | nano-hGRAM |
| `U` | `unstaking_tokens` | sent to unstake, not yet reported back | nano-hGRAM |
| `P` | `principal` | principal owed | nano-GRAM |
| `L` | `tickets` | live tickets, held changes included; jGRAM supply; always equal to `principal` | nano-GRAM |
| `G` | `float` | the Jackpot's GRAM, without the message being handled | nano-GRAM |
| `draw_L` | `snapshot_tickets` | tickets in the snapshot | nano-GRAM |
| `n_b` | `next_position` | the next new position | positions |
| `c` | `booked_principal` | principal booked for a deposit | nano-GRAM |
| `min_c` | `min_principal` | the smallest `booked_principal` the caller accepts | nano-GRAM |
| `t` | `deposit_tokens` | hGRAM brought by one deposit | nano-hGRAM |
| `v` | `deposit_value` | value of `deposit_tokens` at the stored rate | nano-GRAM |
| `x` | `withdrawn_principal` | principal burned | nano-GRAM |
| `w` | `paid_tokens` | hGRAM paid for `withdrawn_principal`, at the stored rate | nano-hGRAM |
| `u` | `unstake_amount` | hGRAM unstaked at a boundary or a refill | nano-hGRAM |
| `pot` | `pot` | free hGRAM above what covers all principal | nano-hGRAM |
| `pot_v` | `pot_value` | value of the pot | nano-GRAM |
| `b` | `position` | a wallet's place in the tree | positions |
| `k` | `ticket` | the ticket a search looks for: `k(i,j)` below | tickets |
| — | `mc_hash` | root hash of the newest masterchain block the boundary transaction sees: the `PREVMCBLOCKS` entry with the highest seqno, stored with the snapshot | 256 bits |
| `seed` | `seed` | the draw's randomness: `sha256(drand_signature ‖ mc_hash)` | 256 bits |
| `m` | `min_pot` | smallest pot that pays prizes | nano-hGRAM |
| `TC`, `TT` | `quote_coins`, `quote_tokens` | the stored rate; in a quote reply, that reply's rate | nano-GRAM, nano-hGRAM |
| `BC`, `BT` | `boundary_coins`, `boundary_tokens` | the boundary rate | nano-GRAM, nano-hGRAM |
| `G_lo`, `G_hi` | `float_low`, `float_high` | float low mark and target | nano-GRAM |
| `r_s` | `submit_reward` | reward of a successful submit | nano-GRAM |
| `r` | `reward_rise` | rise of Hipo's rate when a round's reward lands | ratio |
| `S` | `submit_cutoff` | seconds before the earliest next boundary after which no submit is taken | 1,800 s, as v2 |
| `D` | `drand_delay` | seconds from a boundary to its drand round | 60 s, as v2 |

Tickets stay in nano-GRAM of principal, as v2.

**New parameters**

| Name | Meaning | Value |
|---|---|---|
| `rise_min` | the rise of the rate over the boundary rate that makes a reply a boundary, in parts per million | governor-set, `1 ≤ rise_min ≤ 10,000`; initial 50 (0.005%) |
| `min_gap` | the least time between two boundaries; it sets the draws' rhythm | governor-set, `3,600 ≤ min_gap ≤ 2,592,000` s (30 days); initial 32,768 s (half a round) |
| `max_payload_cells` | the most cells of the caller's inner `forward_payload`, the one inside `deposit_options` or `withdraw_options`, counted by `CDATASIZEQ` | 8 |
| `max_withdraw_for` | the most owners in one `withdraw_for` | 100 |
| `successor_deposit_fee` | GRAM a move sends the successor for its deposit, set with the successor | governor-set |
| `extra_flags` | the field of an outgoing internal message that asks for a full-body bounce | 3 |
| `fee::poke` | a poke: its handler, the quote round trip and the reply without boundary work | measured |
| `fee::boundary_max` | in gas units: the most gas a boundary's own work may use, the gas limit the reply raises to; set with a margin over the worst measured boundary, a resolving draw's rollover plus an unstake. The float pays the gas really used, measured in the transaction | measured |
| `close_cost(n)` | the cascade's funding: 0 for `n = 0`, else the top node's `subtree_cost(4, 0, n)` times the margin, from `next_position` and current prices (`GETGASFEE`, `GETFORWARDFEE`); see Closing the tree | computed |
| `subtree_cost(ℓ, i, n)` | the unscaled cost of closing node `(ℓ, i)` and every existing node under it: per level, `max(0, …)` existing nodes times one node's term (its gas bound, `gas_inner` above level 1 and `gas_1` at level 1, plus the forwarding of its `close_node`), each rounded up | computed |
| `gas_1`, `gas_inner` | gas upper bounds of a level-1 close and of a close with up to 64 children, re-measured on the new node code with at least 1.5 times headroom (old code: 9,804 and 263,963) | measured |
| `fee::foreign_return` | sending a foreign jetton or NFT back: the handler, the transfer and its forwarding | measured |
| `fee::payload` | added to an entry fee when a payload is present: forwarding of `max_payload_cells` cells of 1,023 bits over every hop it rides | 0.02 GRAM (about 3.6M a hop at 400 nano-GRAM per bit, four hops) |
| `fee::wallet_deploy_forward` | the forwarding of the jGRAM wallet's StateInit (23 cells, 12,373 bits) | 0.008 GRAM (6.3M at 400 nano-GRAM per bit) |
| `fee::withdraw_for_gas` | the Jackpot's own gas for one owner of `withdraw_for` | 0.0048 GRAM (12,000 gas at 400) |
| `fee::prize_notify` | `forward_ton_amount` of a prize: 25,000 gas at 400 nano-GRAM per gas, about 150,000 at today's price | 0.01 GRAM |
| `fee::comment_withdraw` | a `w` or one owner of `withdraw_for`: `fee::withdraw`, the wallet's StateInit, 1 nano-GRAM and the comment | measured |
| `fee::wallet_address` | `provide_wallet_address`: its gas and the reply | measured |
| `fee::sweep` | `sweep`'s own gas, one payout and `fee::burn_forward`; `sweep` must also bring `close_cost(next_position)` | measured |

## Context

- **The quote echoes the payload to the sender only.** `provide_current_quote` reads `query_id` and
  `custom_payload`, and sends `take_current_quote` with both, non-bounceable, mode 64, to `src`, with no check before
  it (`HipoFinance/contract/contracts/treasury.fc:754-767`). Only that handler builds `take_current_quote` in Hipo's
  contracts.
- **Anyone can raise Hipo's rate.** `gift_coins` adds the coins it is sent to `total_coins`, with no sender check
  (`treasury.fc:2679-2691`, routed at `:2875`). Hipo's total coins are about 9.9 million GRAM today (the owner's figure),
  and its reward is about 0.031% a round.
- **Hipo credits a round's reward loan by loan.** Each returning loan is settled and logged on its own
  (`treasury.fc:1806-1815`), so the rate rises in several steps after a round.
- **Hipo's rate does not fall.** A burn takes coins and tokens out together (`treasury.fc:552`, `:717`). A loan that
  comes back short by more than its collateral is recorded in the `deficit` global instead of being taken out of
  `total_coins`, and logged by `log_deficit` (`treasury.fc:31`, `:1630-1655`, `:1811-1815`).
- **Hipo's `send_tokens`.** An `addr_none` `return_excess` becomes the sender (`contract/contracts/wallet.fc:41-43`).
  It needs `forward_ton_amount` plus fees (`:48`), refuses a transfer to the wallet's own owner (`:55`), and copies
  `forward_payload` unchanged (`:37`, `:66`).
- **Hipo's `receive_tokens`.** It sends `transfer_notification` only when `forward_ton_amount > 0`, non-bounceable with
  +16, so a notification that cannot be sent bounces the transfer (`wallet.fc:85-95`). It always sends `gas_excess` with
  the rest to `return_excess`, ignoring errors (`:97-102`).
- **A second hop that fails.** The sender's wallet restores the tokens and sends `gas_excess` with the rest to its own
  owner (`wallet.fc:327-358`). For a payout, that owner is the Jackpot.
- **Hipo's `unstake_tokens#595f07bc`** has the layout of TEP-74 `burn`, with the same op. The two never meet: the
  Jackpot only sends `unstake_tokens`, and only its jGRAM wallets receive `burn`.
- **Bounces, two formats.** The old format, `0xffffffff` and at most the first 256 bits of the body, keeps no refs. TON
  global version 12 (mainnet since 2025-11-13; mainnet config 8 reads version 16 today) renamed the `ihr_fee` field of
  an internal message to `extra_flags`. A message sent with `extra_flags = 3` bounces as
  `new_bounce_body#fffffffe original_body:^Cell original_info:^NewBounceOriginalInfo bounced_by_phase:uint8
  exit_code:int32 compute_phase:(Maybe NewBounceComputePhaseInfo)`, with the whole original body, refs included
  (`doc/GlobalVersions.md` of `ton-blockchain/ton`; docs.ton.org, foundations/messages/internal). The sender chooses
  the format, whatever the receiver's code is. Hipo's wallets send their own messages without it.
- **One transaction** can hold at most 255 actions, and on the basechain at most 1,000,000 gas (config 21). A contract
  may raise its own gas limit (`accept_message`, `set_gas_limit`) and pay from its balance, and can read the gas it has
  used so far (`GASCONSUMED`) and its price (`GETGASFEE`).
- **The tree today.** A node hears `update` and `descend` only from its parent, the Jackpot for the top node
  (`jackpot/contracts/node.fc:290-294`, `:303-315`, `:376-385`). Its init data holds the Jackpot, its level and index.
  Each new node keeps `fee::node_storage` = 0.15 GRAM; a full level-1 node is 85 cells and 38,696 bits, 0.0055 GRAM a
  year today and 0.039 at old prices (v2, Costs).
- **`withdraw_for`, measured** with the real wallet code: about 5,000 gas per owner. 150 owners used 752,000 gas; 200
  ran out of gas when each message carried a StateInit (971,000 without it).
- **Logs that explorers decode.** tongo, tonapi's library, decodes a contract's logs through `<ext_out>` entries in its
  ABI: an external out message whose body starts with a 32-bit op. DeDust, Megaton, swap.coffee and the jetton
  display-multiplier logs use that form, and it is the default of Tolk's `createExternalLogMessage`.
- **What this removes from the code.** The clock (`jackpot/contracts/jackpot.fc:385-390`, `:599-647`, `:1553-1565`);
  `quotes`, `payouts` and `claimable` (`:52-55`, `:118-122`); the quote requests of bookings, withdrawals, refills and
  draws (`:1018-1147`); recorded payouts with `return_excess` the Jackpot (`:437-466`); claims (`:469-505`,
  `:1251-1293`); `requote` (`:986-1009`); `gas_excess` confirmations (`:1299-1318`); the bounce handlers that look up
  records (`:1355-1390`); `settle_failed_payout` (`:1480-1490`). Logs today go to a 256-bit `addr_extern`
  (`jackpot/contracts/imports/utils.fc:48-63`).
- **The wallet today** throws on `prepare` while opening (`jackpot/contracts/wallet.fc:74`), answers `ready`
  bounceable with +16 (`:86-87`), takes `withdraw` only from its owner (`:151`), and closes with modes 128 + 32
  (`:60-65`).
- **TEP-74** jetton wallets send `transfer_notification(query_id, amount, sender, forward_payload)` to the owner when
  `forward_ton_amount > 0`, and the excess to `response_destination`. A `burn` makes the wallet send
  `burn_notification(query_id, amount, sender, response_destination)` to its master. **TEP-89** adds
  `provide_wallet_address` and `take_wallet_address` to the master.
- **Prototype of the graphs:** a sandbox story, a DOT generator and a renderer using `@hpcc-js/wasm-graphviz`, outside
  the repo.

## Approach

### 1. Boundaries

#### The rule

`poke` from anyone, with at least `fee::poke`, asks the treasury for a quote with a `quote_poke` context. Its reply
does, in order:

1. **The fall check, as v2.** If the reply's rate is below the stored rate, the falling flag rises.
2. **It stores the rate** as the stored rate.
3. **It is a boundary** when all of these hold:

   ```
   TC·BT·10^6 ≥ BC·TT·(10^6 + rise_min)        the rate rose by rise_min since the last boundary
   now ≥ last_boundary + min_gap                 min_gap since the last boundary
   not falling, not halted
   ```

   computed with `muldiv`, so nothing overflows. Otherwise the reply only stores the rate, and an early poke has lost
   only its own gas.
4. **Then it sends the rest to the poker.**

A boundary's work runs in the same transaction, before step 4. **The float pays only the gas the boundary really
uses:** the reply reads `GASCONSUMED` before and after the boundary work, prices the difference with `GETGASFEE`, and
takes exactly that from the float (plus `fee::unstake` if it unstakes). It raises its own gas limit for the work by
`fee::boundary_max`, a number of gas units with a margin over the worst measured boundary (a resolving draw's rollover
plus an unstake). The poker gets back what it would have got from a reply that was not a boundary, so a boundary holds
no hidden reward. `fee::draw_budget` includes `fee::boundary_max` priced at 400 nano-GRAM per gas.

#### At a boundary

- **A draw still resolving** ends first, as v2: open slots roll over (`reserved_tokens −= p`, `carried += p`), with an
  `expired` slot log.
- **A draw still waiting is a skip.** It keeps its snapshot, its tag and its pot. `R` moves to this boundary's round.
  Nothing else changes, and no new snapshot is taken: the tree still holds the waiting draw's snapshot, which its
  searches need.
- **Otherwise a new snapshot and pot:**
  1. `tag += 1`, `snapshot_tickets = tickets`.
  2. `pot = max(free_tokens − need, 0)` at this reply's rate, `need = ceil(principal·TT/TC)`. This pot holds all yield
     since the last pot was fixed, the fresh reward included.
  3. If `snapshot_tickets > 0` and `pot ≥ min_pot`: `u` as v2, but 0 unless the float can pay `fee::unstake`; then
     `pot' = pot − u`, `burn` and the prizes as v2; the unstake if `u > 0`; `reserved_tokens += pot'`,
     `burn_owed += burn`, `carried = 0`; state *waiting*. Otherwise no draw: the pot stays free, and the state stays
     *none*.
- **In every case:** `last_boundary = now`, the boundary rate becomes this reply's rate, a pending `next_min_gap`
  becomes `min_gap` (after this boundary's own rule was checked with the old value), `R` is the first drand round
  at or after `now + D`, and `mc_hash` becomes the root hash of the latest masterchain block this transaction sees
  (the `PREVMCBLOCKS` entry with the highest seqno). A `boundary_log` or `skip_log` records the rate, the pot,
  `mc_hash` and its seqno.

The pot is fixed in this transaction, at a rate read in it, before `R` is published. Nothing about the pot, the
snapshot or the burn can depend on the seed.

#### `min_gap` sets the rhythm; `rise_min` only confirms a reward

- **`min_gap` decides how often draws happen.** The first reward after `min_gap` makes the boundary. Half a round gives
  a draw each round; 2.5 rounds gives a draw every third round, whatever the APY; up to 30 days is allowed. No separate
  "longer draws" feature is needed.
- **A long `min_gap` needs an explicit `min_principal`.** The pot grows with the time between boundaries, and the entry
  price with it: with `min_gap` at 30 days and 16% APY the pot reaches about 1.2% of principal, so a default deposit,
  which refuses a price above 1%, is refunded with reason `price` late in the gap. Apps must send `deposit_options` with
  an explicit `min_principal` once `min_gap` is longer than a few rounds; the price is still fair, as shown below.
- **`rise_min` only confirms that a reward has landed.** It is far below a round's reward (0.005% against about 0.031%
  today), so it does not delay a boundary after a real reward, and far above what rounding moves in a round.
- **Forcing a boundary.** Before any part of a round's reward has landed, making the rate rise by `rise_min` with
  `gift_coins` costs `rise_min` times Hipo's total coins: about 0.005% of 9.9 million GRAM, so about 500 GRAM, given to
  all of Hipo's stakers. But Hipo credits a round's reward loan by loan, so once the first parts have landed the rate
  is already above the threshold, and anyone can place the boundary for free between two parts by poking at that
  moment. Both are harmless: each part of the reward goes to one pot or the next, and the points below show that
  choosing the moment gains nothing.
- **What `min_gap` guarantees** whatever anyone does: at most one boundary per `min_gap`, so the float pays for at most
  one draw per `min_gap`, and every draw has at least `min_gap − S` to be submitted.

#### Why the moment gains nothing

- *A deposit.* With a stored pot above 0, `booked_principal = floor(v·P/(P + pot_v))`. With `v = t·TC/TT` and
  `pot_v = F·TC/TT − P`, this is `t·P/F`: the rate cancels. In exact fractions, booking moves the price
  `t·(F·rate − P)/F` into the pot, where `rate` is Hipo's true rate, and the deposit's share of the next snapshot is
  `t/(F + t)` of a pot that grows by the factor `(F + t)/F`. Its expected prize equals its price at every moment,
  before or after a reward, whatever the stored rate (v2's proof, with the true rate). With the stored pot at 0,
  `booked_principal = v` at the stored rate, which is at most `t·P/F`; a stale rate only books the depositor less.
- *A withdrawal* is paid `min(floor(x·TT/TC), floor(F·x/P))` at the stored rate. Leaving after a reward and before the
  poke pays the leaver's principal at the old rate, so they take their own yield since the last quote: in exact
  fractions this equals leaving just before the reward, which v2 already allows, and nobody else loses. Leaving after
  the boundary gives up their chance in the draw just fixed.
- *The seed.* The pot and the snapshot are fixed at the boundary, before `R` is published. A player who leaves after
  seeing a losing seed gives up only their own chance; the pot they leave is already set aside and stays for the
  others.
- *The snapshot* is exact: every change of `tickets` is made by a Jackpot handler, and the boundary is a Jackpot
  transaction. A deposit booked before it is in; after it, out.
- *The burn* takes `b_share` of each pot, so how yield is split between pots does not change what is burned, apart
  from `carried`, which keeps a rolled prize from being burned twice.
- *drand's round* is set from the boundary's time, and its value is unknown until 60 s after it, so choosing the time
  chooses nothing. The seed also mixes in `mc_hash`, fixed at the boundary, so even someone who learns drand's value
  early cannot tell the winner before the boundary, when the snapshot is already fixed (see The draw).
- *A gift* moves part of the yield between two pots; by the points above nobody's expected result changes, and the
  gift itself goes to all of Hipo's stakers, the Jackpot included in proportion to its hGRAM.

#### Deposits and the pot

The pot of the open draw is in `reserved_tokens` from its boundary on. What is free above `need` is the yield since
that boundary, which belongs to the next snapshot. So a deposit always pays the normal price for the free pot, and
joins the next snapshot:

```
c = v                              if P = 0
c = floor(v·P / (P + pot_v))       otherwise
```

**v2's rule "`c = v` while the draw waits or quotes" is removed.** v2 needed it because its pot was fixed only after the
submit, so all free yield still belonged to the snapshot. Here the pot is set aside at the boundary, before anyone can
deposit into the open draw. The free pot a deposit pays for is one it will share: v2's sniper proof holds for it at
every moment, waiting included. And since `principal` always equals `tickets`, the price never counts principal that has
already left: no stuck step can undercharge a newcomer.

#### Skip: where the yield goes

At a skip, the waiting draw keeps the pot set aside at its own boundary. **The yield since then stays free, for the
next snapshot.** The alternative, adding it to the waiting draw's pot, would make every deposit booked since that
boundary pay a price for yield it then could not win, since those deposits are not in the waiting draw's snapshot.
With the yield left free, the deposits paid for exactly the pot they will share: the next snapshot, taken at the first
boundary after the waiting draw ends, holds them and everyone still in from before. Their held changes fold then, as v2.

#### The cut-off

No boundary can come before `last_boundary + min_gap`. A submit is taken only while
`now < last_boundary + min_gap − S`. A submit starts every search in its own transaction, so every search has at least
`S` (1,800 s) before any boundary can end the draw; 48 searches of four hops each finish in a few minutes. Only a stuck
node can still hold a slot at a boundary, which rolls it over, as v2. There is no quote after the submit, so v2's
late-reply rule is gone.

#### Timing around Hipo's reward

The reward lands, a keeper pokes within minutes, and that reply is the boundary: the reward is in the pot it fixes.

| Move | Expected result | Compared with |
|---|---|---|
| Deposit `v` just before the reward | pays the price of the free pot, whose prize returns it; then `r·v` of expected prize from the reward, less `β` | holding that hGRAM outside: `r·v`. Not better |
| Deposit after the reward, before the poke | pays for the true pot, the reward included (the rate cancels); or, with the stored pot at 0, books `v` at the old rate, less than its hGRAM is worth | not better than depositing after the boundary |
| Stay in over the reward | `(1 − β)·r·x`, plus the share of the pot before it | |
| Leave just before the reward | `r·x` for certain, and gives up its share of the pot | it is no longer playing |
| Leave after the reward, before the poke | paid at the old rate: `r·x` for certain, the same as leaving just before | equal to leaving just before |
| Leave after the boundary | `x` at the new rate; gives up its chance in the draw just fixed | worse than leaving before it |

Why the first row holds: as v2, the reward is `r·(P + Q + v)`, and the deposit's share is `v/(P + Q + v)`, so its
expected part is `r·v`, the yield of its own hGRAM. A player can cut their variance by leaving and re-entering at a
cost in gas, and takes nothing from the others.

#### Setters, deploy and liveness

- **`set_rise_min(rise_min)`** (governor), bounds above, takes effect at once.
- **`set_min_gap(min_gap)`** (governor), bounds above, is stored as `next_min_gap` and takes effect at the next
  boundary, which checks its own rule with the old value. So it never moves the earliest boundary of a running draw
  closer.
- **`clear_falling`** also sets the boundary rate to the stored rate, so that a cleared fall does not hold boundaries
  back until the rate climbs past its old level.
- **At deploy:** the deploy script reads the treasury's rate on chain and puts it in the deploy data, as both the stored
  rate and the boundary rate; `last_boundary` is the deploy time; the deploy check refuses a zero stored rate, a zero boundary rate, and values out of
  bounds. The first boundary is therefore the first reward at least `min_gap` after deploy. A poke right after deploy is
  recommended, to store the treasury's rate as the Jackpot sees it.
- **Keepers** poke shortly after each reward, and again if the reply was not a boundary. **Monitoring** alarms when
  there has been no boundary for 1.5 times the expected rhythm (`min_gap` rounded up to the next reward).

### 2. The draw

1. **`submit_randomness(signature, witness)`** from anyone, with at least `fee::submit`. In order, cheapest first:
   state *waiting*; `now < last_boundary + min_gap − S`; not halted; not falling; `float ≥ fee::draw_budget`; then the
   v1 drand check for `R`. A failed check throws. On success: store `seed`, state *resolving*, send three
   `descend(tag, i, 0, k(i,0))` from the float, and pay the submitter the rest of its value plus `submit_reward`, once
   per draw. No quote.
2. **Searches, the end and burn batching:** as v2.
3. **While the falling flag is up**, submits are refused, and a hit puts its prize back into `free_tokens`, as v2.

**The seed mixes in a TON block hash.**

```
seed   = sha256(drand_signature ‖ mc_hash)                      48 bytes ‖ 32 bytes
k(i,j) = uint256(sha256(seed ‖ uint8 i ‖ uint8 j)) mod snapshot_tickets
```

`mc_hash` is stored at the boundary, with the snapshot and `R`, and `k(i,j)` is otherwise as v2.

- **Why.** drand cannot choose a round's value: each round has one valid BLS signature. But members of drand who meet
  its signing threshold could know a future round's value early, and with a seed from drand alone they could size a
  deposit before the boundary so that it lands on a winning ticket. With `mc_hash` mixed in, that knowledge does not
  reveal the winner until the boundary, and by then the snapshot is fixed. Validators cannot bias the seed alone either:
  they shape `mc_hash`, but nobody knows drand's round at the boundary, which is published at least 60 s later.
- **Which block.** `mc_hash` is the root hash of the `PREVMCBLOCKS` entry with the highest seqno: the newest
  masterchain block the boundary's shard block refers to. Its seqno is logged next to it. An older entry would be public
  long enough to aim a deposit at it.
- **Accepted limit: a colluding drand quorum.** That newest block is public a few seconds before the boundary
  transaction. A drand quorum that knows `R`'s value can, inside one masterchain interval, compute the winner for that
  `mc_hash`, choose a partial burn size that moves `snapshot_tickets` so that the winning ticket lands on them, and race
  that burn and their own poke into blocks that still refer to the same hash. On draws where they win that race against
  the keepers, this comes close to control. It is still strictly better than a seed from drand alone, which left
  unlimited time to aim, and it needs a drand quorum to collude, a trust v1 and v2 already placed in drand. Detect:
  boundaries poked by addresses other than the keepers, and winners who burned or deposited shortly before the
  boundary.
- **Accepted limit: double collusion.** A drand quorum colluding with a masterchain or shard collator can grind more
  choices of block. And the whole argument relies on block time staying within `D` = 60 s of real time, so that `R` is
  unpublished at the boundary.
- **A skip** takes a fresh `mc_hash` with its new `R`, as every boundary does. The snapshot was fixed before, so this
  changes no ticket.

### 3. Withdrawals at the stored rate

A withdrawal is paid in the transaction that handles `burn_notification`, at the stored rate:
`paid_tokens = min(floor(x·TT/TC), floor(F·x/P))`, and `principal` and `tickets` fall together at once.

**Why the live quote was dropped.** With a quote, `principal` kept `x` until the reply while `tickets` had already let
it go. If that quote stuck, bounced or lost, waiting for the governor, the entry price `c = v·P/(P + pot_v)` counted
principal that was no longer playing and undercharged every newcomer. In the audit's example, W holds 900,000 and H
100,000; W withdraws everything and the quote sticks; D deposits 100,000 and books 99,969 instead of a fair 99,691.
D's expected net becomes +122.4 GRAM instead of −30.9, and H's prize falls from 279.0 to 153.5.

**Why the stored rate is safe now.** The pot is fixed at the boundary, before any seed exists, so a seed-informed exit
gains nothing (see Why the moment gains nothing). The auditor checked in exact fractions that leaving after a reward and
before the poke equals leaving just before the reward, and that nobody else loses. In a fall not yet seen by a poke, the
stored rate is higher than Hipo's, so a leaver takes less than their share and nobody else loses; after a poke has
raised the falling flag, the `min` pays pro rata, as v2.

**What goes with it:** the withdrawal's quote context, `resend_quote`, the bounced-withdrawal case, the
`quote_bounced` log, and v2's "`P` lags `L`" limit. Pokes are the only quotes.

### 4. Closing the tree

At the end every node holds only zeros, yet keeps its storage reserve and keeps paying rent. `close_node` deletes the
tree from the top down and returns each node's balance to the Jackpot.

- **Trigger: part of `sweep`.** `sweep` runs only when retired, not yet swept, with `principal = 0`,
  `incoming_tokens = 0` (so `tickets = 0`), `unstaking_tokens = 0` and no draw resolving. After sending the rest to the
  burner, it sends `close_node(next_position)` to the top node, carrying the whole cascade's funding (below). With
  `next_position = 0` the top node was never deployed: `close_cost(0) = 0`, and no `close_node` is sent. For it: these conditions
  already imply those of the close, and after them no deposit and no update can ever come, so one message ends
  everything and needs no new governor power. Against: anyone can send `sweep`, so the close happens as soon as the
  conditions hold; that is when it should happen.
- **At a node, the sender first, without exception.** It takes `close_node` only from its parent (the Jackpot for the
  top node), or from the Jackpot for the recovery below. A `close_node` from anyone else ends at this check, paid by its
  sender. Only then does the node check that every child's `committed + added − removed` is 0; if not, it does nothing
  more. A node never calls `accept_message` for the close: its gas is paid by the message's value alone, so no
  `close_node`, forged or not, can spend its reserve.
- **It forwards `close_node` to each child that exists.** Positions are assigned in order, and every assigned position
  got an update, so nodes exist exactly over positions below `next_position`: child `j` of node `(ℓ, i)` exists if
  `(64·i + j)·64^(ℓ−1) < next_position`. The message carries `next_position`, so nothing new is stored. A level-1 node
  has positions as children and forwards nothing.
- **Then it deletes itself**, sending its whole balance, reserve and leftovers included, to the Jackpot in the last
  action, modes 128 + 32, after the sends to its children. **The sends to the children do not ignore errors**: if any of
  them cannot be paid, the action phase fails, nothing is sent, the node is not deleted, and its children are never
  orphaned under a missing parent.
- **Funding: `sweep` pays for the whole cascade, node reserves pay nothing.** The build measured, at 400 nano-GRAM per
  gas: a level-2, 3 or 4 node forwarding to 64 children uses 263,963 gas (0.1056 GRAM) and 0.0087 GRAM of forwarding;
  the least value that reaches a child's sender check is 0.0025 GRAM; a level-1 node uses 9,804 gas to finish and delete
  itself. A node's peak outlay is 0.274 GRAM, against about 0.12 GRAM left of a 0.15 GRAM reserve after 5 years of rent,
  so reserves cannot fund it. Instead:
  - **One node's term.** `term(ℓ) = GETGASFEE(gas_ℓ) + GETFORWARDFEE(close_node)`, rounded up, at current prices. The
    gas constants `gas_1` (a level-1 node) and `gas_inner` (a node above, with up to 64 children) are **upper bounds**:
    re-measured on the new node code, which has no `accept_message`, and set to at least 1.5 times the measure. The old
    code measured 9,804 and 263,963 with `accept_message` and a constant; those numbers only guide. `GETFORWARDFEE` is
    called with cell and bit counts at least those of the real `close_node`. A node's full gas exceeds the part before
    its sender check, so the 0.0025 GRAM measured to reach that check is always covered.
  - **A subtree's cost** counts every existing node. Node `(ℓ, i)` covers positions `[i·64^ℓ, (i+1)·64^ℓ)`; with
    `b = min(n, (i+1)·64^ℓ)`, it has `max(0, ceil((b − i·64^ℓ)/64^ℓ'))` existing nodes at each level `ℓ' ≤ ℓ`, and

    ```
    subtree_cost(ℓ, i, n) = Σ over ℓ' = 1..ℓ of  max(0, ceil((b − i·64^ℓ) / 64^ℓ')) · term(ℓ')
    close_cost(n)         = 0                                           if n = 0
                          = subtree_cost(4, 0, n) · margin, rounded up   otherwise
    ```

    It counts a full node at every level under a child that holds a single position, which a split by positions did
    not. The margin is applied at the top, fixed by test, at least 1.5.
  - **Each node keeps `term(self) − fwd` and splits the rest of its value among its existing children in proportion to
    their `subtree_cost`**, where `fwd = GETFORWARDFEE(close_node)`: its own inbound forwarding was already paid out of
    the value its parent sent. Sends use mode 0: the forwarding fee is paid out of the value given, and the value given
    includes it. So the top's margin flows down: each child gets at least its `subtree_cost` times the margin, and a
    leaf whose code uses a little more gas than measured still finishes. A node's gas limit is what its value buys,
    since it never calls `accept_message`.

    ```
    keep            = term(self) − fwd
    share(child)    = (value − keep) · subtree_cost(child) / Σ subtree_cost(children), rounded down
    closes only if    value ≥ keep + Σ subtree_cost(children)            (unscaled)
    ```

    **If it is short, it does nothing and keeps the value**, and stays, with its subtree, for `close_subtree`. A level-1
    node has no children and keeps all.
  - Then it sends its whole balance to the Jackpot, as above. **What is left over stays with the node that has it** and
    comes back to the Jackpot with that node's reserve.
  - **The sender pays, the float does not.** `sweep` must bring `fee::sweep + close_cost(next_position)`; the float
    changes by 0 for the close, and only what the value brings above that comes back to the sender. This replaces the
    current `send_excess(src, −close_hop_value())` pattern, which took the close's value from the float.
  - **Example**, 10,000 players (162 nodes): the cascade's real cost is about 0.2 GRAM at today's 66.67 nano-GRAM per gas
    (about 1.2 GRAM at 400), `sweep` sends that times the margin, and everything not spent comes back to the Jackpot
    with the reserves, up to about 24 GRAM.
  - Whoever sends `sweep` advances that GRAM, which comes back to the Jackpot, not to them; in practice the governor
    sends it.
- **Gas.** About 264,000 gas (old measure) and 65 actions for a node with 64 children: about a quarter of the 1,000,000
  gas limit and of the 255-action limit; `gas_inner`, with its headroom, stays well under the limit. **If a node is short** anyway (prices rose between its parent's turn and its own), it does nothing,
  or if a send still cannot be paid its action phase fails; either way it stays, with its subtree, and `close_subtree`
  recovers it.
- **Order.** Each parent-child pair delivers in order, so any update sent before the close reaches every node ahead of
  it, and so do stray searches of an ended draw, which the Jackpot then ignores.
- **A frozen, missing or short node.** A frozen node cannot run: the non-bounceable `close_node` pays its debt and it
  stays, with its subtree. A missing node cannot occur below `next_position`; if one were deleted for debt, the message
  lands on an empty address and nothing happens. A short node fails and stays, with its subtree. In each case no player
  funds are involved (every sum is 0), only the reserves stay unrecovered. **Recovery:** anyone can top a frozen node
  up, and the governor's `close_subtree(level, index)`, taken only after the sweep, sends `close_node` from the Jackpot
  to that node with `subtree_cost(level, index, next_position)` times the margin, and refuses less; the margin flows down
  as in the cascade, so recovering a level-2 node closes its leaves too. It refuses a node whose first position,
  `index·64^level`, is at or past `next_position`: that node was never deployed.
- **`close_subtree` order: the highest stranded nodes only.** If a child is closed before its stranded parent, the
  parent's later close still sends that child its share, about 0.004 GRAM, to an address that is now empty, where it
  stays. So the governor closes only the highest nodes still standing, and `scripts/closeSubtree.ts` picks them.
- **What it recovers.** Every node's remaining balance, up to `fee::node_storage` = 0.15 GRAM each, and the rent it would
  keep paying: 0.0055 GRAM a year per full level-1 node today, 0.039 at old prices. A tree that reached `n` positions has
  `ceil(n/64) + ceil(n/4096) + ceil(n/262144) + 1` nodes: 162 nodes for 10,000 positions (up to about 24 GRAM back, about
  0.9 GRAM a year of rent stopped today), and 1,590 for 100,000 (up to about 238 GRAM, about 8.6 GRAM a year). The GRAM
  comes back to the float, with the cascade's unspent funding, and the governor takes it with `withdraw_surplus`.

### 5. Refill and falls

- **Refill** is as v2, but asks for no quote: `u` is computed at the stored rate.
- **Accepted limit:** a refill at a stale rate after a fall could unstake up to about 15 GRAM (`float_high`) of hGRAM
  that backs principal, because the stale, higher rate makes the pot look larger than it is. This depends on Hipo's
  rate never falling, which its code keeps: a burn removes coins and tokens together, and an uncovered loss goes to the
  `deficit` counter instead of `total_coins` (see Context).
- **`settle_unstake(amount, credit)`** (governor). `sweep` requires `unstaking_tokens = 0`, so a stuck count would block
  the end for good. With `credit = true` it works as v2: `unstaking_tokens −= amount`, `held_tokens += amount`, for a
  rollback whose hGRAM is back in the wallet. With `credit = false` it only lowers `unstaking_tokens`, for an unstake
  whose GRAM in fact arrived but whose notification was missed. The governor checks the chain first, as for every
  recovery.
- **The falling flag** and its handling stay as v2, as defence in depth: a poke's reply below the stored rate raises
  it; while it is up, bookings are refused, submits are refused, no boundary is made, a hit's prize goes back into
  `free_tokens`, the burn is held, and withdrawals pay pro rata.

### 6. No records

#### Where each context rides

| Flow | Context | Carried by | Why it is genuine |
|---|---|---|---|
| Deposit | deposit context | `prepare_deposit` to the wallet, `deposit_ready` back | `deposit_ready` is taken only from the jGRAM wallet of the owner named in the context. That wallet's code is fixed and only echoes what the Jackpot sent it. |
| Withdrawal | none needed | `burn_notification`, from the wallet | taken only from the jGRAM wallet of the `sender` it names; that wallet sends it only for its own burned balance |
| Poke | `quote_poke` | the quote's `custom_payload` | `take_current_quote` is taken only from the treasury, which answers only the sender and echoes the payload |

The poke context holds `created_at` and the poker. The quote's `query_id` is the poker's; it is a label, never a key.
The draw needs no context in a message: the pot, the snapshot and `R` are fixed in storage at the boundary.

#### Payouts

Every hGRAM transfer the Jackpot sends is non-bounceable `send_tokens` to its own hGRAM wallet. `held_tokens` falls
when it is sent. Nothing comes back to the Jackpot: `gas_excess` is ignored, whoever sends it, and its value stays in
the float.

| Payout | `return_excess` | `forward_ton_amount`, `forward_payload` |
|---|---|---|
| Withdrawal | the burn's response destination | from the burn's `withdraw_options` |
| Move | the burn's response destination | `successor_deposit_fee` + the inner amount, `deposit_options` |
| Refund of a deposit | the deposit's response destination | the caller's, `deposit_refused`; or 1 nano-GRAM and a comment, see Refusals |
| Prize | the Jackpot | `fee::prize_notify` (0.01 GRAM) from the float, a comment |
| Burn, sweep | the Jackpot | `fee::burn_forward`, empty, as v2 |
| `return_tokens` | the governor | 0, empty |

A non-empty `forward_payload` always goes in a ref (`right`), never inline.

**A payout short of value drops its forward fields.** A payout that carries the rest of a user's value (withdrawal,
refund) checks that value against `fee::payout` plus its `forward_ton_amount` first. When it is short, it goes with
`forward_ton_amount` 0 and no payload. So a short message never makes the Jackpot's own hGRAM wallet throw, which would
leave the tokens untracked.

**Payouts stay non-bounceable, even with full-body bounces.** For it: the first hop cannot fail by design. The
Jackpot checks everything its own hGRAM wallet checks before it sends: the fee (with the rule above), the amount
(`held_tokens` never exceeds the wallet's balance), a basechain recipient that is not the Jackpot. A bounce would also
leave the Jackpot nothing good to do: sending again could loop, and keeping the tokens is what non-bounceable already
gives. Against: if the first hop fails anyway, through a bug or a change in Hipo's wallet, the hGRAM waits for the
governor's `return_tokens` instead of coming back into the count. The second hop is inside Hipo's wallet code, which
bounces in the old format and handles it itself, so it stays a governor return whatever the Jackpot chooses.

#### Full-body bounces

- **Every bounceable message the Jackpot sends carries `extra_flags = 3`**: `prepare_deposit`, `deposit_booked`,
  `deposit_cancelled`, `close_wallet`, `burn` (for `w` and `withdraw_for`), the poke's `provide_current_quote`,
  `unstake_tokens`, and `take_wallet_address`. The jGRAM wallet sends `deposit_ready` and `burn_notification` the same
  way. Messages to nodes stay non-bounceable, as v2, `close_node` included, so none of them bounces. `utils.fc`'s
  `send_msg` gains the field.
- **A bounce is recognised by the bounced flag only** (`flags & 1` of the incoming message), never by its body. Only the
  network can set that flag. A message that is not bounced and whose body starts with `0xfffffffe` throws 107
  (`invalid_op`), in the Jackpot and in the wallet, as for any unknown op. Otherwise anyone could send a forged `new_bounce_body` wrapping a made-up
  `prepare_deposit` and be "refunded" tokens they never sent.
- **Every bounce handler**, the Jackpot's and the wallet's, reads `new_bounce_body#fffffffe` and takes the op and the
  fields from `original_body`.
- **The Jackpot does not accept the old format.** Every bounceable message it sends asks for the new one, so an
  old-format bounce cannot answer one of them. It is ignored, and its value stays. Its code can be upgraded if that
  ever changes.
- **The wallet accepts the old format as well, for its two bounceable messages**, because wallet code can never be
  upgraded:
  - `burn_notification`: it reads `amount` from the first 220 bits and restores it. `last` lies past the 256 bits, so
    the wallet leaves `pending` as it is. At worst `pending` stays one too high and the wallet never closes, which keeps
    its storage reserve in it and loses no principal.
  - `deposit_ready`: it reads `busy` from the first 97 bits and, if it was false, lowers `pending`.

  It ignores any other old-format bounce.
- Full-body bounces cost more forwarding, paid from the bounced value.

#### Untracked hGRAM and the governor's recovery message

**`return_tokens(owner, amount, in_flight)`.** As v2 when `in_flight` is false: `held_tokens += amount`, then a payout.
With `in_flight` true, the tokens are still counted as incoming: it needs `amount ≤ incoming_tokens`, then
`incoming_tokens −= amount` and a payout. The governor reads the owner and the amount from the chain.

**The governor acts only after seeing on chain that the step can never finish by itself:** a bounce that has been
handled, or a message that left no bounce. Each of these is final. Returning tokens still on their way would pay them
twice. The run-book says so for each case. This is trust in the governor, the same as its upgrade power, not a new
power.

#### Failures

| Case | What the Jackpot sees | Where hGRAM and GRAM end up | Counters | Recovery |
|---|---|---|---|---|
| The undo of a bounced `deposit_booked` cannot send its refund (the refund's send carries +2) | the bounce | the principal and the tickets are undone; the refund is lost and its hGRAM stays in the wallet, outside `held_tokens`, with no `untracked_log` | undone | `return_tokens`, found by comparing the Jackpot's hGRAM wallet balance with `held_tokens` |
| A poke's `provide_current_quote` bounces | full bounce with the context | the rest goes to the poker | none | itself |
| A poke's quote gets no reply (the treasury's send fails with no +16, or the reply's transaction aborts) | nothing | GRAM at the treasury or the Jackpot | none | none needed: the next poke |
| `prepare_deposit` bounces: wallet frozen, or it could not send `deposit_ready` | full bounce with the context | `deposit_tokens` refunded to the response destination, reason `wallet_unavailable` | `incoming_tokens −= t`; the payout lowers `held_tokens` | itself |
| `prepare_deposit` with no bounce: a frozen wallet's debt took its value | nothing | hGRAM in `held_tokens` and `incoming_tokens` | unchanged | `return_tokens(response, t, true)`; `response` is the context's response destination, read from the `prepare_deposit` on chain |
| `deposit_ready` fails at the Jackpot (compute, or an action, which carries +16) | nothing; the wallet gets the bounce | hGRAM in `held_tokens` and `incoming_tokens` | unchanged; the wallet lowers `pending` if it had raised it, and closes if it is then empty | `return_tokens(response, t, true)`, `response` read from the bounce on chain |
| `deposit_booked` bounces | full bounce with `booked_principal`, `position` and the reply fields | `paid_tokens` for `booked_principal` at the current stored rate, refunded to the response destination, reason `wallet_unavailable`; the entry price and any rise since the booking stay in the pot, see below; `deposit_cancelled` to the wallet, its own bounce ignored | undone as v2: `principal`, `tickets` and the tree fall, `held_tokens −= paid_tokens`; the wallet's `pending` falls | itself |
| `burn_notification` fails at the Jackpot (compute, or an action, which carries +16) | nothing changed | the wallet restores the amount from the bounce and sends the rest to the owner | none | itself |
| A payout's first hop fails | nothing (non-bounceable, see Payouts) | hGRAM stays in the Jackpot's hGRAM wallet, untracked; GRAM there too | already final | `return_tokens` |
| A payout's second hop fails | `gas_excess` from its own wallet, ignored | hGRAM back in the Jackpot's hGRAM wallet, untracked; GRAM in the float | already final | `return_tokens` |
| A refund or a burn to the burner fails | as a payout | untracked | already final | `return_tokens` to the response destination or the burner |
| A self-recovery's refund cannot be paid from the bounced value | the bounce | the refund's tokens leave the count, untracked; an `untracked` log | as the refund would have left them | `return_tokens(response, amount, false)`; nothing is lost |
| `w` or `withdraw_for` to a frozen jGRAM wallet | full bounce of `burn`, which names no owner | the value stays in the float | none | revive the wallet (`scripts/reviveWallet.ts`), then withdraw |
| `unstake_tokens` bounces | full bounce | as v2 | `held_tokens += u`, `unstaking_tokens −= u` | itself |
| `deposit_cancelled`, `close_wallet` or `take_wallet_address` bounces | full bounce | GRAM in the float | none | none needed |
| `close_node` at a frozen or short node | nothing | that node's reserve and its subtree's stay | none; no player funds | top up a frozen node; `close_subtree` with its own funding |
| A foreign jetton or NFT arrives with too little value to send it back, or its return bounces | the notification, or the bounce | the token stays with the Jackpot; GRAM of the return, if any, in the float | none | `rescue_jetton` or `rescue_nft` |
| A payout after the Hipo migration upgrade but before the balance move has landed | nothing (non-bounceable) | the payout fails at the new wallet's first hop; its hGRAM arrives in the new wallet with the move, outside `held_tokens` | already final | `return_tokens` once the move has landed; nothing is lost |
| hGRAM left in an old wallet, if the move missed some | nothing | the old wallet | already final | `rescue_jetton` from the old wallet |

**Value for the refunds.** `prepare_deposit` and `deposit_booked` each carry at least
`fee::bounce_floor = fee::update + fee::release + fee::payout + 2 · fee::handler + 10,000,000` (0.25 GRAM), sized at
400 nano-GRAM per gas: the undo of a bounced `deposit_booked` sends the tree update and `deposit_cancelled` before the
refund, so the floor covers update + cancel + refund + two handlers + the forwarding of all of them. The undo's refund
send ignores errors (mode +2): a refund lost leaves hGRAM untracked, which `return_tokens` recovers, and the undo
itself stands, so principal never stays without its jGRAM and `sweep` is not blocked. `fee::deposit` is sized so that `deposit_booked`, the last of them, still has
that much. What is not needed comes back with the excess. If a bounce is short anyway, its refund becomes a
`return_tokens` job, as the table says, and nothing is lost.

**The refund of a bounced `deposit_booked` keeps the entry price in the pot.** It pays `paid_tokens` for
`booked_principal` at the stored rate when the bounce arrives, not the `deposit_tokens` the deposit brought. The
difference is the entry price, at most what the deposit's `min_principal` allowed, 1% by default, plus, if a poke has
raised the stored rate since the booking, the rise on those tokens. Both stay because a boundary may already have fixed
a pot that holds them; refunding them would break `F·TC ≥ P·TT`.

**A zero quote** (`quote_coins` or `quote_tokens` 0) is ignored, and the stored rate is kept. Hipo does not send one.

**Exactly what still needs the governor:**

- a `prepare_deposit` whose value a frozen wallet's debt took: `return_tokens(…, true)`;
- a `deposit_ready` that fails at the Jackpot: `return_tokens(…, true)`;
- a payout that fails at either hop, a refund whose bounced value could not pay it, and anything sent to the Jackpot's
  hGRAM wallet without a notification: `return_tokens`;
- a node left by the close: `close_subtree`, with its own funding, after a top-up if frozen;
- a foreign jetton or NFT that came with too little value to go back: `rescue_jetton`, `rescue_nft`.

#### Why forged messages gain nothing

- **`take_current_quote`** from any address but the treasury is ignored. The treasury answers only the sender, so every
  poke context the Jackpot reads from it is one the Jackpot sent. A boundary needs a real rise of Hipo's rate, which
  only Hipo's treasury reports.
- **`poke`** can come from anyone, any number of times. It costs the poker its gas, and a reply is a boundary only when
  the rule holds.
- **`deposit_ready`** from any address but the jGRAM wallet of the context's owner is ignored, and its value stays.
  That wallet answers each `prepare_deposit` once and echoes its context, so a context comes back once.
- **`burn_notification`** from any address but the jGRAM wallet of the `sender` it names is ignored. That wallet sends
  it only after taking the amount from its own balance.
- **`close_node`** from any address but the node's parent or the Jackpot is ignored, and a node with any non-zero sum
  refuses it. A node never accepts gas for it, so no `close_node` spends its reserve.
- **`transfer_notification` from any wallet but the Jackpot's hGRAM wallet** is a foreign jetton or a fake. The Jackpot
  answers only with a transfer back, paid by the notification's own value; a fake wallet just receives a message its own
  sender paid for. See Foreign jettons and NFTs.
- **`gas_excess`** is ignored. Nothing is confirmed by it any more.
- **Bounces** are recognised by the bounced flag, which only the network sets, and carry the body the Jackpot sent. A
  body that imitates a bounce without the flag throws.
- **What this adds to trust in Hipo:** the treasury must keep answering only the sender and echoing `custom_payload`
  unchanged, and keep its rate from falling. Hipo's treasury upgrade checklist gets both lines.

#### Invariants

```
free_tokens = held_tokens − incoming_tokens − reserved_tokens ≥ 0
F·TC ≥ P·TT              at the stored rate
hGRAM wallet balance ≥ held_tokens
tickets = principal
```

- No failure above raises `free_tokens` or lowers `principal` without paying. A refunded deposit lowers
  `held_tokens` and `incoming_tokens` together. An undone booking lowers `free_tokens` by at most
  `booked_principal·TT/TC` and `principal` by `booked_principal`, as v2. A failed payout leaves its counters as if it
  had arrived.
- The rounding rules of v2 hold at the stored rate: a booking adds `c ≤ v ≤ t·TC/TT`; a withdrawal takes at most
  `x·TT/TC`; a boundary takes at most `free_tokens − need`; a poke's higher rate only raises the left side, and a lower
  one raises the falling flag.
- `tickets = principal`: a booking raises both by `c`, a withdrawal lowers both by `x`, an undone booking lowers both by
  `c`, in the same transaction each time.
- Each `deposit_tokens` is booked or returned once: one `prepare_deposit`, then either its bounce or one `deposit_ready`,
  which books or refuses in the same transaction, or bounces and leaves the tokens incoming for the governor.
- Each `withdrawn_principal` is paid once: the wallet burns it once; the Jackpot pays it in the transaction that handles
  `burn_notification`, or that message bounces back and the wallet restores it.
- Withdrawals are never refused: `burn_notification` never throws, while halted, retired, falling, in a draw, or with
  no float.

### 7. Composable at every interaction point

#### Deposit

The caller sends hGRAM to the Jackpot with a `forward_ton_amount` of at least
`fee::deposit + forward_ton_amount_inner + (payload ? fee::payload : 0)`, and a `forward_payload` that is one of:

- **`deposit_options`**, in a ref: `min_principal`, `beneficiary`, `response_destination`, `forward_ton_amount`,
  `forward_payload`. `addr_none` means the depositor. The options do not fit inline beside the transfer's other
  fields, so apps put them in a ref; the Jackpot reads both forms.
- **Nothing, a comment, or anything else:** a default deposit. Beneficiary and response destination are the depositor,
  `min_principal` is `deposit_value − floor(deposit_value/100)`, and no notification is asked for. With a long
  `min_gap` the price can pass 1%, so apps send an explicit `min_principal` then (see Boundaries).

The chain is: the transfer, its notification, `prepare_deposit`, `deposit_ready`, the booking. Each step is one
transaction.

1. **Notification at the Jackpot**, from its own hGRAM wallet only; one from any other wallet takes the foreign path
   under Foreign jettons and NFTs. A mint or `amount = 0` or a sender off the basechain:
   ignored, as v2. Then it is refused at once, with its reason, if: halted, retired, options that start with the op but
   do not parse, a beneficiary or response destination that is not a basechain address or is the Jackpot, a payload
   above `max_payload_cells`, or too little value. The refund needs `fee::return`; below that the tokens stay untracked,
   as v2. Otherwise: `held_tokens += t`, `incoming_tokens += t`, and it sends `prepare_deposit(query_id, context)` to
   the beneficiary's jGRAM wallet, bounceable, with StateInit, carrying the rest. `query_id` is the caller's.
2. **At the wallet.** Opening (no position, `pending > 0`): it answers `deposit_ready(busy = true)` and changes nothing.
   Otherwise `pending += 1` and it answers `deposit_ready(busy = false, position or none, context)`. Both are
   bounceable, mode 64 + 16, so a reply that cannot be sent bounces the `prepare_deposit`.
3. **`deposit_ready` at the Jackpot books**, in one step, at the stored rate. Taken only from the jGRAM wallet of the
   context's owner. Every action carries +16, so a failure bounces `deposit_ready` to the wallet (see Failures).
   - Busy: refused with `wallet_busy`, `incoming_tokens −= t`, refund.
   - Otherwise the price is read with `t` still incoming, by the formula under Deposits and the pot, then
     `incoming_tokens −= t`. Refused if halted, retired, falling, `deposit_value < min_deposit`,
     `booked_principal = 0`, `booked_principal < min_principal`, or a new position with the tree full. A refusal sends
     `deposit_cancelled` to the wallet and refunds.
   - A booking: `principal += c`, `tickets += c`, the position (a new one only now, never reserved before), the tree
     update, and `deposit_booked(query_id, booked_principal, position, reply)` with the rest. It logs the booking.
4. **`deposit_booked` at the wallet.** `balance += booked_principal`, `pending −= 1`, the position. It reserves its
   storage first, as v2, and only then sends. If the reply's `forward_ton_amount > 0`, it sends the owner
   `transfer_notification(query_id, booked_principal, sender = the depositor, forward_payload)` with that amount,
   mode 1 + 2. Then `gas_excess(query_id)` with the rest to the response destination, mode 128 + 2. Nothing here
   throws.
5. **`deposit_cancelled` at the wallet:** as v2's `release`.

**`deposit_booked` stays a custom op**, the way Hipo mints with its own op. The position is assigned when the deposit
is booked, never reserved earlier: an early reservation would let anyone use up positions with deposits that are then
refused.

**Refusals.** A refund is an hGRAM transfer of `deposit_tokens` to the response destination with the caller's
`query_id`.

- After options: the caller's `forward_ton_amount`, and `forward_payload = deposit_refused(reason, caller's payload)`.
  The caller's payload is left out when the reason is `bad_options`.
- After a default deposit: 1 nano-GRAM and the comment `Hipo Jackpot: deposit returned (<reason text>)`, so a person sees
  why in their wallet app.
- When the value cannot pay those, the refund carries neither.
- A refusal for `bad_options`, which includes an invalid `response_destination`, refunds the depositor, never the
  address the options named.

**For integrators.** Anyone can name any `response_destination`, so a `deposit_refused` from the Jackpot does not prove
that the receiver made the deposit. A receiver credits only the hGRAM amount its own wallet notified, never a figure in
the payload.

| Code | Name | Text |
|---|---|---|
| 1 | `halted` | paused |
| 2 | `retired` | closed for deposits |
| 3 | `rate_falling` | Hipo's rate fell |
| 4 | `below_min_deposit` | below the minimum deposit |
| 5 | `price` | entry price above your limit |
| 6 | `wallet_busy` | your first deposit is still being booked |
| 7 | `tree_full` | no room for new players |
| 8 | `bad_options` | options could not be read |
| 9 | `low_value` | too little GRAM attached |
| 10 | `wallet_unavailable` | your Jackpot wallet could not take it |

**A caller who is not the beneficiary** pays and receives the excess and any refund. The beneficiary receives the
booking notification and, as in v2, what is left of the tree update. A deposit for someone else is a gift: it cannot
take anything from them, and racing their first deposit only gets one of the two refused with `wallet_busy`.

#### Withdrawal

A withdrawal starts with the standard TEP-74 `burn` on the jGRAM wallet. The chain is: `burn`, `burn_notification`, the
payout.

1. **`burn(query_id, amount, response_destination, custom_payload)`** at the wallet. What the burn's own fields can
   carry stays in them: `query_id`, `amount` (0 means all, and needs a balance above 0), and `response_destination`,
   which gets the leftover GRAM (`addr_none` means the owner). `custom_payload` holds the rest, or is absent:
   `withdraw_options(to_successor, forward_ton_amount, forward_payload)`; absent means paid to the owner, no
   notification.
   - **From the owner:** as v2's `withdraw`: `fee::withdraw + forward_ton_amount + (payload ? fee::payload : 0)` or
     more, `x ≤ balance`, `x = balance` or `x ≥ 1 GRAM`, a payload within `max_payload_cells`, a
     `response_destination` that is `addr_none` or a basechain address. A `custom_payload` of another shape throws.
   - **From the Jackpot** (`w`, `withdraw_for`): `amount` is 0, all. It never throws. With `balance = 0` it sends the
     value to the owner, and if `pending = 0` as well it closes, modes 128 + 32. A wallet that the message's StateInit
     just deployed is in that case.
   - **From anyone else:** throws.
   - Then `balance −= x`; when the balance is now 0, `pending += 1`, as v2. It sends
     `burn_notification(query_id, x, sender = owner, response_destination, last, position, options)` to the Jackpot,
     bounceable, mode 64.
2. **`burn_notification` at the Jackpot pays**, in one step, at the stored rate. Taken only from the jGRAM wallet of
   `sender`. It never throws: not while halted, retired or falling, not in a draw. Every action carries +16, so a failure
   bounces it and the wallet restores `x`. `tickets −= x`, the tree update, `close_wallet` if `last`,
   `paid_tokens = min(floor(x·TT/TC), floor(F·x/P))`, `principal −= x`, `held_tokens −= paid_tokens`, a
   `withdrawal_log`, and the payout with the rest of the value:
   - **A move**, if `to_successor`, a successor is set, and **the value left at that point** is at least
     `successor_deposit_fee + inner forward amount + fee::payout`: see Migration. The value left is the incoming value
     less what the handler has already sent from it (`fee::update`, and `fee::release` for a full burn), less the gas it
     has used and will use, less the forwarding of its messages. It is not the incoming value: judged on that, a move
     could be chosen whose transfer then carried too little and Hipo's wallet threw at the first hop, leaving the jGRAM
     burned and the hGRAM untracked.
   - **Otherwise the owner:** `send_tokens(query_id, paid_tokens, owner, return_excess = response_destination,
     forward_ton_amount, forward_payload)`. If the value is below `fee::payout + forward_ton_amount`, the forward fields
     are dropped, as under Payouts. The owner's hGRAM wallet then sends the TEP-74 notification (`sender` = the Jackpot)
     when `forward_ton_amount > 0`, and `gas_excess` with the rest to the response destination. Nothing passes back
     through the Jackpot.
   - `paid_tokens = 0`: `gas_excess(query_id)` to the response destination, as v2.

#### Prizes

A prize is a transfer to the winner with `forward_ton_amount = fee::prize_notify` and the comment
`Hipo Jackpot prize: draw <tag>, <1st|2nd|3rd>`. `fee::prize_notify` is a constant, 0.01 GRAM: 25,000 gas at 400
nano-GRAM per gas, about 150,000 at today's price. That is enough for a receiving contract to parse the notification and
go on from its own balance. It is paid from the float, 0.03 GRAM a draw, and `fee::draw_budget` adds
`3 · fee::prize_notify`.

**Recommended: a comment.** For it: people see it in their wallet app, and a contract recognizes a prize from the
notification's `sender`, the Jackpot, and the fixed prefix; the comment's format is fixed, so the draw and place parse
too. Against: text costs a contract more gas to parse than fixed fields. A **binary payload** `jackpot_prize(tag, slot)`
is the alternative; wallet apps would show it as raw data.

#### Jetton metadata

The token stays jGRAM. Its TEP-64 `content`: name "Hipo Jackpot GRAM", symbol `jGRAM`, 9 decimals, and the description
"Non-transferable. Your principal in Hipo Jackpot; withdraw to get hGRAM back." `deployJackpot.ts` checks, against an
indexer's jetton list, that no well-known jetton already uses the symbol `jGRAM`, and stops if one does.

#### TEP-89

`provide_wallet_address(query_id, owner, include_address)` from anyone, with at least `fee::wallet_address`. The Jackpot
answers `take_wallet_address(query_id, wallet, owner if asked)`, bounceable, mode 64, as the reference minter does.
`wallet` is `addr_none` for an owner that is not a basechain address. It changes no state.

#### Foreign jettons and NFTs

A `transfer_notification` from any wallet other than the Jackpot's hGRAM wallet comes from a foreign jetton, or is a
fake. The Jackpot cannot tell which, and needs not to.

- **Sent back when the value covers it.** If the notification's value is at least `fee::foreign_return`, and its
  `sender` is a basechain address other than the Jackpot, the Jackpot sends the notifying wallet a TEP-74 `transfer`:
  `amount` to the original `sender`, `response_destination` = that `sender`, 1 nano-GRAM forward and the comment
  `Hipo Jackpot: this token is not accepted`. **It pays with the message's value only, the log included:** as the code's
  `send_rest` does, it reserves the balance the Jackpot had before the message (`bal0`) and sends with mode 128, so the
  gas, the log's fee and the transfer all come out of the incoming value and the float ends exactly where it was. The
  transfer carries `extra_flags = 3`.
- **A return that bounces**, for example at a jetton wallet that needs more gas, means the token is held: the bounce
  changes no state, though the log may already have said `sent = true`. Recover it with `rescue_jetton`.
- **A fake wallet** only receives a message paid for by its own sender. Nothing of the Jackpot's moves.
- **Too little value:** the tokens stay. The log is written only if the incoming value covers its fee, so the float
  never pays for it. The governor's `rescue_jetton(jetton_wallet, amount, destination)` sends a TEP-74 `transfer` from
  any jetton wallet the Jackpot owns, on the governor's value. `jetton_wallet` and `destination` must be basechain
  `addr_std`; it compares the parsed workchain and hash of `jetton_wallet` with the current hGRAM wallet and refuses a
  match: hGRAM inside the count goes back only through `return_tokens`, which keeps the counters right. It can still
  reach an old hGRAM wallet; that is governor trust, and it is the recovery path under Hipo upgrades.
- **NFTs: recommended, the same way.** An `ownership_assigned` is treated alike, with the same check on `prev_owner`:
  with a basechain `prev_owner` other than the Jackpot and at least `fee::foreign_return`, the Jackpot sends the item a
  TEP-62 `transfer` back to `prev_owner`, `response_destination` = `prev_owner`, with the same comment and the same
  `bal0` reserve; an `addr_none` `prev_owner` (a mint), the Jackpot itself, or too little value means the item is held,
  and the governor's `rescue_nft(nft, destination)` sends it on. For it: a mistaken send is undone by itself, with the
  same few lines as jettons. Against: one more handler; rejecting would leave a mistaken NFT stuck for good.
- **Never an item of Hipo's bill collection.** The Jackpot never returns an item from Hipo's bill collection by itself,
  see Risks.
- **Notifications from an old hGRAM wallet** after `set_hipo_wallet` are foreign too, and are sent back.

#### Hipo upgrades

- **The fixed-code contracts do not depend on Hipo.** A jGRAM wallet stores the Jackpot, its owner, its balance, its
  position and `pending` (`jackpot/contracts/wallet.fc:15-21`); a node stores the Jackpot, its level and index, its tree
  parent's hash and its arrays (`jackpot/contracts/node.fc:37-97`). Neither stores nor derives Hipo's treasury, parent,
  hGRAM wallet code or address. Everything of Hipo's lives in the Jackpot's upgradable data.
- **Setters, for a change that keeps the token's worth.** `set_hipo_wallet` (parent, wallet, wallet code) stays, and
  `set_treasury(treasury)` is added, since the code had no way to change the address a poke asks. Both require the
  Jackpot to be halted, both require basechain `addr_std` addresses with no anycast, and each writes a log. **They are
  allowed only for a change that keeps one token worth the same**: the same rate, `k = 1`, such as new wallet code under
  the same value. The reason: halting stops neither burns nor pokes, so with `k ≠ 1` a burn between a setter and the
  rescaling of the stored rate is paid at a rate in the wrong unit, and the other players lose the yield waiting for
  the pot.
- **A Hipo wallet or treasury migration comes with its own spec**, and a Jackpot code upgrade written for Hipo's actual
  migration. Moving the hGRAM balance and keeping withdrawals paying across it depend on Hipo's mechanism, and a generic
  mechanism built now could be wrong. It needs only the Jackpot's upgrade, never new wallets or nodes.
- **A migration is done by the Hipo migration upgrade.** This is a future code upgrade, written for Hipo's actual
  migration. Like every code upgrade it is entered through `upgrade_code`, and its work runs inside that upgrade's
  `migrate` method; below, "the Hipo migration upgrade" means that upgrade, never the `migrate` method every upgrade
  calls. In one transaction it repoints the wallet, parent and wallet code; sets the treasury; sets the stored rate and
  the boundary rate, or rescales both by `k`, the new token's worth in old tokens; and starts the move of the hGRAM
  balance. So no burn or poke runs on the old rate after the switch.
- **Nothing in the old unit may be in flight.** A deposit context's `tokens` in `prepare_deposit` and `deposit_ready`,
  and the `u` in an `unstake_tokens` bounce, are amounts in the old unit; after a rescale by `k ≠ 1` they would be read
  in the new one (with `k = 2`, a refused `deposit_ready` would refund `t` new tokens, worth `2t` old). So the Hipo
  migration upgrade refuses unless `incoming_tokens = 0` and `unstaking_tokens = 0`. Halting stops new deposits, so
  normal ones in flight drain within seconds; before the upgrade the governor clears a stuck deposit (one behind a
  frozen wallet is the likeliest) with `return_tokens(…, true)` and a stuck unstake with `settle_unstake`.
- **The balance move takes several messages.** Moving hGRAM between Hipo wallets cannot be done in one transaction, so
  the Hipo migration upgrade only starts it. A payout sent before the new wallet holds the balance fails at its first
  hop; its hGRAM then arrives in the new wallet with the move, outside `held_tokens`, and is recovered with
  `return_tokens`. Nothing
  is lost. An `unstake_tokens` bounce or a `withdrawal_notification` from the old wallet is ignored, which the rule
  above makes moot.
- **The sequence.** Halt; wait for `incoming_tokens` to drain, and clear anything stuck with `return_tokens` and
  `settle_unstake`, until `incoming_tokens = 0` and `unstaking_tokens = 0`; the Hipo migration upgrade, as above; once the
  move has landed, a poke, which only confirms the new treasury's rate against the set one (no boundary while halted; a
  fall it raised would show the rescale wrong), and `return_tokens` for any payout caught during the move; unhalt.

#### Limits

- **Payload size:** the cap counts only the caller's inner `forward_payload`, the one inside `deposit_options` or
  `withdraw_options`, never the wrapping the Jackpot adds (`deposit_refused`, a move's `deposit_options`), so a wrapped
  payload is never refused for size. It is at most `max_payload_cells` = 8 cells, counted by `CDATASIZEQ` with that
  bound, so the count costs bounded gas. That holds a comment of about 1,000 characters or any usual contract payload.
- **Why a cap.** Every hop's fee is a constant, checked once at the start of the flow. The forwarding fee of a hop grows
  with the payload it carries, so the constants are sized for the largest payload allowed. Without a cap, a caller could
  attach a payload whose forwarding over the later hops costs more than the constants. The chain would then fail halfway,
  or take the difference from the float.
- **The payer pays:** any payload adds `fee::payload`, sized for 8 cells over every hop it rides (four for a deposit,
  four for a withdrawal). Unused GRAM comes back as excess. The Jackpot's balance does not fall in any user chain.
- **`query_id`:** the caller's rides as a label on every message of its flow. Nothing is looked up by it, so two flows
  with the same one do not interfere.

### 8. Comments

**`w`.** A plain message to the Jackpot whose body is the comment `w` or `W` (a phone keyboard may capitalize), with at
least `fee::comment_withdraw`. The sender must be a basechain address, or it throws. The Jackpot sends the sender's jGRAM
wallet `burn(0, 0, addr_none, withdraw_options(false, 1 nano-GRAM, comment "Hipo Jackpot withdrawal"))` with the
wallet's StateInit, carrying the rest. Halted or retired, it works the same.

The StateInit is there so that a `w` from someone with no wallet, or a closed one, deploys a bare wallet that returns all
its GRAM to the sender and deletes itself. Without it the GRAM would bounce to the Jackpot, and even a full-body bounce
cannot say whom to refund, since `burn` names no owner.

**Any other comment** throws (error 423, `bad_comment`), so the sender's GRAM bounces back. There is no `d`. A top-up
is an empty body, an empty comment, or `top_up`.

| Where | Comment |
|---|---|
| Payout of a `w` or `withdraw_for` | `Hipo Jackpot withdrawal` |
| Prize | `Hipo Jackpot prize: draw <tag>, <1st\|2nd\|3rd>` |
| Refund of a default deposit | `Hipo Jackpot: deposit returned (<reason text>)` |
| Inner payload of a governor move | `Hipo Jackpot: moved` |

### 9. Retire and the end

- **`retire`** (governor): `retired = true`. No message clears it. An upgrade could, since the governor writes the new
  code; that is its upgrade power, not a new one. Deposits are refused with `retired`, including those whose
  `deposit_ready` comes later. `get_jetton_data` reports mintable false. Boundaries, draws, refills, withdrawals, `w`,
  prizes and the burn go on.
- **`withdraw_for(to_successor, owners)`** (governor, retired only): up to `max_withdraw_for` owner hashes. For each, the
  Jackpot sends that owner's jGRAM wallet the `w` burn, with `to_successor` as given. Each owner is paid to themselves,
  or moved to the successor for themselves. It needs `fee::comment_withdraw + fee::withdraw_for_gas` per owner (0.0048 GRAM for the Jackpot's own gas, 12,000
  gas at 400 nano-GRAM; measured 8,326), plus `successor_deposit_fee` per owner whenever `to_successor` is set (even
  with no successor set, when each owner is paid to themselves; harmless, since the governor pays and the unspent part
  goes to the owner), and one `fee::handler`; it
  returns what is above that to the governor, so the float never pays the gas. What each owner's share does not spend goes to that
  owner as excess: a cost to the governor, never to a player. It writes no log per owner, to stay under 255 actions; each
  wallet's `burn_notification` is logged anyway. `max_withdraw_for` is 100: at about 5,000 gas per owner, 150 owners
  used 752,000 of the 1,000,000 gas limit and 200 ran out with the StateInit, so 100 leaves room for the governor check
  and the logs.
- **`sweep`** (anyone, with `fee::sweep + close_cost(next_position)`, refused with less): only when retired, not yet
  swept, `principal = 0` (so `tickets = 0`), `incoming_tokens = 0`, `unstaking_tokens = 0` (so no late unstake
  bounce or `settle_unstake` can put hGRAM back after the sweep), and no draw resolving. The close's funding comes from
  the sender's value; the float changes by 0 for it, and only what the value brings above `fee::sweep +
  close_cost(next_position)` comes back to the sender. It sets `swept` in the
  retirement cell, which refuses a second `sweep` and tells `close_subtree` and `withdraw_surplus` that the sweep
  happened.
  - **A draw still waiting is ended first:** its prizes go back to `free_tokens` and the state becomes none. Chosen over
    allowing `sweep` only in state none because, with `tickets = 0`, every ticket of the waiting draw's snapshot has
    left, so no search can hit: running it would spend 48 sure misses from the float, and with no keeper left it might
    wait for ever and block the end.
  - It then sends all of `held_tokens` (the burn owed and what is free) to the burner, sets `held_tokens`,
    `reserved_tokens`, `burn_owed` and `carried` to 0, and sends `close_node(next_position)` to the top node with the
    cascade's funding, see Closing the tree. The falling flag does not hold it back: nobody is owed anything.
- **`close_subtree(level, index)`** (governor, only after the sweep): sends `close_node` from the Jackpot to one node,
  for a node the cascade left behind, with that subtree's funding computed the same way; it refuses less.
- **After the sweep**, `withdraw_surplus` leaves 1 GRAM instead of `float_high` and the node float. No new position can
  open, and the Jackpot only has to stay alive for `return_tokens` and the getters. The nodes' balances arrive in the
  minutes after the sweep; a later `withdraw_surplus` takes them.

**The sequence from `retire` to an empty Jackpot.**

1. The governor sends `retire`. For a migration it then sends `set_successor`.
2. The next boundary takes a snapshot of everyone still in and sets the pot aside, the yield up to that reward
   included. That draw pays it. If drand is down, the draw waits, and so does step 3.
3. When that draw has ended, the governor sends `withdraw_for` batches for every owner with a balance, found from the
   booking and withdrawal logs.
4. Players may leave by themselves at any time, by `burn` or `w`. Leaving after step 2's boundary gives up its chance
   in that draw, as always.
5. Frozen wallets bounce. The governor revives them and sends `withdraw_for` again.
6. At each later boundary with tickets left, a draw runs for those still in.
7. When `principal` is 0, anyone sends `sweep`: the rest to the burner, then the tree closes from the top down.
8. The governor checks that every node is gone, uses `close_subtree` for any left, takes the GRAM with
   `withdraw_surplus`, and pays any untracked hGRAM with `return_tokens`.

**Yield after the last boundary** goes to the burner with the sweep, together with rounding dust. It is the yield of
what was still in after that boundary. Running step 3 right after the draw keeps it small, since the next reward is
then a whole `min_gap` away. The pot at retire reaches players as long as the governor waits for step 2. If it does not,
that pot goes to whichever later draw runs, or to the burner if nobody is left.

### 10. Migration

The Jackpot's code stays upgradable; wallets and nodes stay fixed. New wallets mean a new Jackpot, and players move
to it.

- **`set_successor(successor, successor_deposit_fee)`** (governor, retired only): a basechain address that is not the
  Jackpot, or `addr_none` to clear it. Logged. `scripts/setSuccessor.ts` refuses a `successor_deposit_fee` below the
  successor's `fee::deposit + fee::return + fee::payload`, read from its `get_jackpot_fees`.
- **A move** pays `paid_tokens` to the successor with `forward_ton_amount = successor_deposit_fee + inner amount`,
  `return_excess` the burn's response destination, and `forward_payload = deposit_options`. The Jackpot builds the
  options itself:
  - `beneficiary` and `response_destination` are the owner;
  - `min_principal = max(withdrawn_principal − floor(withdrawn_principal/100) − 2, 1)`, so the price is at most 1%,
    less 2 nano-GRAM of rounding between the two Jackpots' stored rates;
  - the inner amount and payload are the owner's own for an owner's move, and 1 nano-GRAM with `Hipo Jackpot: moved` for
    the governor's (the burn's comment is that one, not `Hipo Jackpot withdrawal`).
- **The owner's move:** `burn` with `withdraw_options(to_successor = true, …)` and enough value. Without a successor, or
  with a value left at the Jackpot (as above, after the update, the close, the gas and the forwarding) below
  `successor_deposit_fee + inner forward amount + fee::payout`, it is paid to the owner instead; the same value decides
  whether the forward fields are dropped from a payout. A withdrawal is never refused.
- **The governor's move:** `withdraw_for(to_successor = true, owners)`.
- **If the successor refuses**, its refund goes to the response destination: the owner's own hGRAM wallet. Nothing comes
  back to the old Jackpot, so it needs no handler for it, and no transfer bounces between the two.
- **No delay** between `set_successor` and the governor's moves (decided): `upgrade_code` has none either, so a delay
  here would stop no hostile governor, and players can always leave first by themselves.

**Trust.** The governor picks the successor, and a move sends real hGRAM to it. A wrong or hostile successor could keep
it. This adds no power the governor lacks: `upgrade_code` already lets it replace the code and move every hGRAM. A
player is protected because:

- a move happens only after `retire`, and the successor is in state, in a getter and in a log before any move;
- the beneficiary and the refund address are always the owner, chosen by the code, never by the governor;
- `min_principal` bounds the price at 1%, and a refusal returns hGRAM to the owner;
- a player can always leave with `burn` or `w` instead of being moved;
- the run-book requires the successor's code to be published and verified before `set_successor`.

### 11. Logs

Each log is an external out message with destination `addr_none`. Its body starts with a 32-bit op, then the fields, as
tongo decodes through `<ext_out>` entries in a contract's ABI. A body that does not fit inline goes in a ref, as a
message body may. The op of each log is `crc32("jackpot::<name>")`, the rule of every op in this repo, written out as
its TL-B tag in `schema.tlb`. The set is today's, renamed, with `snapshot_log` and `draw_log` merged into
`boundary_log` (the pot is now fixed at the boundary), one `withdrawal_log` per withdrawal, and logs for the new
governor actions. Nodes write no logs.

```
booking_log#3b7e3b47 owner:MsgAddress depositor:MsgAddress position:uint32 principal:Coins tokens:Coins
    = JackpotLog;
// at burn_notification: the tickets leave, the payment, and the rate it used
withdrawal_log#9cef1f7e owner:MsgAddress position:uint32 principal:Coins tokens:Coins last:Bool moved:Bool
    quote_coins:uint128 quote_tokens:uint128 = JackpotLog;
// a deposit refused: value = deposit_value, principal = the booked_principal it would have had
refused_log#a9f1b394 owner:MsgAddress tokens:Coins value:Coins principal:Coins reason:uint8 = JackpotLog;
// a bounced deposit_booked undone
booking_undone_log#ac38ff53 position:uint32 principal:Coins tokens:Coins = JackpotLog;
// a boundary that took a snapshot: the rate, the pot before the unstake, and the prizes when a draw opened
boundary_log#cb9aaaba tag:uint32 time:uint32 quote_coins:uint128 quote_tokens:uint128 snapshot_tickets:Coins
    pot:Coins burn:Coins carried:Coins unstaked:Coins
    draw:(Maybe ^[p0:Coins p1:Coins p2:Coins drand_round:uint64 mc_seqno:uint32 mc_hash:bits256]) = JackpotLog;
// a boundary that found a draw still waiting: alarm on any
skip_log#7bf99681 tag:uint32 time:uint32 quote_coins:uint128 quote_tokens:uint128 reserved:Coins
    drand_round:uint64 mc_seqno:uint32 mc_hash:bits256 = JackpotLog;
randomness_log#a02c7ffb tag:uint32 drand_round:uint64 seed:uint256 = JackpotLog;
// result: 0 hit, 1 miss, 2 rolled over, 3 expired, 4 returned, 5 lost; owner = addr_none unless hit or returned
slot_log#9d87edd2 tag:uint32 slot:uint8 attempt:uint8 result:uint8 ticket:uint128 position:uint32 amount:Coins
    owner:MsgAddress = JackpotLog;
unstake_log#a5fc9f67 amount:Coins unstaking:Coins float:Coins = JackpotLog;
// hGRAM that left held_tokens unpaid: cause 1 = a bounce's refund could not be paid from its value
untracked_log#f4763a43 cause:uint8 tokens:Coins = JackpotLog;
// rise_min or min_gap set; next_min_gap applies at the next boundary
settings_log#1c421ecd rise_min:uint32 min_gap:uint32 next_min_gap:uint32 = JackpotLog;
retired_log#a6a4f6b3 = JackpotLog;
successor_log#5de56438 successor:MsgAddress deposit_fee:Coins = JackpotLog;
hipo_wallet_log#064510fb parent:MsgAddress wallet:MsgAddress = JackpotLog;
treasury_log#5025a5bc treasury:MsgAddress = JackpotLog;
// a foreign jetton or NFT sent back (sent = true) or held for a rescue (sent = false)
foreign_return_log#63eaf860 from:MsgAddress sender:MsgAddress amount:Coins sent:Bool = JackpotLog;
// the rest burned and the tree closed; next_position says which nodes the close goes to
swept_log#e9b4624d tokens:Coins next_position:uint32 = JackpotLog;
```

The boundary and withdrawal logs carry the rate they used, so a reader can recompute every booking, withdrawal and pot
from the logs alone.

### 12. Names

- The names above are used in the code's globals and TL-B fields, the wrappers, the getters' documented fields,
  `showState` and every script's output, `docs/architecture.md` and the README. Formula blocks keep the symbols.
- `showState` also prints untracked hGRAM (the hGRAM wallet's balance less `held_tokens`), the time since the last
  boundary, the rise still needed for the next, and after the end the nodes still standing.
- The v2 spec stays as approved; the Names table maps its symbols.

### 13. Message graphs

- **`tests/story/story.spec.ts`:** one sandbox run in chapters, from the existing scenario helpers: a first deposit; a
  second; a deposit with options for a beneficiary; a refused deposit; two deposits at once to a new wallet; a partial
  withdrawal by `burn` with a payload; a `w`; an early poke; a reward and the poke that makes a boundary; a draw with
  hits; a draw with a miss and a retry; a skip; a refill and unstake; TEP-89; a second-hop payout failure and
  `return_tokens`; retire, the last draw, `withdraw_for`, `sweep` and the tree's close; a move to a successor and a
  refused move. It records each chapter's transactions, names every address by its role, and decodes each body by op
  name from both constants files.
- **`scripts/graphs/dot.ts`:** turns a chapter into DOT, without theme. Labels carry the op and its token and principal
  amounts, rounded to 0.001. They carry nothing that moves with gas: no GRAM values, no `query_id`, no lt, no unstake
  amount.
- **Drift check:** the story builds the DOT in the test and compares it with `docs/graphs/<chapter>.dot`. `npm test` fails
  on a difference and says to run `npm run graphs`. With `UPDATE_GRAPHS=1` it writes the files and
  `docs/message-graphs.md` instead.
- **`scripts/graphs/render.ts`:** renders each `.dot` to `<chapter>-light.svg` and `<chapter>-dark.svg` with
  `@hpcc-js/wasm-graphviz`, a dev dependency, pinned.
- **`npm run graphs`** = `UPDATE_GRAPHS=1 jest tests/story && ts-node scripts/graphs/render.ts`.
- **`docs/message-graphs.md`:** per chapter a title, a few lines of text, the graph, and the counters after it under their
  names. Each graph is
  `<picture><source media="(prefers-color-scheme: dark)" srcset="graphs/x-dark.svg"><img alt="…" src="graphs/x-light.svg"></picture>`,
  which GitHub picks by theme.
- The prototype's Python is not ported; its idea is.

### Senders

- The Jackpot hears notifications and `withdrawal_notification` from its own hGRAM wallet; `take_current_quote` from the
  treasury; `deposit_ready` and `burn_notification` from the jGRAM wallet of the owner they name; `hit`, `miss`, `lost`
  as v2; governor messages from the governor; `set_halted` as v2. Anyone may send `poke`, `submit_randomness`,
  `refill`, `sweep`, `provide_wallet_address`, a `w`, a top-up, and `gas_excess`, which is ignored. A
  `transfer_notification` from any other wallet, and an `ownership_assigned` from anyone, take the foreign path. The
  nodes' balances arrive as plain GRAM.
- A wallet hears `prepare_deposit`, `deposit_booked`, `deposit_cancelled`, `close_wallet` from the Jackpot, and `burn`
  from its owner or the Jackpot.
- A node hears `update` and `descend` from its parent, as v2, and `close_node` from its parent or the Jackpot.

### Layouts

Op codes are `crc32("jackpot::<name>")`, as in v2, except the standard ones, which keep their TEP codes. Only what
changes is listed; the rest of v2's `schema.tlb` holds. The logs are under Logs.

```
// Storage. The books ref is gone; the fourth ref holds the retirement. No dictionary anywhere.
// quote_coins and quote_tokens: the stored rate; non-zero in the deploy data.
// swept: set by sweep; refuses a second sweep, and opens close_subtree and the after-end withdraw_surplus
_ retired:Bool successor:MsgAddress successor_deposit_fee:Coins swept:Bool = Retirement;
_ version:uint8 held_tokens:Coins incoming_tokens:Coins reserved_tokens:Coins principal:Coins tickets:Coins
    quote_coins:uint128 quote_tokens:uint128 query_counter:uint32 halted:Bool falling:Bool
    extra:^Extra draw:^Draw addresses:^Addresses retirement:^Retirement = JackpotStorage;
// The schedule gives way to the boundary: the boundary rate, its time, the settings, the last unstake.
// R is not stored: it is the first drand round at or after last_boundary + 60.
_ last_boundary:uint32 boundary_coins:uint128 boundary_tokens:uint128 rise_min:uint32 min_gap:uint32
    next_min_gap:uint32 last_unstake:uint32 = Boundary;
// Draw states: 0 none, 1 waiting, 2 resolving. No quoting.
// mc_hash: set at every boundary, with the snapshot and R; seed = sha256(drand_signature ‖ mc_hash) after a submit
_ state:uint2 snapshot_tickets:Coins seed:uint256 slots:uint32 misc:^DrawMisc mc_hash:bits256 = Draw;
// The 272 bits hashed for k(i,j), as v2; the seed itself is sha256 of these 640 bits:
_ signature:bits384 mc_hash:bits256 = SeedPreimage;
// Removed: Sched, QuoteKind, QuoteRecord, PayoutRecord, Claim, Books.

// Boundaries: the only quote.
poke#5444df0f query_id:uint64 = InternalMsgBody;
// custom_payload of the poke's provide_current_quote, bounceable, extra_flags = 3
quote_poke$0011 created_at:uint32 poker:MsgAddress = QuoteContext;

// Deposit options: in the hGRAM transfer's forward_payload, in a ref.
deposit_options#8785a274 min_principal:Coins beneficiary:MsgAddress response_destination:MsgAddress
    forward_ton_amount:Coins forward_payload:(Maybe ^Cell) = ForwardPayload;
// forward_payload of a refund after options
deposit_refused#a763e68f reason:uint8 forward_payload:(Maybe ^Cell) = ForwardPayload;
text_comment#00000000 text:Text = ForwardPayload;

// The deposit context: built by the Jackpot, carried by prepare_deposit and deposit_ready, never stored.
// min_principal = nothing: a default deposit.
_ owner:MsgAddress sender:MsgAddress response:MsgAddress = DepositParties;
_ query_id:uint64 tokens:Coins min_principal:(Maybe Coins) forward_ton_amount:Coins
    forward_payload:(Maybe ^Cell) parties:^DepositParties = DepositContext;

// bounceable, extra_flags = 3: a bounce returns the whole context
prepare_deposit#4ac19f29 query_id:uint64 context:^DepositContext = InternalMsgBody;
// from the wallet, bounceable, extra_flags = 3, mode 64 + 16; busy first, so an old-format bounce still holds it
deposit_ready#c8682b07 query_id:uint64 busy:Bool position:(Maybe uint32) context:^DepositContext
    = InternalMsgBody;
_ sender:MsgAddress response:MsgAddress forward_ton_amount:Coins forward_payload:(Maybe ^Cell) = BookingReply;
// bounceable, extra_flags = 3: a bounce returns the principal, the position and the response destination
deposit_booked#42e3c02d query_id:uint64 principal:Coins position:uint32 reply:^BookingReply = InternalMsgBody;
deposit_cancelled#a3d4c7cf query_id:uint64 = InternalMsgBody;
close_wallet#0cba59a9 query_id:uint64 = InternalMsgBody;

// Withdrawal: TEP-74. burn to the jGRAM wallet, from the owner or the Jackpot; amount = 0 means all.
withdraw_options#63a28f24 to_successor:Bool forward_ton_amount:Coins forward_payload:(Maybe ^Cell)
    = WithdrawOptions;
burn#595f07bc query_id:uint64 amount:(VarUInteger 16) response_destination:MsgAddress
    custom_payload:(Maybe ^WithdrawOptions) = InternalMsgBody;
// from the wallet, bounceable, extra_flags = 3: TEP-74's four fields first, then the Jackpot's
burn_notification#7bdd97de query_id:uint64 amount:(VarUInteger 16) sender:MsgAddress
    response_destination:MsgAddress last:Bool position:uint32 options:(Maybe ^WithdrawOptions)
    = InternalMsgBody;

// Closing the tree: to the top node from sweep, then from each node to its children that exist;
// from the Jackpot to any node through close_subtree. Non-bounceable.
close_node#07e3e272 query_id:uint64 next_position:uint32 = InternalMsgBody;

// TEP-89
provide_wallet_address#2c76b973 query_id:uint64 owner_address:MsgAddress include_address:Bool
    = InternalMsgBody;
take_wallet_address#d1735400 query_id:uint64 wallet_address:MsgAddress owner_address:(Maybe ^MsgAddress)
    = InternalMsgBody;

// Governor. withdraw_for: a cell of n × 256 bits (n = 1 to 3) of owner hashes, basechain implied, and at
// most one ref to the next such cell.
set_rise_min#a13346fa query_id:uint64 rise_min:uint32 = InternalMsgBody;
set_min_gap#996900dc query_id:uint64 min_gap:uint32 = InternalMsgBody;
retire#f6e41c95 query_id:uint64 = InternalMsgBody;
set_successor#efd50f41 query_id:uint64 successor:MsgAddress deposit_fee:Coins = InternalMsgBody;
withdraw_for#2742c19b query_id:uint64 to_successor:Bool owners:^Cell = InternalMsgBody;
return_tokens#842c3822 query_id:uint64 owner:MsgAddress amount:Coins in_flight:Bool = InternalMsgBody;
// credit = true: as v2, unstaking -= amount and held_tokens += amount; credit = false: unstaking -= amount only
settle_unstake#81d4ed7a query_id:uint64 amount:Coins credit:Bool = InternalMsgBody;
// only after the sweep
close_subtree#4cf9e825 query_id:uint64 level:uint8 index:uint32 = InternalMsgBody;
// set_treasury and set_hipo_wallet: halted only; basechain addr_std, no anycast; each logs
set_treasury#f0be6c1c query_id:uint64 treasury:MsgAddress = InternalMsgBody;
// a TEP-74 transfer from a jetton wallet the Jackpot owns; refused for the Jackpot's hGRAM wallet
rescue_jetton#a24305cd query_id:uint64 jetton_wallet:MsgAddress amount:Coins destination:MsgAddress
    = InternalMsgBody;
// a TEP-62 transfer of an NFT item the Jackpot owns
rescue_nft#d672136a query_id:uint64 nft:MsgAddress destination:MsgAddress = InternalMsgBody;
// anyone; must bring fee::sweep + close_cost(next_position)
sweep#ca7fef55 query_id:uint64 = InternalMsgBody;

// Foreign tokens, standard layouts: a transfer_notification from any wallet but the hGRAM wallet, or an
// ownership_assigned, is answered with TEP-74 transfer#0f8a7ea5 or TEP-62 transfer#5fcc3d14 back to the sender.

// Error codes added by the build (contracts/imports/constants.fc):
// 419 forged_bounce   reserved, unused: a body starting 0xfffffffe without the bounced flag throws 107 invalid_op
// 420 not_retired     withdraw_for, set_successor before retire
// 421 not_swept       close_subtree before the sweep
// 422 cannot_sweep    sweep before its conditions hold, or a second sweep
// 423 bad_comment     a comment other than w, W or empty
// 424 too_many_owners withdraw_for with more than max_withdraw_for owners

// Removed: prepare, ready, credit, release, close, withdraw, withdrawn, requote, claim, settle_failed_payout,
// set_period.

// The bounce the Jackpot and the wallet read: the network's, for a message sent with extra_flags = 3.
// Read only when the incoming message's bounced flag is set; a body starting 0xfffffffe without the flag throws.
// The op and fields are read from original_body. The old format (0xffffffff) is ignored, except by the wallet
// for burn_notification (amount from the first 220 bits) and deposit_ready (busy from the first 97 bits).
new_bounce_body#fffffffe original_body:^Cell original_info:^NewBounceOriginalInfo bounced_by_phase:uint8
    exit_code:int32 compute_phase:(Maybe NewBounceComputePhaseInfo) = InternalMsgBody;
```

The wallet's and the node's storage are unchanged. The getters lose `get_books`, `get_claimable` and `get_schedule`,
gain `get_boundary()` returning `(last_boundary, boundary_coins, boundary_tokens, rise_min, min_gap, next_min_gap,
earliest_next_boundary, drand_round)` and `get_retirement()` returning `(retired, successor, successor_deposit_fee)`;
`get_draw_state` drops the next boundary; `get_jackpot_fees` follows the new fee list. Getters read storage as it is:
with no tick there is nothing to apply in memory. The storage version stays 1, since no v2 layout was ever deployed.

### Rejected alternatives

- **A clock, as v2:** its boundaries fell wherever the schedule put them, so the stored rate could miss a reward, the
  pot was fixed only after the seed was public, and a quote at the draw was needed to fix it.
- **Any rise of the rate as a boundary, with no threshold:** a gift of a few nano-GRAM, or rounding, would let anyone
  place boundaries at will before a reward.
- **A live quote for each withdrawal:** while a quote was stuck, `principal` counted principal that had left, and the
  entry price undercharged newcomers; it also needed the governor's resend, which could pay twice. Not needed once the
  pot is fixed at the boundary.
- **A quote on every deposit, as v2:** the treasury in the deposit chain, for nothing: with a pot the rate cancels, and
  without one an old rate costs only the depositor.
- **Adding the yield after a waiting draw's boundary to its pot at a skip:** deposits made since would pay for a pot
  they cannot win.
- **A new snapshot at a skip:** the waiting draw's searches need its snapshot in the tree.
- **A separate feature for longer draws:** `min_gap` already sets the rhythm.
- **A seal transaction after the boundary, before `R` is published,** taking a later block hash into the seed: it would
  close the colluding-quorum race, but it needs one more keeper step in a window of under 60 s, and every missed seal
  would add a skip.
- **A reward for a poke:** Hipo runs the keepers anyway, a poke is cheap, and a paid poke would give a reason to race
  and to place boundaries; the float already pays a boundary's real gas.
- **A governor `close_tree` instead of closing in `sweep`:** the same conditions, one more message, and the end would
  wait on the governor.
- **`sweep` only in state none:** a waiting draw with no tickets left can only miss, and with no keeper it could block
  the end for ever.
- **A node that stores which children exist:** `next_position` already says, so the message carries it.
- **Paying moves to any destination the owner names:** most contracts refund to the transfer's sender, which would be the
  Jackpot, and the hGRAM would end up untracked. Only a successor that books for a beneficiary works.
- **Refunding a refused deposit to the beneficiary:** a contract that deposits for someone could not catch its own
  refusal. The response destination serves both.
- **Bounceable payouts with full-body bounces:** see Payouts.
- **Accepting old-format bounces in the Jackpot as well:** none can answer a message it sends, and its code can be
  upgraded if that changes. The wallet, which cannot be upgraded, keeps the old path for its two bounceable messages.
- **Reserving a position before the booking:** anyone could use up positions with deposits that are then refused.
- **Sending `deposit_booked` as a TEP-74 `internal_transfer`:** the wallet also needs the position, and extra fields after
  `forward_payload` break strict parsers. Hipo mints with its own op too.
- **A custom `withdraw` message, as v2:** TEP-74 `burn` carries the amount, the response destination and the query id in
  standard fields that wallets and explorers already know.

## Changes

All in `HipoFinance/jackpot`, unless noted:

- `contracts/jackpot.fc`: no clock and no tick; `poke`, the only quote; the boundary rule in the poke's reply, with the
  snapshot, the pot, the unstake (only if the float can pay it), the skip and the rollover there, its real gas paid by
  the float; `submit_randomness` with no quote and the `min_gap` cut-off; `set_rise_min`, `set_min_gap` (applied at the
  next boundary), `clear_falling` resetting the boundary rate; deposits at the stored rate with the normal price always;
  withdrawals paid at `burn_notification` at the stored rate; no books; `extra_flags = 3` on every bounceable message and
  bounce handlers that read the full body and recover by themselves, entered only on the bounced flag;
  `deposit_cancelled` after an undone booking; `fee::deposit` sized for the bounce value floor; unconfirmed payouts with
  forward fields; payouts short of value drop their forward fields; refusals with reasons; `w`; TEP-89; `retire`,
  `set_successor`, `withdraw_for`, `sweep` (ending a waiting draw, then closing the tree with `close_cost` computed on
  chain, refused with less, and setting `swept`), `close_subtree` with its own funding; `return_tokens` with
  `in_flight`; foreign jettons and NFTs sent back on their own value, `rescue_jetton` (refusing the hGRAM wallet),
  `rescue_nft`; `set_treasury` and logs for it and `set_hipo_wallet`; deploy refusing a zero stored or boundary rate;
  an empty comment as a top-up; error codes 419–424 (419 reserved, unused); moves; logs in the new form; renamed globals and messages.
- `contracts/wallet.fc`: `deposit_ready` with `busy` and the context, bounceable; `deposit_booked` with the TEP-74
  notification and the excess to the response destination; TEP-74 `burn` from the owner or the Jackpot, with
  `withdraw_options` and the payload cap, and `burn_notification`; bounce handlers for the full body and, for
  `burn_notification` and `deposit_ready`, the old one; bounces recognised by the bounced flag only; renamed messages.
- `contracts/node.fc`: `close_node` from the parent or the Jackpot: the sender check first, the zero check, the check that
  the value covers its own term and its children's `subtree_cost`, unscaled (else nothing, keeping the value), the rest
  of its value split among existing children in proportion to their `subtree_cost` from `next_position`, priced with
  `GETGASFEE` and `GETFORWARDFEE`, in mode 0 so the value includes its forwarding, sends that do not ignore errors, and
  the delete to the Jackpot with modes 128 + 32. No `accept_message`. Nothing else changes.
- `contracts/imports/drand.fc`: unchanged, except that `R` comes from `last_boundary + D` and the seed is
  `sha256(signature ‖ mc_hash)`, with `mc_hash` read from `PREVMCBLOCKS` at the boundary.
- `contracts/imports/constants.fc`: op codes, log ops, reasons; payout kinds, quote kinds and the period bounds removed;
  `rise_min` and `min_gap` bounds; new fees, `fee::poke`, `fee::boundary_max`, the close's gas bounds `gas_1` and
  `gas_inner` (re-measured on the new node code, at least 1.5 times headroom) and margin (at least 1.5), `fee::foreign_return`, `fee::prize_notify`,
  and `fee::boundary_max` and `3 · fee::prize_notify` in `fee::draw_budget`; `fee::submit`, `fee::deposit` and
  `fee::withdraw` without a quote; `max_payload_cells`, `max_withdraw_for` = 100. `contracts/imports/utils.fc`:
  `send_msg` with `extra_flags`, the full-body bounce parser, `emit_log` to `addr_none` with the op first, comment
  builders, the payload count.
- `contracts/schema.tlb`: as Layouts and Logs.
- `abi/jackpot.xml`: the Jackpot's and the wallet's messages, get-methods and `<ext_out>` logs in tongo's ABI form, for
  explorers.
- `wrappers/Jackpot.ts`, `wrappers/Wallet.ts`, `wrappers/Node.ts`: new messages, getters, log parser, names.
- `tests/`: drop the clock, period, claim, `requote`, `settle_failed_payout` and quote-on-deposit and quote-on-withdrawal
  tests; add tests for each criterion below; a sandbox treasury stub that throws, for poke bounces; a helper that raises
  the sandbox treasury's rate as a reward, a loan's part of one, or a gift does; the sandbox's global version and config
  8 set as mainnet; `tests/story/story.spec.ts`.
- `scripts/`: remove `settleFailedPayout.ts` and `setPeriod.ts`; add `poke.ts`, `setRiseMin.ts`, `setMinGap.ts`,
  `retire.ts`, `setSuccessor.ts` (with the fee check under Migration), `withdrawFor.ts`, `sweep.ts` (reads
  `close_cost` from a getter and sends it), `closeSubtree.ts` (lists the nodes still standing), `setTreasury.ts`,
  `rescueJetton.ts`, `rescueNft.ts`; `deployJackpot.ts` reads the first rate on chain, checks the settings and that no
  well-known jetton uses the symbol `jGRAM`, writes the TEP-64 content, and suggests a poke right after;
  `returnTokens.ts` gains `in_flight`; `showState.ts` and `lib/` use the names and print untracked hGRAM, the boundary
  and the retirement.
- `scripts/graphs/dot.ts`, `scripts/graphs/render.ts`; `package.json`: the `graphs` script and
  `@hpcc-js/wasm-graphviz`.
- `docs/graphs/`, `docs/message-graphs.md`: generated.
- `README.md`, `CHANGELOG.md`, `docs/architecture.md`: the names, boundaries, the flows above, the end, the tree's close
  and migration.
- The keepers: poke shortly after each reward, as well as submit. A separate change.
- The team's monitoring: an alarm when there has been no boundary for 1.5 times the expected rhythm, and on any
  `skip_log`. A separate change.
- `HipoFinance/contract`, `scripts/upgrade_treasury.md`: the Jackpot row adds that `provide_current_quote` must answer only
  the sender and echo `custom_payload` unchanged, that the rate must never fall, and that `send_tokens` keeps honouring
  `return_excess` and the notification rules. A separate change in that repo.

## Acceptance criteria

The v2 criteria hold except those listed as removed at the top.

**Boundaries and the draw**

- [x] **The rule.** In the sandbox, a poke's reply is a boundary exactly when the rate has risen by `rise_min` over the
      boundary rate, `min_gap` has passed since the last boundary, and neither the falling flag nor `halted` is set. A
      rise one part per million short, a reply one second early, a falling reply and a halted Jackpot each give no
      boundary, and the reply still stores its rate.
      <!-- evidence: Verification "The rule, at the threshold" (49 ppm: no boundary; exactly 50 ppm: boundary; halted: rate stored, no boundary); Boundaries "First boundary…" (the reply one second early); Attacks "falling rate…" -->
- [x] **Pokes.** A thousand pokes with no qualifying rise change nothing but the stored rate; each costs only its
      sender's gas, and the Jackpot's balance does not fall.
      <!-- evidence: Verification "Pokes" (1,000 pokes: only the stored rate, the Jackpot’s balance never falls after the first poke, which pays the storage rent of the time jump) -->
- [x] **No hidden reward.** A poke whose reply is a boundary returns its poker the same GRAM, within 0.002 GRAM, as one
      whose reply is not. The float falls by the boundary's measured gas, plus `fee::unstake` when it unstakes, and never
      by more than `fee::boundary_max` plus `fee::unstake`.
      <!-- evidence: Gas.spec "No hidden reward…" and "fee::boundary_max (gas units) covers the worst measured boundary…" -->
- [x] **Low float.** At a boundary with the float below `fee::unstake`, `u` is 0, the pot is set aside whole, and nothing
      throws.
      <!-- evidence: Boundaries "Low float…" -->
- [x] **Placing a boundary gains nothing.** A `gift_coins` of `rise_min` × Hipo's coins after `min_gap` makes the next
      poke a boundary; so does a poke between two loans' parts of one round's reward. Over many seeds, every player's
      mean result, the gifter's or the poker's included, is the same with and without the placed boundary, within
      sampling error, apart from the gift itself.
      <!-- evidence: Verification "Placing a boundary gains nothing" (every player’s share of the pots equal in exact fractions with and without the placed boundary; the sampled mean of the placed draw at PLACED_SEEDS, 6 by default, a long run raises it) -->
- [x] **The pot is fixed before the seed.** At a boundary, `reserved_tokens` rises by the pot computed at the reply's
      rate, the `boundary_log` records that rate and pot, and `R` is the first round at or after the boundary time + 60.
      No message after it, a deposit, a withdrawal or a poke, changes the reserved pot, the prizes or the snapshot.
      <!-- evidence: Boundaries "The pot is fixed before the seed; exact snapshot"; Rules2 "one that books and leaves after the boundary changes nothing in the draw" -->
- [x] **Exact snapshot.** A deposit booked in the transaction before the boundary reply can win that draw; one booked
      in the transaction after cannot.
      <!-- evidence: Flows "a deposit booked before a boundary is in that draw, one booked after it is not" -->
- [x] **The seed mixes in `mc_hash`.** The boundary stores the root hash of the `PREVMCBLOCKS` entry with the highest
      seqno and logs both; with entries given in any order in the sandbox, the logged seqno is the highest one present.
      With the same drand signature and two different `mc_hash` values, the seed and every `k(i,j)` differ, and the
      seed equals `sha256(signature ‖ mc_hash)` to the bit. A skip stores a fresh `mc_hash` with its new `R`.
      <!-- evidence: Boundaries "The seed mixes in mc_hash…" and "Skip…" -->
- [x] **Winners recomputed.** In the property run, each winner equals the owner of the `k(i,j)`-th ticket of the
      snapshot, recomputed off chain from the logs alone: the drand signature and the `mc_hash` the boundary logged.
      <!-- evidence: Property.spec (checkDraw in tests/jackpot/sequences.ts); 6 sequences in the last full run -->
- [x] **The seed-informed exit is closed.** With the seed public, a player who burns after seeing that they lost gives
      up only their own chance: in the two-player example (500,000 GRAM each), the honest player's expected gain per
      draw over many seeds is the same, within sampling error, whether or not the other burns after a losing seed.
      <!-- evidence: Acceptance "The seed-informed exit is closed" (scaled to 500 GRAM each, 12 seeds, the honest player's prizes identical seed by seed) -->
- [ ] **Deposits always pay the normal price.** A deposit while a draw waits pays the normal formula, wins nothing in the
      waiting draw, joins the next snapshot, and over at least 1,000 seeds its mean prize minus its price is at most 0
      within sampling error, as v2's sniper test, at `v` of 0.01, 1, 100 and 10,000 times `P`.
      <!-- not ticked: ran at 10 seeds (SNIPER_SEEDS=10), not 1,000; the exact-arithmetic part and the formula are checked (Acceptance "Deposits always pay the normal price", "A deposit while a draw waits…") -->
- [ ] **No undercharge after a withdrawal.** In the audit's example (W 900,000, H 100,000; W withdraws all; D deposits
      100,000), D books 99,691 to within rounding, and H's mean prize over many seeds is 279.0 GRAM within sampling
      error.
      <!-- not ticked: ran at 30 seeds (HAL_SEEDS=30), scaled by 1/1000, not many seeds at full size (Acceptance "No undercharge after a withdrawal") -->
- [x] **Timing.** A test for each row of the timing table, with the reward landing before or after the poke, shows the
      expected value given there, within sampling error; leaving after the reward and before the poke equals leaving
      just before it, in exact fractions.
      <!-- evidence: Timing.spec, one test for each of the six rows -->
- [x] **Skip.** With a draw waiting at the next boundary: its snapshot, tag and reserved pot are unchanged, `R` moves to
      the new boundary's round, the yield since its own boundary stays in `free_tokens`, and a deposit booked meanwhile
      wins nothing in that draw but shares the pot fixed at the first boundary after it ends. Nothing is lost, `carried`
      is unchanged, and each pot is burned once.
      <!-- evidence: Boundaries "Skip…"; Flows "a skip keeps the draw, and the next boundary after it pays the pot…"; Acceptance "Outage" -->
- [x] **Outage.** drand silent across two boundaries, with deposits and withdrawals meanwhile: all pay; on return the
      waiting draw pays its reserved pot; the next boundary pays the rest to a snapshot that holds the new deposits; a
      round from before the latest boundary is refused.
      <!-- evidence: Acceptance "Outage" -->
- [ ] **Cut-off.** A submit at `last_boundary + min_gap − S` throws with no state change, and one a second earlier
      succeeds. A draw submitted at the last allowed second finishes all its searches before the earliest next boundary.
      A boundary with a slot still open (a node made stuck by hand) rolls it over, and a `hit` delivered after it pays
      nothing.
      <!-- not verifiable here: a draw's searches finishing before the next boundary cannot be shown in the sandbox, which has no message latency; the cut-off, the rollover of an open slot and the late hit are covered (Boundaries "Cut-off…"; Flows "a slot that is still searching at the next boundary rolls over"; Acceptance "Boundary mid-search") -->
- [x] **Submit.** Junk throws and changes nothing; a second submitter fails at the state check; the first is paid
      `submit_reward` once; the submit sends no quote.
      <!-- evidence: Boundaries "Submit…"; Flows "a boundary sends nothing but the quote chain…" -->
- [x] **Settings.** `set_rise_min` and `set_min_gap` refuse values out of bounds and anyone but the governor, at deploy
      too. A new `min_gap` set while a draw resolves does not move its earliest next boundary: the boundary that applies
      it checks its own rule with the old value. `clear_falling` resets the boundary rate.
      <!-- evidence: Boundaries "Settings…", "clear_falling resets the boundary rate"; Attacks "governor setters and deploy checks…" -->
- [x] **Rhythm.** With `min_gap` at 2.5 rounds, 30 rounds of rewards and pokes give exactly 10 boundaries, one every
      third round.
      <!-- evidence: Boundaries "Rhythm…" -->
- [ ] **Hands-free.** 50 rounds run with `poke` after each reward and `submit_randomness` as the only messages besides
      the treasury's replies and the reward steps: one boundary and three prizes each, nothing else sent by anyone.
      <!-- not ticked: ran 8 rounds (Soak, HANDS_FREE_ROUNDS=8) and 12 (Boundaries "Hands-free…"), not 50 -->
- [x] **First boundary.** After deploy, no reply is a boundary before `min_gap`, and the first reward after it makes one.
      A deploy with a zero stored rate, a zero boundary rate, or settings out of bounds is refused.
      <!-- evidence: Boundaries "First boundary…" (the zero boundary rate is covered through the zero stored rate: the deploy data sets both from one quote) -->

**No records**

- [ ] **Fixed storage.** In a sandbox run of at least 1,000 mixed flows (every message kind in this document), after every
      transaction the Jackpot's data has the same number of cells as at deploy, `content` aside, and no more bits than
      with every `Coins` field at full width. `schema.tlb` has no `HashmapE` in the Jackpot's storage.
      <!-- not ticked: the full-width bits bound is now asserted after every chain (tests/jackpot/sequences.ts: the non-Coins bits are constant, 16 Coins fields, never above full width) with the cell count and the schema check (Environment "Fixed storage…"); still about 100 flows (6 property sequences), not 1,000 -->
- [x] **Property, extended.** v2's property run, with rewards in parts, gifts, pokes, boundaries and skips in place of
      the clock, also checks after every transaction that `tickets = principal`, that untracked hGRAM (wallet balance −
      `held_tokens`) is at least 0 and equals the sum of the failures the run injected, and that the treasury receives
      `provide_current_quote` only after a `poke`.
      <!-- evidence: Property.spec (tests/jackpot/sequences.ts) -->
- [x] **Sandbox version.** The sandbox emulator runs global version 12 or later, with its config 8 set to match mainnet
      (version 16 when read on 2026-11-03), and a message sent with `extra_flags = 3` bounces as `new_bounce_body`. If the
      emulator does not support it, the build stops and reports; no test is weakened to pass.
      <!-- evidence: Environment "Sandbox version…" -->
- [x] **`PREVMCBLOCKS` works**, first build: in the sandbox at the configured global version, the boundary reads a
      non-zero root hash from `PREVMCBLOCKS`, and the sandbox can set it per transaction for the tests above. If not, the
      build stops and reports.
      <!-- evidence: Environment "PREVMCBLOCKS works…" -->
- [ ] **Jetton metadata.** `get_jetton_data`'s content reads name "Hipo Jackpot GRAM", symbol `jGRAM`, 9 decimals and
      the description above; `deployJackpot.ts` stops when a well-known jetton already uses the symbol.
      <!-- not verifiable here: name, symbol, decimals and description are tested (Composable "Jetton metadata…"); the `deployJackpot.ts` symbol check needs an indexer and is not run in the sandbox -->
- [ ] **Failures.** Each row of the Failures table runs in the sandbox and ends as the table says. Every row marked
      "itself" finishes with no message from the governor. After the stated recovery, the owner holds what they would
      have held without the failure, within 1 nano-hGRAM per step, and the invariants hold throughout. Poke bounces use a
      treasury stub that throws; frozen wallets, frozen nodes and frozen hGRAM wallets are set by hand.
      <!-- not ticked: one test per producible row in Verification "Failures, row by row" (poke bounce, no reply, prepare_deposit bounce, deposit_ready fails, deposit_booked bounces, burn_notification fails, refund unpaid, `w` to a frozen wallet, unstake_tokens bounce, deposit_cancelled/close_wallet/take_wallet_address bounce), Retire "Stragglers…" (close_node), Foreign (tokens); not produced in the sandbox: the undo whose refund send fails, prepare_deposit with a frozen wallet’s debt and no bounce, a payout’s first and second hop failing, a refund or burn to the burner failing, a payout after the Hipo migration, hGRAM left in an old wallet -->
- [x] **Bounce formats.** Every bounceable message the Jackpot and the wallet send carries `extra_flags = 3`. Their
      handlers act on a `0xfffffffe` bounce. The Jackpot ignores a `0xffffffff` one, keeping its value. The wallet
      restores the amount from an old-format bounce of `burn_notification` exactly as from a new one, lowers `pending`
      on an old-format bounce of a non-busy `deposit_ready`, and ignores any other.
      <!-- evidence: Verification "Bounce formats" (every bounceable message of a flow with prepare_deposit, deposit_booked, deposit_cancelled, provide_current_quote, unstake_tokens, take_wallet_address, burn_notification, close_wallet, burn, and the foreign, jetton and NFT transfers: ihr field 3); Attacks "bounce formats…"; Rules "a bounced burn_notification…" -->
- [x] **Forged bounce.** An ordinary message, without the bounced flag, whose body is a `new_bounce_body` wrapping a
      made-up `prepare_deposit` (or `deposit_booked`, or `burn_notification` to a wallet) throws: no refund, no change of
      any counter or balance, and its GRAM goes back to the sender.
      <!-- evidence: Attacks "forged bounce…" -->
- [x] **Bounced `deposit_booked`.** After the undo, the wallet gets `deposit_cancelled` and its `pending` returns to what
      it was before the deposit; a new wallet is not left opening and can take the next deposit. The refund is
      `paid_tokens` for `booked_principal` at the stored rate when the bounce arrives, and the entry price, and any rise
      since the booking, stay in `free_tokens`.
      <!-- evidence: Verification "Bounced deposit_booked" (a held deposit_booked bounced by hand: deposit_cancelled to the wallet, pending 0, a new wallet not left opening, the next deposit books); Races "a bounced deposit_booked, made by hand…" -->
- [x] **Bounce value.** `prepare_deposit` and `deposit_booked` each carry at least `fee::bounce_floor` (update + cancel +
      refund + two handlers + forwarding); a test forces each to bounce at the minimum deposit fee, and a hand-made bounce of
      `deposit_booked` carrying exactly the floor at 400 nano-GRAM per gas, with an 8-cell, 1,023-bit payload, is undone.
      <!-- evidence: Races "Bounce value…" (exactly the floor, 400 nano-GRAM per gas, 8 cells of 1,023 bits) and the frozen-wallet tests at the minimum deposit fee -->
- [x] **Forged messages.** `take_current_quote` from any address but the treasury, `deposit_ready` and
      `burn_notification` from any address but the wallet they name, `close_node` from anyone but the node's parent or
      the Jackpot, and `gas_excess` from anyone change no state and send nothing. A thousand tiny `close_node` messages
      from a stranger to a live node leave the node's balance where it was: each ends at the sender check, and a node
      never calls `accept_message` for a close.
      <!-- evidence: Rules "a forged hit, miss and lost…", "update and descend from a stranger…", "a quote from a stranger…", "a deposit_ready from the wrong sender…"; Attacks "forged messages…", "a thousand-fold tiny close_node…"; Retire "A close_node from anyone but the node's parent…" -->
- [x] **A poke's quote bounce** refunds the poker and changes nothing else.
      <!-- evidence: Attacks "a poke's quote bounce refunds the poker and changes nothing else" -->

**The rate**

- [x] **Chains.** A deposit's chain is, message for message, the transfer, its notification, `prepare_deposit`,
      `deposit_ready`, `deposit_booked`; a withdrawal's is `burn`, `burn_notification`, the payout. Neither sends a quote.
      <!-- evidence: Verification "Chains" (the deposit, burn and `w` chains asserted message by message: op, sender, receiver, order; no quote) -->
- [x] **A poke's reply stores its rate**; a reply at a lower rate than the stored one raises the falling flag.
      <!-- evidence: Attacks "falling rate…"; Rules "a quote from a stranger is ignored…" -->
- [x] **The rate cancels with a pot.** With a stored pot above 0 at both rates, `booked_principal` changes by at most
      `2 + booked_principal / free_tokens` nano-GRAM, rounded up, when the stored rate is set anywhere from half to twice
      the true one; and over many seeds the deposit's expected prize minus its price is the same at every stored rate,
      within sampling error. The rounding term grows with the deposit's share of `free_tokens`, and a deposit that large
      owns most of the pot it pays into, so it gains nothing from it.
      <!-- evidence: Verification "The rate cancels (exact fractions)" (bigint, scaled 10^30: booked_principal within 2 + booked/free, the gain equal to that rounding); Acceptance "The rate cancels with a pot". The expected value is shown in exact fractions, not sampled over seeds -->
- [x] **An old rate only costs the depositor.** With the stored pot at 0 and the stored rate below Hipo's, a deposit
      books `deposit_value` at the stored rate, and the difference stays in `free_tokens`.
      <!-- evidence: Acceptance "An old rate only costs the depositor" -->
- [x] **A fall not yet seen** (set by hand in the sandbox treasury): a withdrawal pays at most its pro-rata share; the
      next poke raises the falling flag; after it, bookings are refused with `rate_falling` and withdrawals pay pro rata.
      <!-- evidence: Acceptance "A fall not yet seen"; Attacks "falling rate…" -->
- [x] **Refill at a stale rate**, after a fall set by hand, unstakes at most `float_high` worth of hGRAM, as the accepted
      limit says; with the falling flag up it unstakes nothing.
      <!-- evidence: Acceptance "Refill at a stale rate"; Soak "refill throws at float >= fee::draw_budget, and unstakes nothing while the flag is up" -->
- [x] **`settle_unstake`.** With `credit = true` it lowers `unstaking_tokens` and raises `held_tokens` by `amount`; with
      `credit = false` it lowers `unstaking_tokens` only; both refuse `amount > unstaking_tokens` and anyone but the
      governor. A stuck `unstaking_tokens` cleared with `credit = false` lets `sweep` run.
      <!-- evidence: Retire "sweep requires unstaking_tokens = 0; settle_unstake with credit = false clears a stuck count and lets it run" -->

**Closing the tree**

- [x] **The cascade, on `sweep`'s funding.** With every node's balance set to exactly its storage reserve, no spare,
      `sweep` with 5,000 positions ever assigned deletes every node over positions below `next_position`; no other
      address receives `close_node`; no node's reserve pays any gas; and the Jackpot gets back everything the sweep sent
      for the close and every reserve, less only the cascade's real gas and forwarding.
      <!-- evidence: Retire "The cascade, on sweep's funding" at n = 65, 4097 and 5000 -->
- [x] **Refusals.** `sweep` is refused while retired is false, `principal > 0`, `incoming_tokens > 0`,
      `unstaking_tokens > 0`, a draw resolves, or it was already swept, and when it brings even 1 nano-GRAM less than
      `fee::sweep + close_cost(next_position)`. A sweep that brings more returns exactly the excess to its sender, and
      the float is the same before and after, apart from the burn payout's own fee. A node with any non-zero child sum,
      set by hand, refuses `close_node`, keeps its subtree, and the rest of the tree still closes.
      <!-- evidence: Retire "Refusals…" twice, "A sweep that brings less than…", "End to end" (422); Verification "The end of the tree" (a sweep with 1 GRAM more costs the sender exactly the same; a node with a non-zero sum refuses and the rest of the tree closes) -->
- [x] **No players.** `retire` and `sweep` with `next_position = 0`: `close_cost(0) = 0`, no `close_node` is sent, and no
      GRAM is left at the undeployed top node's address. `close_subtree` refuses any node whose first position is at or
      past `next_position`.
      <!-- evidence: Retire "No players…" and "Stragglers…" (`close_subtree` past `next_position`) -->
- [x] **`swept`.** After a sweep, `swept` is set; a second `sweep` is refused with 422; `close_subtree` works only after
      it (421 before); `withdraw_surplus` then leaves 1 GRAM.
      <!-- evidence: Retire "End to end…" (422), "Stragglers…" (421); Verification "swept: after the sweep, withdraw_surplus leaves exactly 1 GRAM" -->
- [x] **Waiting draw at the end.** `sweep` in state waiting with `tickets = 0` ends the draw, puts its prizes back, burns
      everything and closes the tree, with no search sent.
      <!-- evidence: Retire "Waiting draw at the end…" -->
- [x] **Order.** An `update` sent just before the sweep reaches every node on its path before `close_node`.
      <!-- evidence: Verification "Order" (a burn and a sweep in one queue: at each of the four nodes the update’s lt is below the close’s and every node is gone) -->
- [x] **Gas bounds.** On the new node code, a level-1 close and a 64-child close each use at most `gas_1` and `gas_inner`,
      with at least 1.5 times headroom: measured gas × 1.5 ≤ the constant. The constants fit 65 actions and the 1,000,000
      gas limit. `GETFORWARDFEE` is called with counts at least the real `close_node`'s.
      <!-- evidence: Retire "Gas bounds…" -->
- [x] **Split.** Each node keeps `term − fwd` and gives each existing child its share of the rest in proportion to
      `subtree_cost(child)`, to the nano-GRAM, forwarding fee included, so each child gets at least its cost times the
      margin. `close_cost(n)` equals the top node's `subtree_cost` times the margin, priced at the sandbox's `GETGASFEE`
      and `GETFORWARDFEE`. With node reserves at 0 spare, the whole tree closes, no node's reserve pays any gas, and no
      node is left behind at `n` = 65, 4,097 and 5,000, the partly filled last subtrees included; the same holds with
      every node's real gas raised 10% over its measure.
      <!-- evidence: Retire "Split…" twice; Verification "Split, to the nano-GRAM" (shares recomputed from the config’s gas (21) and forwarding (25) prices at n = 65, 4,097 and 5,000: each arrives as computed less one constant forwarding; close_cost equals the top cost times the margin) -->
- [x] **Stragglers.** A frozen node, and a node whose value was made too small by hand, stay with their subtrees: the
      short node does nothing and keeps the value, sends nothing and is not deleted, so no child is left under a missing
      parent. `close_subtree` with `subtree_cost` times the margin then closes them, a level-2 node's leaves included; it
      is refused with less, and before the sweep. `scripts/closeSubtree.ts` offers only the highest nodes still
      standing.
      <!-- evidence: Retire "Stragglers…", "closeSubtree offers only the highest nodes still standing", "a frozen node counts as standing…" -->

**Composable**

- [x] **Deposit with options**, sent by a contract for a beneficiary: the beneficiary receives, from their jGRAM wallet, a
      `transfer_notification` with the caller's `query_id`, `amount = booked_principal`, `sender` = the depositor, the
      payload bit for bit, and the asked value. The response destination receives `gas_excess` with the same `query_id`.
      <!-- evidence: Composable "Deposit with options…" -->
- [x] **Refusals.** For each reason code, the response destination receives `deposit_tokens` whole, with the caller's
      `query_id` and `deposit_refused(reason, payload)`, or for a default deposit 1 nano-GRAM and the reason's comment.
      `principal`, `tickets` and `incoming_tokens` end as before the deposit.
      <!-- evidence: Composable "Refusals…" (all reasons but two); Races "Two deposits, new wallet" for `wallet_busy`; Rules "capacity…" for `tree_full` -->
- [x] **Two deposits at once to a new wallet:** the second is refused with `wallet_busy` and refunded, and no message
      bounces.
      <!-- evidence: Races "Two deposits, new wallet…" -->
- [x] **Withdrawal by `burn`.** A standard `burn` with no `custom_payload` pays the owner. With `withdraw_options`, the
      owner's hGRAM wallet sends a `transfer_notification` with the caller's `query_id`, `paid_tokens`, `sender` = the
      Jackpot and the payload bit for bit, and `gas_excess` with the rest to the burn's `response_destination`. No
      message reaches the Jackpot after its `send_tokens`. A payout short of value for its forward fields goes without
      them. A `burn` from anyone but the owner and the Jackpot throws.
      <!-- evidence: Composable "Withdrawal by burn…" twice; Attacks "a burn is paid in the step that receives it…" -->
- [x] **Prizes.** Each winner's hGRAM wallet sends a `transfer_notification` of exactly `fee::prize_notify` (0.01 GRAM)
      with the comment `Hipo Jackpot prize: draw <tag>, <place>`. A test contract as winner parses it within that gas.
      `fee::draw_budget` includes `3 · fee::prize_notify` and `fee::boundary_max`, and the griefing-bound test still
      holds.
      <!-- evidence: Composable "Prizes…"; Rules2 "The griefing bound"; Gas "fee::draw_budget includes…" -->
- [x] **TEP-89.** `take_wallet_address` equals `get_wallet_address` for a basechain owner, is `addr_none` for a
      masterchain one, and includes the owner only when asked.
      <!-- evidence: Composable "TEP-89…" -->
- [x] **Payload cap.** An inner payload of 8 cells passes; 9 are refused with `bad_options` on a deposit and throw at the
      wallet on a `burn`. At the cap, the Jackpot's balance does not fall in any user chain.
      <!-- evidence: Composable "Payload cap…", "F7…" -->
- [x] **Same `query_id`.** Two deposits and two withdrawals in flight with one `query_id` all complete correctly.
      <!-- evidence: Hardening "Fix 1: one query_id, many messages" (four tests) -->

**Foreign tokens and Hipo upgrades**

- [x] **A return.** A foreign jetton sent with `fee::foreign_return` comes back to its `sender` in full, with the
      comment, `response_destination` = the sender. The Jackpot's balance after the transaction equals its balance before
      the message, to the nano-GRAM, its log's fee included, and every counter is unchanged.
      <!-- evidence: Foreign "A return…" -->
- [x] **A fake.** A `transfer_notification` from a contract that is no jetton wallet gets only a message paid by its own
      value; the Jackpot's balance equals its balance before the message, and every counter is unchanged.
      <!-- evidence: Foreign "A fake…", "A fake wallet looping…" -->
- [x] **A short value.** A foreign jetton sent with less than `fee::foreign_return` stays with the Jackpot; the log is
      written only when the value covers its fee; the Jackpot's balance does not fall. `rescue_jetton` from the governor
      then sends it on; from anyone else it is refused.
      <!-- evidence: Foreign "A short value…" -->
- [x] **A bounced return.** A return refused by the foreign wallet changes no state, and the token is recovered with
      `rescue_jetton`.
      <!-- evidence: Foreign "A bounced return…" -->
- [x] **The hGRAM wallet is refused.** `rescue_jetton` naming the Jackpot's current hGRAM wallet throws, matched by
      parsed workchain and hash, and so does any address that is not a basechain `addr_std`; an old hGRAM wallet can be
      named.
      <!-- evidence: Foreign "The hGRAM wallet is refused…" -->
- [x] **NFTs.** An NFT sent with `fee::foreign_return` goes back to `prev_owner`; one sent with less, with an
      `addr_none` `prev_owner`, or with the Jackpot as `prev_owner`, is held, and `rescue_nft` sends it on.
      <!-- evidence: Foreign "NFTs…" -->
- [ ] **Hipo upgrades.** `set_hipo_wallet` and `set_treasury` are refused while not halted and for any address that is
      not a basechain `addr_std` without anycast. After both, for a `k = 1` change, deposits arrive through the new
      wallet, withdrawals pay from it, pokes ask the new treasury, each setter writes its log, and a notification from
      the old wallet is sent back as foreign. A sandbox Hipo migration upgrade with `k ≠ 1` repoints the wallet, sets the
      treasury, rescales the stored and boundary rates and starts the balance move in one transaction; a burn and a poke
      right after it are priced at the new rate, and every player's share of the pot is the same as before it. A payout
      sent before the move lands fails, and `return_tokens` from the new wallet recovers it in full. No jGRAM wallet or
      node data or code refers to any Hipo address or code.
      <!-- not ticked: the setters, their logs, the repoint and the foreign return of the old wallet are tested (Foreign "set_hipo_wallet and set_treasury…"); the `k ≠ 1` migration upgrade is not built (`migrate` belongs to a future upgrade), so that part and "no jGRAM wallet or node refers to a Hipo address" are not tested -->
- [ ] **Nothing in flight at a migration.** A `k ≠ 1` Hipo migration upgrade with a deposit in flight (`incoming_tokens > 0`, a
      `prepare_deposit` held by a frozen wallet) or an unstake out (`unstaking_tokens > 0`) is refused and changes
      nothing; after `return_tokens(…, true)` and `settle_unstake` clear them, it succeeds.
      <!-- not ticked: `migrate` is not built; nothing to test -->

**Comments**

- [x] `w` and `W` withdraw everything; the payout carries `Hipo Jackpot withdrawal`; the wallet closes. A `w` from an
      address with no wallet returns its GRAM less fees and leaves no account. A `w` below the fee, and any other
      comment, throw with 423; an empty comment is taken as a top-up.
      <!-- evidence: Composable "Comments"; Verification "`w` with an empty comment" (a top-up, no message sent, no counter changes) -->

**Retire and the end**

- [x] After `retire`: new deposits, and those whose `deposit_ready` arrives later, are refused with `retired` and
      refunded; boundaries and draws run and pay; withdrawals and `w` work; mintable is false; no message clears
      `retired`.
      <!-- evidence: Retire "After retire…" -->
- [x] `withdraw_for` with 100 owners, each message with its StateInit, stays under 850,000 gas and the action limit, and
      pays each owner to themselves; 101 owners are refused. It is refused before `retire` and from anyone but the
      governor.
      <!-- evidence: Retire "withdraw_for with 100 owners…" (832,620 gas at the last measure) -->
- [x] **End to end:** `retire`, the next boundary and its draw pay the pot to players, `withdraw_for` for all, `sweep`.
      Then `held_tokens` is 0, the burner got exactly what was left, `principal` is 0, every node is gone, and their
      balances are back at the Jackpot.
      <!-- evidence: Retire "End to end…" -->

**Migration**

- [x] With two Jackpots in the sandbox, `withdraw_for(to_successor)` books each owner in the new one under their own
      address with `booked_principal ≥ min_principal`. A move the new Jackpot refuses returns hGRAM to the owner, never
      to the old Jackpot or the governor. An owner's own move works, and falls back to paying the owner with no successor
      or too little value.
      <!-- evidence: Retire "withdraw_for(to_successor) books each owner…", "An owner's move with too little value…", "F1…", "R1…" -->
- [x] `set_successor` is refused before `retire`, for the Jackpot itself, and for a masterchain address.
      <!-- evidence: Retire "set_successor is refused before retire…" -->

**Logs**

- [x] Every log in the property run is an external out message to `addr_none` whose body starts with the tag of a
      constructor under Logs, `crc32("jackpot::<name>")`, and parses with that constructor to the end.
      `abi/jackpot.xml` lists every one as `<ext_out>`.
      <!-- evidence: Logs.spec; Property.spec (every log parsed strictly) -->

**Names and graphs**

- [x] Outside code and formula blocks, `docs/architecture.md`, the README and every script's output use the names. A
      script lists any lone `T`, `I`, `O`, `F`, `U`, `P`, `L`, `G` used as a quantity there, and finds none.
      <!-- evidence: tools/lintNames.mjs, part of `npm run lint`: no lone T, I, O, F, U, P, L or G in contracts/, wrappers/, the prose of docs/architecture.md and README.md, or the text the scripts print -->
- [x] `npm run graphs` writes `docs/graphs/<chapter>.dot`, `-light.svg`, `-dark.svg` and `docs/message-graphs.md`, for
      every chapter listed under Message graphs. GitHub shows the dark graphs in its dark theme. `npm test` fails when a
      committed `.dot` differs from what the story builds.
      <!-- evidence: `npm run graphs` (run once) writes the .dot, -light.svg, -dark.svg and docs/message-graphs.md; tests/story/story.spec.ts runs in `npm test` (about 60 s) and fails on a differing .dot; what GitHub shows in its dark theme is not checked here -->

**Gas and review**

- [ ] v2's "Gas returned" holds for a deposit with options, a refusal, a `burn`, a `w`, a poke, one owner of
      `withdraw_for`, and a move.
      <!-- not ticked: covered for a deposit and a burn (Flows "gas returned…") and for `w`, a poke, a submit, a refill and TEP-89 (Verification "Gas returned"); not for a refusal, a deposit with options, one owner of `withdraw_for` or a move -->
- [ ] Two money audits (one to prove it correct, one to make it lose money) and a code review pass on the code.
      <!-- not verifiable here: run by the coordinator outside the test suite (two money audits and a code review); not checked here -->

## Risks & rollback

- **The wallet's fixed code bakes in `fee::withdraw`.** A jGRAM wallet checks a burn's value against it, and wallet code
  can never be upgraded. If gas prices rise above the figure the fee was sized at (400 nano-GRAM per gas), a burn that
  passes the wallet's check may reach the Jackpot short. A future Jackpot must then make its own action phase fail on a
  short burn, so the burn bounces back (every action carries +16) and the wallet restores the balance, as it does now
  for a `burn_notification` with too little value.
- **The poker pays the boundary's log forwarding.** A boundary's `boundary_log` is an external message whose forwarding
  comes out of the poke's value like the gas, so a poke that is a boundary can cost its poker a little more than one
  that is not: about 0.0002 GRAM at today's prices, and more at old ones. The 0.002 GRAM tolerance of "No hidden reward"
  holds at today's prices; at old prices the difference can exceed it, and is still paid by the poker, never the float.
- **No poke, no draw.** Boundaries need someone to poke after a reward. Keepers poke after each reward; anyone can.
  Detect: no boundary for 1.5 times the expected rhythm. Nothing is lost meanwhile: the yield waits in the free pot.
- **No reward, no boundary.** If Hipo pays no reward for a while, no boundary comes; there is no yield to draw either.
- **Boundaries placed by others.** Anyone can place a boundary: before a reward with a gift of about 500 GRAM, or for
  free between two loans' parts of a reward. It gains nothing, as shown, and `min_gap` keeps it to one per `min_gap`.
  No alarm: a boundary between parts of a reward is normal.
- **No honest keeper**, as v2: with every keeper down, a player could submit only in rounds they win, since a skip costs
  them nothing. Detect: any `skip_log`.
- **A colluding drand quorum (accepted).** Knowing `R`, it can aim a partial burn at the winning ticket for the newest
  masterchain hash and race it with its own poke inside one masterchain interval: close to control on draws where it
  beats the keepers. Strictly better than drand alone, which left unlimited time to aim; it needs a drand quorum to
  collude, the trust v1 and v2 already placed in drand. Detect: boundaries poked by unknown addresses, and winners who
  burned or deposited shortly before the boundary.
- **Double collusion (accepted).** A drand quorum with a masterchain or shard collator can grind more choices of block;
  and the design relies on block time staying within `D` = 60 s of real time.
- **Validators alone** shape `mc_hash` but cannot bias the seed, since drand's round is unknown at the boundary.
- **The governor recovers by hand where the Jackpot cannot:** the cases listed under Failures, with `return_tokens`, and
  `close_subtree` at the end. Returning tokens still on their way pays them twice, so before every return the governor
  must see on chain the proof that the step can never finish: its handled bounce, or a message that left no bounce. The
  run-book says so for each case. This is trust in the governor, the same as its upgrade power, not a new power. Detect:
  untracked hGRAM above 0, `incoming_tokens` above 0 for more than an hour, a wallet with `pending > 0` for more than an
  hour.
- **Refill after a fall (accepted).** A refill at a stale rate after a fall could unstake up to about 15 GRAM of hGRAM
  that backs principal. It depends on Hipo's rate never falling, which Hipo's code keeps today; the treasury's upgrade
  checklist carries the rule.
- **The Jackpot trusts the treasury's echo and its rate.** If Hipo ever let a caller pick the reply's destination,
  changed the payload, or let the rate fall, a forged context or a stale rate would reach the Jackpot. The treasury's
  upgrade checklist carries both rules.
- **A treasury that refuses quotes** stops boundaries, so draws pause; deposits and withdrawals go on at the stored
  rate. Detect: the no-boundary alarm.
- **The Jackpot relies on full-body bounces.** Self-recovery needs global version 12 or later on the chain, which
  mainnet has had since 2025-11-13. If a later version changed the format behind `extra_flags = 3`, the Jackpot would
  ignore its bounces and their cases would fall to the governor; the wallet's old-format paths keep players' balances
  safe. Hipo's treasury upgrade checklist and this repo's dry run both read config 8.
- **An old-format bounce of `burn_notification`** restores the amount but can leave `pending` one too high, so that
  wallet never closes and keeps its storage reserve. No principal is lost.
- **A frozen wallet whose debt takes a deposit's whole value** leaves that deposit to the governor. With any value left,
  the bounce returns it by itself.
- **Nodes left by the close** keep their reserves and pay rent until `close_subtree`. No player funds are involved.
- **The sweep advances the cascade's GRAM**, the exact cost times the margin (about 0.2 GRAM of real cost for 10,000
  players today); all but the real cost comes back to the Jackpot, not to the sender.
- **A Hipo wallet or treasury migration** needs its own spec and a Jackpot upgrade before it happens, run with nothing
  in flight (`incoming_tokens = 0`, `unstaking_tokens = 0`). The balance move takes several messages; a payout made
  before it lands fails and is recovered with `return_tokens` from the new wallet. Hipo's treasury upgrade checklist
  already names the Jackpot. That migration spec must also settle two things this one cannot:
  - **The move's arrival must not look like a deposit.** If the new hGRAM arrives with a notification from a sender
    other than the Jackpot, the deposit path would refund the whole balance to that sender. The upgrade must recognise
    the arrival, or the move must carry no notification.
  - **Amounts recorded before it are in old units.** Untracked hGRAM waiting for `return_tokens`, and held foreign-path
    hGRAM that moved with the balance, arrive divided by `k`. Arrivals swept up by the move are in the new wallet, not
    the old one, so `rescue_jetton` on the old wallet does not find them.
- **Hipo's unstake bills must never be returned automatically.** Hipo's bills are not transferable today and send no
  ownership notice, since the Jackpot's `unstake_tokens` carries no custom payload. If Hipo ever made bills transferable
  and notifying, the automatic NFT return would give away an unstake receipt. So the Jackpot never returns an item of
  Hipo's bill collection by itself, and Hipo's upgrade checklist notes it.
- **Known limits, out of scope:** pokes after the sweep slowly drain the 1 GRAM left; an update lost at a frozen node
  leaves its sums wrong; after `set_hipo_wallet`, an `unstake_tokens` bounce or a `withdrawal_notification` from the old
  wallet is ignored, which the one-step rule above covers.
- **`withdraw_for` near the gas limit.** 100 owners use about half the limit at today's measure. If the gas of an
  operation rises in a later version, the governor sends smaller batches.
- **A wrong successor** receives what is moved. The steps under Trust.
- **Prize notices and boundaries cost the float** 0.03 GRAM and a boundary's real gas a draw, inside `fee::draw_budget`.
- **A wallet deleted for storage debt** loses its record of the balance, so `principal` never reaches 0 and `sweep` waits.
  Decades away at today's prices; the governor would then pay that owner by an upgrade, after checking the history.
- **Gifts.** Anyone can book principal for anyone. It costs the giver and takes nothing from the receiver.

Rollback: nothing is deployed. Before funds are in, redeploy. After, `retire` and let players withdraw, or move them.

## Open questions

None.

**Decided on 2026-11-03 and 2026-11-04:** `max_payload_cells` = 8; `max_withdraw_for` = 100, from the measured gas; 1
GRAM left after the sweep; prize notices carry `fee::prize_notify` = 0.01 GRAM; bounceable messages use full-body
bounces; booking stays the custom op `deposit_booked`, with the position assigned at booking; withdrawals start with
TEP-74 `burn` and are paid at once at the stored rate, with no live quote; deposits use the stored rate; pokes are the
only quotes, with no poke reward; boundaries come from Hipo's rate rise, with `rise_min` 0.005% and `min_gap` 32,768 s,
`min_gap` setting the rhythm, and the pot is fixed at the boundary; the falling flag stays, and the refill's stale-rate
limit is accepted; the tree closes at the end with `close_node`; tickets stay in nano-GRAM; no delay between
`set_successor` and the governor's moves; each log's op is `crc32("jackpot::<name>")`, written as its TL-B tag; the
seed mixes in the boundary's newest `mc_hash`, with a colluding drand quorum's race, and double collusion with a
collator, accepted, and a later seal transaction rejected; the token
stays jGRAM, "Hipo Jackpot GRAM", with the non-transferable description.

Also:

- **Decided 2026-11-04:** the close cascade is funded by `sweep`, which must bring `close_cost(next_position)` computed
  on chain from current prices; each node keeps its own cost, splits the rest by subtree size, and returns its whole
  balance; nodes never call `accept_message` for a close. (The split by subtree size is superseded by the audit, then
  by re-check 1 and re-check 2, below.)
- **Decided 2026-11-04:** foreign jettons and NFTs go back to their sender when their value covers it, otherwise wait
  for the governor's `rescue_jetton` or `rescue_nft`, which refuse the Jackpot's hGRAM wallet.
- **Decided 2026-11-04:** jGRAM wallets and nodes depend on nothing of Hipo's; `set_treasury` joins `set_hipo_wallet`;
  a Hipo migration gets its own spec and a Jackpot code upgrade.
- **Decided 2026-11-04:** `swept` in the retirement cell; deploy refuses a zero stored or boundary rate; an empty comment
  is a top-up; error codes 419–424 as in `contracts/imports/constants.fc`, 419 reserved and unused (a faked bounce
  throws 107).
- **Decided 2026-11-04 (audit):** each node gives each existing child exactly its `subtree_cost`, counted per level from
  `next_position`, in mode 0 with the forwarding inside the value; `close_cost(n)` is the top node's `subtree_cost` times
  one margin, applied at the top; a short node does nothing and keeps its value for `close_subtree`, which uses the same
  `subtree_cost`. This replaces the split by subtree size above. (The exact per-child split is superseded by re-check
  1's proportional split, and the node's share by re-check 2's `term − fwd`, below; `close_cost`, the short node and
  `close_subtree`'s use of `subtree_cost` stand.)
- **Decided 2026-11-04 (audit):** the foreign-token return reserves `bal0` and sends with mode 128, so the float pays
  neither gas nor log; a held token is logged only when its value covers the log; a bounced return means held.
- **Decided 2026-11-04 (audit):** `close_cost(0) = 0` and no `close_node` at `next_position = 0`; `close_subtree`
  refuses a node past `next_position`.
- **Decided 2026-11-04 (audit):** the close is funded by `sweep`'s sender with the float unchanged, replacing
  `send_excess(src, −close_hop_value())`; `sweep` also requires `unstaking_tokens = 0`.
- **Decided 2026-11-04 (audit):** `set_hipo_wallet` and `set_treasury` require halted and basechain `addr_std`, and log;
  repointing and moving the balance are one step inside the Hipo migration upgrade. (The treasury sequence decided
  here is superseded by re-check 1, and the "one step" by re-check 2: the Hipo migration upgrade only starts the move,
  below.)
- **Decided 2026-11-04 (audit):** `rescue_jetton` matches the current hGRAM wallet by parsed workchain and hash and
  requires `addr_std`, and can reach an old one; an NFT with an `addr_none` or Jackpot `prev_owner` is held; Hipo's
  bills are never returned automatically.
- **Decided 2026-11-04 (re-check 1):** each node keeps its own term and splits the rest of its value among its children
  in proportion to their `subtree_cost`, so the top's margin (at least 1.5) reaches the leaves; its own check stays
  unscaled; `gas_1` and `gas_inner` are upper bounds re-measured on the new node code with at least 1.5 times
  headroom; `GETFORWARDFEE` uses counts at least the real message's; `close_subtree` carries the margin; node counts
  use `max(0, …)`. This replaces the exact per-child split decided by the audit. (What a node keeps, "its own term",
  is superseded by re-check 2: it keeps `term − fwd`.)
- **Decided 2026-11-04 (re-check 1):** a migration with `k ≠ 1` is done inside the Hipo migration upgrade in one step,
  repointing the wallet, parent and code, moving the balance, setting the treasury and setting or rescaling by `k` the
  stored and boundary rates; the poke afterwards only confirms. Standalone `set_hipo_wallet` and `set_treasury` are only
  for `k = 1`. ("Moving the balance" in one step is superseded by re-check 2: the upgrade only starts the move, and
  runs only with nothing in flight.)
- **Decided 2026-11-04 (re-check 1):** `close_subtree` closes only the highest stranded nodes, and
  `scripts/closeSubtree.ts` picks them; `settle_unstake` gains `credit:Bool`.
- **Decided 2026-11-04 (re-check 2):** the Hipo migration upgrade refuses unless `incoming_tokens = 0` and
  `unstaking_tokens = 0`, since amounts in flight are in the old unit; the governor clears stuck deposits with
  `return_tokens` and stuck unstakes with `settle_unstake` before the upgrade.
- **Decided 2026-11-04 (re-check 2):** the Hipo migration upgrade only starts the balance move, which takes several
  messages; a payout
  before it lands fails and is recovered with `return_tokens` from the new wallet. This replaces "moving the balance" in
  one step in the re-check 1 line above.
- **Decided 2026-11-04 (re-check 2):** a node keeps `term − fwd`, its inbound forwarding being already paid, and splits
  the rest.
- **Decided 2026-11-04 (code review):** an owner's move and a payout's forward fields are judged on the value left at that
  point, not on the incoming value (F1); `fee::bounce_floor` covers update + cancel + refund + two handlers + forwarding
  (0.25 GRAM) and the undo's refund send ignores errors (F2); `withdraw_for` needs `fee::withdraw_for_gas` (0.0048 GRAM)
  an owner on top of `fee::comment_withdraw`; `fee::wallet_deploy_forward` is 0.008 GRAM and `fee::payload` 0.02 GRAM,
  sized with the forwarding of a 23-cell, 12,373-bit StateInit and of 8 cells of 1,023 bits; a non-bounced `0xfffffffe`
  body throws 107; the governor's move carries `Hipo Jackpot: moved` (narrowed by R1, below: only when a successor is
  set); the wallet's old-format `burn_notification`
  bounce leaves `pending`; `gas_excess` is handled before the data is loaded; the upgrade dry run also compares the
  addresses, boundary, retirement, stored rate and derived addresses; `scripts/closeSubtree.ts` counts a frozen node as
  standing.
- **Decided 2026-11-04 (code review, R1):** a move chosen on the value left keeps its forward fields: `pay_rest` does not
  re-decide it. The refund guard judges the value left, `deposit_ready`'s refusal counts `fee::release` as sent, the
  governor's move says "Hipo Jackpot: moved" only when a successor is set, and `fee::payout` must also cover Hipo's
  `send_tokens_fee`, the transfer's inbound forwarding and a cap-size payload's extra forwarding.
