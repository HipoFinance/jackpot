# Hipo Jackpot

A no-loss prize draw on the TON blockchain, built on [Hipo](https://github.com/HipoFinance/contract)
liquid staking.

Players deposit GRAM or hGRAM. The contract keeps everything staked in Hipo as hGRAM, and after every
validation round it gives the round's staking yield to three randomly drawn players (50% / 30% / 20%).
Every player can withdraw their full deposit at any time, paid instantly in hGRAM.

- Your chance in each draw is proportional to the GRAM you have deposited. Splitting it across
  several wallets changes nothing, and one wallet can win more than one prize in the same round.
- A deposit takes part from the first draw after the one following it. Nobody can join a round
  that has already started.
- The random numbers come from [drand](https://drand.love), checked on chain, so neither validators
  nor the Hipo team can predict or steer a draw.
- A share of each draw goes to the HPO burn.

> **Status:** built, tested in the sandbox, money-audited and code-reviewed; not yet deployed. The approved
> design is in [`docs/specs/`](docs/specs), the contracts and their invariants in
> [`docs/architecture.md`](docs/architecture.md).

## How it works

- You deposit; the Jackpot books your principal at Hipo's rate and holds hGRAM, which keeps earning.
- Each validation round the yield (the pot) is paid to three winners drawn by position in a tree of small
  contracts, with drand randomness verified on chain.
- You can withdraw your principal at any time. A withdrawal pays a small surcharge only while a draw is settling, and only from a deposit that is
  eligible for that draw.

## Scripts

`npx blueprint run <script>`: `deployJackpot`, `showState`, `submitRandomness`, and one per governor or
halter operation. Each prints the message and asks before it sends anything. See
[`docs/architecture.md`](docs/architecture.md).

> **Terminology.** GRAM is the network coin (rebranded from TON) and hGRAM is Hipo's jetton. The
> blockchain itself is still called TON.

## License

MIT, see [LICENSE](LICENSE).
