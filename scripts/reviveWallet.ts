import { NetworkProvider } from '@ton/blueprint'
import { beginCell, Cell, loadStateInit, storeStateInit } from '@ton/core'
import { JackpotOp } from '../wrappers/Jackpot'
import { amount, askAddress, askAmount, confirmSend, done, openJackpot } from './lib/common'

// Revives a jGRAM wallet that Hipo's network froze for unpaid storage. Anyone may. A frozen account keeps
// only the hash of its last state, so the message must carry that exact state (code and data) as its
// StateInit: get it from an archive node or an explorer (the account's last state before it froze) and paste it
// as base64. The script checks its hash against the frozen account's, and the code against the Jackpot's wallet
// code, before it sends anything. The GRAM sent pays the debt; what is left stays in the wallet as its reserve.
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const jackpot = await openJackpot(provider)

    const owner = await askAddress(provider, 'Enter the friendly address of the wallet owner')
    const wallet = await jackpot.getWalletAddress(owner)
    ui.write(`jGRAM wallet: ${wallet.toString()}`)

    const state = (await provider.provider(wallet).getState()).state
    if (state.type !== 'frozen') {
        ui.write(`The wallet is ${state.type}, not frozen. Nothing to do.`)
        return
    }

    const typed = (await ui.input("Enter the wallet's last state (StateInit) as base64")).trim()
    const init = loadStateInit(Cell.fromBase64(typed).beginParse())
    const hash = beginCell().store(storeStateInit(init)).endCell().hash()
    if (!hash.equals(state.stateHash)) {
        throw new Error(
            `The state's hash ${hash.toString('hex')} is not the frozen hash ${state.stateHash.toString('hex')}`,
        )
    }
    const addresses = await jackpot.getAddresses()
    if (!init.code?.hash().equals(addresses.jettonWalletCode.hash())) {
        throw new Error("The state's code is not the Jackpot's jGRAM wallet code")
    }
    ui.write("The state matches the frozen account and the Jackpot's wallet code.")

    const value = await askAmount(provider, "Enter the GRAM to send: the wallet's debt and a little over", '0.5')

    const via = await confirmSend(
        provider,
        'Revive a frozen jGRAM wallet',
        wallet,
        value,
        [`owner:      ${owner.toString()}`],
        {
            allowBody: false,
        },
    )
    if (via == null) {
        return
    }

    await via.send({
        to: wallet,
        value,
        bounce: false,
        init,
        body: beginCell().storeUint(JackpotOp.topUp, 32).storeUint(0, 64).endCell(),
    })

    ui.write(`Sent ${amount(value)} GRAM with the state. Check that the wallet is active before using it.`)
    done(ui, via)
}
