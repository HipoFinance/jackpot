import { NetworkProvider } from '@ton/blueprint'
import { HIPO_PARENT } from './lib/addresses'
import {
    askAddress,
    askAmount,
    confirmSend,
    hashes,
    openJackpot,
    readPool,
    readWalletAddress,
    readWalletCode,
    requireQuiet,
    warnIfNotRole,
} from './lib/common'

// Points the Jackpot at a new Hipo parent, its hGRAM wallet and the wallet code, for when Hipo migrates its
// wallets. The wallet must be the parent's own derivation for the Jackpot. Refuses unless the Jackpot is
// halted, the draw is idle and no payouts, quotes or pending deposits are open.
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const jackpot = await openJackpot(provider)

    const pool = await readPool(provider, jackpot)
    if (!pool.halted) {
        throw new Error('Halt the Jackpot first (setHalted)')
    }
    requireQuiet(pool, 'Not changing the wallet', true)

    const current = await jackpot.getAddresses()
    ui.write(`Current parent:        ${current.parent.toString()}`)
    ui.write(`Current wallet:        ${current.wallet.toString()}`)
    ui.write(`Current wallet code:   ${hashes(current.walletCode).hex}`)

    const parent = await askAddress(
        provider,
        'Enter the friendly address of the Hipo parent',
        provider.network() === 'mainnet' ? HIPO_PARENT : current.parent,
    )
    const derived = await readWalletAddress(provider, parent, jackpot.address)
    const wallet = await askAddress(provider, "Enter the Jackpot's hGRAM wallet", derived)
    if (!wallet.equals(derived)) {
        throw new Error(`The wallet ${wallet.toString()} is not the parent's derivation ${derived.toString()}`)
    }
    const walletCode = await readWalletCode(provider, parent)

    await warnIfNotRole(provider, jackpot, 'governor')
    const value = await askAmount(provider, 'Enter the GRAM to send', '0.1')

    const via = await confirmSend(provider, 'Set the Hipo parent, wallet and wallet code', jackpot.address, value, [
        `parent:           ${parent.toString()}`,
        `wallet:           ${wallet.toString()} (the parent's derivation)`,
        `wallet code hash: ${hashes(walletCode).hex}`,
    ])
    if (via == null) {
        return
    }

    await jackpot.sendSetHipoWallet(via, { value, parent, wallet, walletCode })

    ui.write('Done')
}
