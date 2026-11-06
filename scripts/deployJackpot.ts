import { Address, toNano } from '@ton/core'
import { compile, NetworkProvider } from '@ton/blueprint'
import { Jackpot, jackpotConfigToCell, defaults, defaultContent, floatHigh } from '../wrappers/Jackpot'
import { BURNER, HIPO_PARENT, HIPO_TREASURY } from './lib/addresses'
import {
    amount,
    askAddress,
    askAmount,
    hashes,
    readParentAdmin,
    readTreasuryRate,
    readTreasuryRoles,
    readWalletAddress,
    readWalletCode,
    symbolInUse,
    typeBackHash,
} from './lib/common'

// The first node of each level is paid from the float (fee::node_open = 0.15 storage + 0.02 forward).
const nodeOpen = toNano('0.17')
const levels = 4n

// The least a deploy can carry: the float's target G_hi and the four first nodes.
const minimumValue = floatHigh + levels * nodeOpen

// Deploys the Jackpot against Hipo's contracts. Nothing is sent until the deploy data has been shown, the
// code hashes have been typed back from the audit record, and "deploy" has been typed. The jGRAM wallet and
// node code are compiled here and stored in the Jackpot's data: they are fixed for the life of the Jackpot.
// The deploy message also funds the float; it is sent only on a person's run. The first rate is read from the
// treasury on chain and stored as both the stored rate and the boundary rate, and the settings are checked against
// the contract's bounds. Right after the deploy the script offers a poke, which stores Hipo's current rate.
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const mainnet = provider.network() === 'mainnet'

    console.info('Deploying the Hipo Jackpot')
    console.info('Network: %s', provider.network())

    const treasury = await askAddress(
        provider,
        'Enter the friendly address of the Hipo treasury',
        mainnet ? HIPO_TREASURY : undefined,
    )
    const parent = await askAddress(
        provider,
        'Enter the friendly address of the Hipo parent (hGRAM master)',
        mainnet ? HIPO_PARENT : undefined,
    )
    const burner = await askAddress(provider, 'Enter the friendly address of the burner', mainnet ? BURNER : undefined)

    // The parent must belong to the treasury.
    const admin = await readParentAdmin(provider, parent)
    if (!admin.equals(treasury)) {
        throw new Error(`The parent's admin is ${admin.toString()}, not the treasury ${treasury.toString()}`)
    }

    // The governor and halter default to Hipo's, read from the treasury on chain.
    const roles = await readTreasuryRoles(provider, treasury)
    const governor = await askAddress(provider, 'Enter the friendly address of the governor', roles.governor)
    const halter = await askAddress(provider, 'Enter the friendly address of the halter', roles.halter)
    if (!governor.equals(roles.governor)) {
        ui.write(`WARNING: the governor differs from the treasury's governor ${roles.governor.toString()}`)
    }
    if (!halter.equals(roles.halter)) {
        ui.write(`WARNING: the halter differs from the treasury's halter ${roles.halter.toString()}`)
    }

    // The wallet code is read from the parent on chain, so it is exactly the code Hipo's wallets run.
    const walletCode = await readWalletCode(provider, parent)
    const jackpotCode = await compile('Jackpot')
    const jettonWalletCode = await compile('Wallet')
    const nodeCode = await compile('Node')

    // The first rate, read on chain: it is the stored rate and the boundary rate. The first boundary is the first
    // reward at least minGap after the deploy.
    const rate = await readTreasuryRate(provider, treasury)
    const lastBoundary = Math.floor(Date.now() / 1000)
    const problems: string[] = []
    if (rate.coins <= 0n || rate.tokens <= 0n) problems.push('the treasury reports a zero rate')
    if (defaults.burnShare > 2000n) problems.push('the burn share is above 2000')
    if (defaults.minDeposit < 1n) problems.push('the minimum deposit is below 1')
    if (defaults.riseMin < 1 || defaults.riseMin > 10000) problems.push('the rise minimum is outside 1 to 10000')
    if (defaults.minGap < 3600 || defaults.minGap > 2592000) problems.push('the minimum gap is outside 3600 to 2592000')
    if (problems.length > 0) {
        throw new Error(`Not deploying: ${problems.join('; ')}`)
    }

    // The token keeps the symbol jGRAM (the default content); stop if a known jetton already uses it.
    const content = defaultContent()
    const used = await symbolInUse(provider, 'jGRAM')
    if (used === true) {
        throw new Error('A well-known jetton already uses the symbol jGRAM. Nothing sent.')
    }
    if (used === null) {
        const answer = await ui.input('Could not check the symbol jGRAM against the indexer. Type "ok" to go on')
        if (answer.trim() !== 'ok') {
            return
        }
    }

    const config = {
        treasury,
        parent,
        walletCode,
        jettonWalletCode,
        nodeCode,
        burner,
        governor,
        halter,
        quoteCoins: rate.coins,
        quoteTokens: rate.tokens,
        lastBoundary,
        content,
    }
    const jackpot = provider.open(Jackpot.createFromConfig(config, jackpotCode))
    const hgramWallet = await readWalletAddress(provider, parent, jackpot.address)

    const value = await askAmount(
        provider,
        'Enter the GRAM to send with the deploy: 15 GRAM float (G_hi) + 0.68 GRAM for the first node of each level (4 x 0.17)',
        '15.7',
    )
    if (value < minimumValue) {
        throw new Error(`The deploy needs at least ${amount(minimumValue)} GRAM`)
    }

    const data = jackpotConfigToCell(config)
    console.info()
    console.info('DEPLOY DATA')
    console.info('===========')
    console.info('Jackpot address:      %s', jackpot.address.toString())
    console.info('Its hGRAM wallet:     %s', hgramWallet.toString())
    console.info('Treasury:             %s', treasury.toString())
    console.info('Parent:               %s', parent.toString())
    console.info('Burner:               %s', burner.toString())
    console.info('Governor:             %s', governor.toString())
    console.info('Halter:               %s', halter.toString())
    console.info('Burn share:           %s basis points', defaults.burnShare.toString())
    console.info('Smallest pot:         %s hGRAM', amount(defaults.minPot))
    console.info('Burn batch:           %s hGRAM', amount(defaults.burnBatch))
    console.info('Minimum deposit:      %s GRAM', amount(defaults.minDeposit))
    console.info('Rise minimum:         %s parts per million', String(defaults.riseMin))
    console.info('Minimum gap:          %s seconds', String(defaults.minGap))
    console.info('Rate at deploy:       %s GRAM / %s hGRAM', amount(rate.coins), amount(rate.tokens))
    console.info(
        'Last boundary:        %s (%s), the deploy time',
        String(lastBoundary),
        new Date(lastBoundary * 1000).toISOString(),
    )
    console.info('Token:                jGRAM, "Hipo Jackpot GRAM", 9 decimals')
    console.info('Jackpot code hash:    %s', hashes(jackpotCode).hex)
    console.info('jGRAM wallet code hash: %s', hashes(jettonWalletCode).hex)
    console.info('Node code hash:       %s', hashes(nodeCode).hex)
    console.info('Hipo wallet code hash: %s', hashes(walletCode).hex)
    console.info('Data hash:            %s', data.hash().toString('hex'))
    console.info('Data (base64 BOC):    %s', data.toBoc().toString('base64'))
    console.info('Value:                %s GRAM', amount(value))
    console.info()
    console.info('Check before sending:')
    console.info('1. The treasury, parent and burner are the ones in the READMEs of Hipo and the burner')
    console.info("2. The governor and halter are Hipo's, and a person has read both addresses")
    console.info('3. The code hashes you type next are those of the audit record, not of this screen')
    console.info(
        '4. The first boundary is the first reward at least the minimum gap after the deploy; the float is funded by this message',
    )

    if (await existsAt(provider, jackpot.address)) {
        ui.write('\nThe Jackpot is already deployed at this address. Nothing to do.')
        return
    }

    // From the audit record, not echoed from the screen above.
    await typeBackHash(provider, 'Jackpot code hash (hex)', hashes(jackpotCode).hex)
    await typeBackHash(provider, 'jGRAM wallet code hash (hex)', hashes(jettonWalletCode).hex)
    await typeBackHash(provider, 'Node code hash (hex)', hashes(nodeCode).hex)

    const confirm = await ui.input('Type "deploy" to send the deploy message, anything else to stop')
    if (confirm.trim() !== 'deploy') {
        return
    }

    await jackpot.sendDeploy(provider.sender(), value)
    await provider.waitForDeploy(jackpot.address)

    const actual = (await jackpot.getAddresses()).wallet
    if (actual.equals(hgramWallet)) {
        ui.write(`Deployed at ${jackpot.address.toString()}; its hGRAM wallet matches ${hgramWallet.toString()}`)
        // A poke right after stores Hipo's current rate in place of the one read from the state.
        const fees = await jackpot.getJackpotFees()
        const poke = (
            await ui.input(`Type "poke" to send a poke now (${amount(fees.poke)} GRAM), anything else to skip`)
        ).trim()
        if (poke === 'poke') {
            await jackpot.sendPoke(provider.sender(), { value: fees.poke })
        }
    } else {
        ui.write(
            `WARNING: deployed at ${jackpot.address.toString()}, but its hGRAM wallet is ${actual.toString()}, ` +
                `not the ${hgramWallet.toString()} printed above. Halt it and look.`,
        )
    }
}

async function existsAt(provider: NetworkProvider, address: Address): Promise<boolean> {
    return (await provider.provider(address).getState()).state.type === 'active'
}
