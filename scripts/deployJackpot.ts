import { Address, toNano } from '@ton/core'
import { compile, NetworkProvider } from '@ton/blueprint'
import { Jackpot, jackpotConfigToCell, defaults } from '../wrappers/Jackpot'
import { BURNER, HIPO_PARENT, HIPO_TREASURY } from './lib/addresses'
import {
    amount,
    askAddress,
    askAmount,
    hashes,
    readParentAdmin,
    readTreasuryRoles,
    readWalletAddress,
    readWalletCode,
    typeBackHash,
} from './lib/common'

// The most a deploy can need: the 10 GRAM float, four first nodes at 0.32 GRAM, and the first quote.
const minimumValue = toNano('11.31')

// Deploys the Jackpot against Hipo's contracts. Nothing is sent until the deploy data has been shown, the
// code hashes have been typed back from the audit record, and "deploy" has been typed. The range and node code
// are compiled here and stored in the Jackpot's data: they are fixed for the life of the Jackpot.
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
    const rangeCode = await compile('Range')
    const nodeCode = await compile('Node')

    const config = { treasury, parent, walletCode, rangeCode, nodeCode, burner, governor, halter }
    const jackpot = provider.open(Jackpot.createFromConfig(config, jackpotCode))
    const hgramWallet = await readWalletAddress(provider, parent, jackpot.address)

    const value = await askAmount(
        provider,
        'Enter the GRAM to send with the deploy: 10 GRAM float + 1.28 GRAM for the first node of each level (4 x 0.32) + the first quote',
        '11.5',
    )
    if (value < minimumValue) {
        throw new Error('The deploy needs at least 11.31 GRAM')
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
    console.info('Jackpot code hash:    %s', hashes(jackpotCode).hex)
    console.info('Range code hash:      %s', hashes(rangeCode).hex)
    console.info('Node code hash:       %s', hashes(nodeCode).hex)
    console.info('Wallet code hash:     %s', hashes(walletCode).hex)
    console.info('Data hash:            %s', data.hash().toString('hex'))
    console.info('Data (base64 BOC):    %s', data.toBoc().toString('base64'))
    console.info('Value:                %s GRAM', amount(value))
    console.info()
    console.info('Check before sending:')
    console.info('1. The treasury, parent and burner are the ones in the READMEs of Hipo and the burner')
    console.info("2. The governor and halter are Hipo's, and a person has read both addresses")
    console.info('3. The code hashes you type next are those of the audit record, not of this screen')
    console.info('4. The first message asks the treasury for a rate; the Jackpot is usable once it answers')

    if (await existsAt(provider, jackpot.address)) {
        ui.write('\nThe Jackpot is already deployed at this address. Nothing to do.')
        return
    }

    // From the audit record, not echoed from the screen above.
    await typeBackHash(provider, 'Jackpot code hash (hex)', hashes(jackpotCode).hex)
    await typeBackHash(provider, 'Range code hash (hex)', hashes(rangeCode).hex)
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
