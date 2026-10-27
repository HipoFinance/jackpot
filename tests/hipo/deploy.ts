import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox'
import { Address, Cell, Dictionary, toNano } from '@ton/core'
import { readFileSync } from 'fs'
import { join } from 'path'
import { config } from './common'
import { Treasury, emptyDictionaryValue, participationDictionaryValue } from './Treasury'
import { Parent } from './Parent'
import { Wallet } from './Wallet'
import { buildBlockchainLibraries, exportLibCode } from './Librarian'
import { createVset, getConfig, setConfig, updateFeeConfig } from './chain'

function fixture(name: string): Cell {
    const json = JSON.parse(readFileSync(join(__dirname, '../fixtures/hipo', `${name}.compiled.json`), 'utf8'))
    return Cell.fromHex(json.hex)
}

export interface Hipo {
    blockchain: Blockchain
    treasury: SandboxContract<Treasury>
    parent: SandboxContract<Parent>
    governor: SandboxContract<TreasuryContract>
    halter: SandboxContract<TreasuryContract>
    walletAddress(owner: Address): Promise<Address>
    walletOf(owner: Address): Promise<SandboxContract<Wallet>>
    /** Raises the hGRAM rate by gifting coins; returns the new (total_coins, total_tokens). */
    raiseRate(gram: bigint | string): Promise<[bigint, bigint]>
    setStopped(stopped: boolean): Promise<void>
    setInstantMint(instantMint: boolean): Promise<void>
    /** Moves config param 34 (current validator set) forward by one round (the treasury's elected_for). */
    nextValidationRound(): Promise<void>
    /** The treasury's (total_coins, total_tokens). */
    quote(): Promise<[bigint, bigint]>
}

const deadShares = toNano('10')
const treasuryStorage = toNano('10')

/** Deploys the real Hipo treasury and parent the way the contract repo's tests/Wallet.spec.ts does. */
export async function deployHipo(blockchain: Blockchain, opts: { instantMint?: boolean } = {}): Promise<Hipo> {
    const treasuryCode = fixture('Treasury')
    const parentCode = fixture('Parent')
    const mainWalletCode = fixture('Wallet')
    const mainCollectionCode = fixture('Collection')
    const mainBillCode = fixture('Bill')
    const mainLoanCode = fixture('Loan')
    const walletCode = exportLibCode(mainWalletCode)
    const collectionCode = exportLibCode(mainCollectionCode)
    const billCode = exportLibCode(mainBillCode)
    const loanCode = exportLibCode(mainLoanCode)
    blockchain.libs = buildBlockchainLibraries([mainWalletCode, mainCollectionCode, mainBillCode, mainLoanCode])
    updateFeeConfig(blockchain)

    const halter = await blockchain.treasury('halter')
    const governor = await blockchain.treasury('governor')
    const deployer = await blockchain.treasury('deployer')
    const treasury = blockchain.openContract(
        Treasury.createFromConfig(
            {
                totalCoins: deadShares,
                totalTokens: deadShares,
                totalStaking: 0n,
                totalUnstaking: 0n,
                totalBorrowersStake: 0n,
                totalRequestFees: 0n,
                deficit: 0n,
                parent: null,
                participations: Dictionary.empty(Dictionary.Keys.BigUint(32), participationDictionaryValue),
                roundsImbalance: 255n,
                stopped: false,
                instantMint: false,
                loanCodes: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell()).set(0n, loanCode),
                previousRate: 1_000_000_000n,
                currentRate: 1_000_000_000n,
                windowDuration: 0n,
                lastSettledRound: 0n,
                halter: halter.address,
                governor: governor.address,
                proposedGovernor: null,
                governanceFee: 4096n,
                borrowerFee: 0n,
                rewardShare: 1799n,
                collectionCodes: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell()).set(
                    0n,
                    collectionCode,
                ),
                billCodes: Dictionary.empty(Dictionary.Keys.BigUint(32), Dictionary.Values.Cell()).set(0n, billCode),
                oldParents: Dictionary.empty(Dictionary.Keys.BigUint(256), emptyDictionaryValue),
                midRate: 1_000_000_000n,
                midRound: 0n,
            },
            treasuryCode,
        ),
    )
    const parent = blockchain.openContract(
        Parent.createFromConfig(
            { totalTokens: 0n, treasury: treasury.address, walletCode, content: Cell.EMPTY },
            parentCode,
        ),
    )

    await treasury.sendDeploy(deployer.getSender(), { value: '1' })
    await parent.sendDeploy(deployer.getSender(), { value: '1' })
    await treasury.sendSetParent(governor.getSender(), { value: '1', newParent: parent.address })
    // keep only the storage reserve on the treasury, as the contract tests do
    await treasury.sendWithdrawSurplus(governor.getSender(), { value: treasuryStorage, destination: governor.address })

    const hipo: Hipo = {
        blockchain,
        treasury,
        parent,
        governor,
        halter,
        walletAddress: (owner) => parent.getWalletAddress(owner),
        walletOf: async (owner) =>
            blockchain.openContract(Wallet.createFromAddress(await parent.getWalletAddress(owner))),
        async quote() {
            const state = await treasury.getTreasuryState()
            return [state.totalCoins, state.totalTokens]
        },
        async raiseRate(gram) {
            const coins = typeof gram === 'string' ? toNano(gram) : gram
            await treasury.sendGiftCoins(governor.getSender(), { value: coins + toNano('1'), coins })
            return hipo.quote()
        },
        async setStopped(stopped) {
            await treasury.sendSetStopped(halter.getSender(), { value: '1', newStopped: stopped })
        },
        async setInstantMint(instantMint) {
            await treasury.sendSetInstantMint(governor.getSender(), { value: '1', newInstantMint: instantMint })
        },
        async nextValidationRound() {
            const times = await treasury.getTimes()
            const electedFor = times.nextRoundSince - times.currentRoundSince
            const current = getConfig(blockchain, config.currentValidators)
            let since = BigInt(blockchain.now ?? Math.floor(Date.now() / 1000))
            if (current != null) {
                const s = current.beginParse()
                s.skip(8)
                since = s.loadUintBig(32)
            }
            const next = since + electedFor
            setConfig(blockchain, config.currentValidators, createVset(next, next + electedFor))
        },
    }

    if (opts.instantMint ?? true) {
        await hipo.setInstantMint(true)
    }
    return hipo
}
