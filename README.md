# Hipo Jackpot

A no-loss prize draw on the TON blockchain, built on [Hipo](https://github.com/HipoFinance/contract)
liquid staking.

Players stake on Hipo, then deposit their hGRAM here. The contract keeps it staked. Each time Hipo's exchange rate
has risen enough, anyone can poke the Jackpot, and the staking yield since the last draw is fixed as a pot and given
to three randomly drawn players (50% / 30% / 20%). Every player can withdraw their principal at any time, paid
instantly in hGRAM.

- Your chance in each draw is proportional to your principal. Splitting it across several wallets changes
  nothing, and one wallet can win more than one prize in the same draw.
- You hold jGRAM, a token that shows your principal: 1 jGRAM is 1 GRAM. It cannot be sent to anyone, and each
  player has one jGRAM wallet however many times they deposit.
- There is no waiting period. A deposit pays a small entry price into the pot instead, equal to the share of the
  current pot it buys, so buying in just before a draw gains nothing on average. The pot of a draw is fixed at its
  boundary, so a deposit after it never pays for, or wins, that pot.
- The random numbers come from [drand](https://drand.love), checked on chain, and are mixed with a masterchain block
  hash fixed at the boundary, so neither validators nor the Hipo team can predict or steer a draw.
- A share of each draw goes to the HPO burn.

> **Status:** v2 with amendment 1 is built; its contracts are not yet deployed. The approved design is in
> [`docs/specs/`](docs/specs) (the v2 spec and its amendment), the contracts and their invariants in
> [`docs/architecture.md`](docs/architecture.md), the message layouts in [`contracts/schema.tlb`](contracts/schema.tlb)
> and the logs in tongo's ABI form in [`abi/jackpot.xml`](abi/jackpot.xml).

## How it works

- You send hGRAM; the Jackpot books your principal at the rate it last read from Hipo, less the entry price, and
  holds the hGRAM, which keeps earning.
- There is no clock. Anyone can **poke** the Jackpot, which asks Hipo's treasury for its rate. When the rate has
  risen by at least a set fraction since the last draw and a minimum gap has passed, the reply is a **boundary**: the
  Jackpot takes a snapshot of who is in and fixes the pot at that moment. About a minute later drand publishes a
  number. Anyone can bring it to the Jackpot, which checks it, pays the sender back with a small reward, finds the
  three winners in a tree of small contracts, and pays them in hGRAM with a short note and 0.01 GRAM.
- You can withdraw at any time, with no surcharge, by burning your jGRAM (the standard jetton `burn`) or by sending the
  Jackpot GRAM with the comment `w`, which withdraws everything. The Jackpot pays hGRAM at once, with your `query_id`
  and payload, and keeps no record of it. Whatever gas a step doesn't use comes back to you, and when you withdraw
  everything your jGRAM wallet closes and returns its small reserve.
- A bounced message comes back whole (TON's full-body bounce), so a failed step is finished from the bounce itself.
- Draws are paid from the yield: the Jackpot keeps some GRAM and now and then unstakes a little of the pot.

### For apps and contracts

A deposit can name its beneficiary, the smallest principal it accepts, who gets the leftover GRAM, and a payload; when
it is booked the player's jGRAM wallet notifies the beneficiary like any jetton wallet, and when it is refused the hGRAM
comes back with a reason code. A withdrawal is a standard burn that can ask for the hGRAM to go to a successor Jackpot.
The Jackpot answers TEP-89 `provide_wallet_address`. See `contracts/schema.tlb`.

Fees are priced at the chain's current prices and read from the contract: `get_jackpot_fees` (deposit, `w`, poke, submit,
refill, TEP-89, payload, payout), `get_burn_fee(forward amount, payload cells, payload bits)` for a burn, and
`get_wallet_minimum_internal` on the player's wallet. A burn should carry `max(burn fee, wallet minimum + payload fee +
the wallet's storage debt)` (`burnAttach` in `wrappers/Jackpot.ts` computes it from the wallet's account); one that
carries less is refused and the wallet restores the balance. What a message brings above its fee comes back as
`gas_excess`.

### The end

The governor can **retire** the Jackpot: deposits stop for good, and withdrawals, draws and prizes go on. It can
withdraw for everyone in batches of 100, to themselves or into a successor Jackpot. When nobody is owed anything,
anyone can **sweep**, bringing the cost of closing the tree with the message (`get_close_cost`): what is left goes to the HPO burn and the tree of nodes closes, returning its storage reserves to the Jackpot. A foreign jetton or NFT sent to the Jackpot goes back to its sender when it comes with enough GRAM; the governor can rescue the rest.

## Scripts

`npx blueprint run <script>`: `deployJackpot`, `showState`, `poke`, `submitRandomness`, `refill`, `sweep`,
`reviveWallet`, and one per governor or halter operation (`setParams`, `setRiseMin`, `setMinGap`, `setHalted`,
`setHalter`, `clearFalling`, `withdrawSurplus`, `returnTokens`, `settleUnstake`, `setHipoWallet`, `setTreasury`, `rescueJetton`, `rescueNft`, `retire`, `setSuccessor`,
`withdrawFor`, `closeSubtree`, `upgradeCode`). Each prints the message and asks before it sends anything. See
[`docs/architecture.md`](docs/architecture.md).

`npm run graphs` runs the message-graph story in the sandbox and writes `docs/graphs/` (DOT and light and dark SVG) and
[`docs/message-graphs.md`](docs/message-graphs.md), one numbered graph per step of a deposit, a boundary, a draw, a
withdrawal and the end; `npm test` runs the same story and fails when the committed graphs differ from it (`SKIP_GRAPHS=1` skips that).

> **Terminology.** GRAM is the network coin (rebranded from TON) and hGRAM is Hipo's jetton. The
> blockchain itself is still called TON.

## License

MIT, see [LICENSE](LICENSE).
