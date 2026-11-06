import { Blockchain, createShardAccount, SandboxContract, SendMessageResult } from '@ton/sandbox'
import { Address, Cell, toNano } from '@ton/core'
import { DrawState, Jackpot, JackpotError } from '../../wrappers/Jackpot'

// A sandbox dry run of an upgrade, on a copy of the live account (code, data, balance): the real upgrade
// message from the governor, the new code's getters, and an upgrade back. The treasury and Hipo's wallets are
// not in the sandbox, so nothing here needs them: the Jackpot must be halted with no draw resolving (a waiting one
// is fine), so that the upgrade has no search in flight to disturb. The Jackpot keeps no records of its own.

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

// What a new build must keep to the letter: the addresses it reads (with the codes), the boundary, the retirement, the
// stored rate, and the addresses it derives (the jGRAM wallets of a few owners, the nodes of the tree). If a derivation
// changed, every wallet and node already deployed would be out of reach.
async function fingerprint(jackpot: SandboxContract<Jackpot>) {
    const a = await jackpot.getAddresses()
    const owners = [a.governor, a.halter, a.burner, a.treasury]
    const parts: string[] = [
        [a.treasury, a.parent, a.wallet, a.burner, a.governor, a.halter].map((x) => x.toString()).join(),
        [a.walletCode, a.jettonWalletCode, a.nodeCode].map((c) => c.hash().toString('hex')).join(),
        JSON.stringify(await jackpot.getBoundary(), (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
        JSON.stringify(await jackpot.getRetirement(), (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
        (await jackpot.getQuote()).map((x) => x.toString()).join(),
    ]
    for (const owner of owners) parts.push((await jackpot.getWalletAddress(owner)).toString())
    for (const [level, index] of [[1, 0n], [2, 0n], [3, 0n], [4, 0n], [1, 777n]] as const) {
        parts.push((await jackpot.getNodeAddress(level, index)).toString())
    }
    return parts.join('|')
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
    const addresses = await jackpot.getAddresses()
    const versionBefore = await jackpot.getStorageVersion()
    const printBefore = await fingerprint(jackpot)
    const haltedBefore = state.halted

    // Checked, not only printed.
    add('the Jackpot is halted', state.halted)
    // a draw that is waiting holds nothing in flight (a halted Jackpot or a silent drand leaves it waiting for good)
    add('no draw is resolving', draw.state !== DrawState.resolving, `state ${String(draw.state)}`)
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
        await jackpot.getBoundary()
        await jackpot.getRetirement()
        await jackpot.getJettonData()
        await jackpot.getAddresses()
        await jackpot.getPosition(0)
        await jackpot.getNodeAddress(1, 0n)
        add('every getter parses', true)
        add('the halted flag is unchanged', after.halted === haltedBefore)
        add(
            'the addresses and codes it reads, the boundary, the retirement, the stored rate and the derived wallet and node addresses are unchanged',
            (await fingerprint(jackpot)) === printBefore,
        )
        const same =
            after.heldTokens === state.heldTokens &&
            after.incomingTokens === state.incomingTokens &&
            after.reservedTokens === state.reservedTokens &&
            after.principal === state.principal &&
            after.tickets === state.tickets &&
            after.nextPosition === state.nextPosition &&
            after.tag === state.tag &&
            afterDraw.tag === draw.tag
        add('held, incoming and reserved tokens, principal, tickets, next position and tag are unchanged', same)
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

    // A poke with too little value must be refused by the new code with insufficient_fee (101): that shows its
    // dispatch and handler run, without a message to the treasury, which the sandbox does not have.
    const poke = await jackpot.sendPoke(governor, { value: toNano('0.01') })
    const r = outcome(poke, live.address)
    add(
        'a poke reaches the new code (refused with insufficient_fee 101)',
        r.exitCode === JackpotError.insufficientFee,
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
