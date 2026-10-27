# Hipo Jackpot

A no-loss prize draw on top of the Hipo liquid staking protocol (`HipoFinance/contract`). Players
deposit GRAM or hGRAM, the contract holds hGRAM, and each validation round's yield is paid to three
drawn players. See README.md.

> Terminology: GRAM = the coin, hGRAM = Hipo's jetton. The network is still called the TON blockchain.

## Working on changes

The design lives in `docs/specs/`. For any new feature or behaviour change, write or update a spec
there first, get it approved, then build against it.

This repo is public. Keep anything about unreleased Hipo treasury changes out of it.

## Risk

Risk: `all-tier-3`. The contract holds user funds: every change to code here gets the two money audits
and the code review, without being asked.
