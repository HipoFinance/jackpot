import { Blockchain, createShardAccount, SendMessageResult } from '@ton/sandbox'
import { Address, Cell, toNano } from '@ton/core'
import { DrawState, Jackpot } from '../../wrappers/Jackpot'

// A sandbox dry run of an upgrade, on a copy of the live account (code, data, balance): the real upgrade
// message from the governor, the new code's getters, and an upgrade back. The treasury and Hipo's wallets are
// not in the sandbox, so nothing here needs them: the Jackpot must be halted with the draw idle and no open
// quotes or pending deposits, so that the upgrade has no message in flight to disturb.

export interface LiveAccount {
    address: Address
    code: Cell
    data: Cell
    balance: bigint
}

export interface Check {
    name: string
    ok: boolean
    detail?: string
}

function jackpotTransaction(result: SendMessageResult, address: Address) {
    return result.transactions.find((tx) => tx.inMessage?.info.dest?.toString() === address.toString())
}

// The exit code of the Jackpot's own transaction, and whether the transaction as a whole succeeded.
function outcome(result: SendMessageResult, address: Address) {
    const tx = jackpotTransaction(result, address)
    if (tx?.description.type !== 'generic' || tx.description.computePhase.type !== 'vm') {
        return { ok: false, exitCode: undefined }
    }
    const compute = tx.description.computePhase
    // migrate ends with throw(0), which the emulator reports as exit code 0 with success
    return { ok: compute.success && tx.description.actionPhase?.success !== false, exitCode: compute.exitCode }
}

export async function dryRunUpgrade(live: LiveAccount, newCode: Cell, expectedVersion: number): Promise<Check[]> {
    const checks: Check[] = []
    const add = (name: string, ok: boolean, detail?: string) => {
        checks.push({ name, ok, detail })
        return ok
    }

    const blockchain = await Blockchain.create()
    blockchain.now = Math.floor(Date.now() / 1000)
    await blockchain.setShardAccount(
        live.address,
        createShardAccount({ address: live.address, code: live.code, data: live.data, balance: live.balance }),
    )
    const jackpot = blockchain.openContract(Jackpot.createFromAddress(live.address))

    const state = await jackpot.getJackpotState()
    const draw = await jackpot.getDrawState()
    const books = await jackpot.getBooks()
    const addresses = await jackpot.getAddresses()
    const versionBefore = await jackpot.getStorageVersion()

    // Checked, not only printed.
    add('the Jackpot is halted', state.halted)
    add('the draw is idle', draw.state === DrawState.idle, `state ${String(draw.state)}`)
    add('no quote requests are open', books.quotes.size === 0, `${String(books.quotes.size)} open`)
    add('no pending deposits are open', books.pending.size === 0, `${String(books.pending.size)} open`)
    if (!checks.every((c) => c.ok)) {
        return checks
    }

    const governor = blockchain.sender(addresses.governor)
    const value = toNano('0.5')
    const codeHash = async () => {
        const account = (await blockchain.getContract(live.address)).accountState
        return account?.type === 'active' ? account.state.code?.hash().toString('hex') : undefined
    }
    const balance = async () => (await blockchain.getContract(live.address)).balance

    const up = await jackpot.sendUpgradeCode(governor, { value, code: newCode })
    add('upgrade_code from the governor succeeds', outcome(up, live.address).ok)
    add('the account now runs the new code', (await codeHash()) === newCode.hash().toString('hex'))

    const version = await jackpot.getStorageVersion()
    add(
        "get_storage_version equals the build's version",
        version === expectedVersion,
        `${String(version)} vs ${String(expectedVersion)}`,
    )

    try {
        const after = await jackpot.getJackpotState()
        const afterDraw = await jackpot.getDrawState()
        await jackpot.getQuote()
        await jackpot.getJackpotFees()
        await jackpot.getAddresses()
        await jackpot.getBooks()
        await jackpot.getPosition(0)
        await jackpot.getRangeAddress(0n)
        await jackpot.getNodeAddress(1, 0n)
        await jackpot.getClaimableParts(addresses.governor)
        add('every getter parses', true)
        const same =
            after.totalTokens === state.totalTokens &&
            after.inFlight === state.inFlight &&
            after.setAside === state.setAside &&
            after.principal === state.principal &&
            after.nextBooking === state.nextBooking &&
            afterDraw.drawId === draw.drawId
        add('T, I, O, P, n and draw_id are unchanged', same)
    } catch (e) {
        add('every getter parses', false, e instanceof Error ? e.message : String(e))
    }

    // top_up returns early on a current version and keeps the value: the balance must rise.
    const before = await balance()
    const topUp = await jackpot.sendTopUp(governor, toNano('0.1'))
    add(
        'a follow-up top_up succeeds and the balance rises',
        outcome(topUp, live.address).ok && (await balance()) > before,
    )

    // A requote of a record that does not exist must be refused by the new code with unknown_query (408):
    // that shows its dispatch and handler run, without a record to move.
    const requote = await jackpot.sendRequote(governor, { value, target: 0n })
    const r = outcome(requote, live.address)
    add(
        'a requote reaches the new code (refused with unknown_query 408)',
        r.exitCode === 408,
        `exit code ${String(r.exitCode)}`,
    )

    if (versionBefore !== expectedVersion) {
        // The layout changed, so the old code cannot read it: roll forward instead. A second upgrade_code to
        // the new code proves the new code still routes upgrade_code, and must change neither the version
        // nor the code.
        const again = await jackpot.sendUpgradeCode(governor, { value, code: newCode })
        add('a second upgrade_code to the new code succeeds', outcome(again, live.address).ok)
        add('the version is unchanged by it', (await jackpot.getStorageVersion()) === expectedVersion)
        add('the code is unchanged by it', (await codeHash()) === newCode.hash().toString('hex'))
    } else {
        const back = await jackpot.sendUpgradeCode(governor, { value, code: live.code })
        add('an upgrade back to the old code succeeds', outcome(back, live.address).ok)
        add('the old code runs again', (await codeHash()) === live.code.hash().toString('hex'))
        add('the version is read again', (await jackpot.getStorageVersion()) === versionBefore)
    }

    return checks
}
