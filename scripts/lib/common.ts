import { Address, beginCell, Cell, fromNano, OpenedContract, Sender, toNano } from '@ton/core'
import { NetworkProvider, UIProvider } from '@ton/blueprint'
import { DrawState, Jackpot } from '../../wrappers/Jackpot'

// Shared by the scripts. Blueprint 0.45 finds scripts recursively, so the files in this folder also appear in
// the `npx blueprint run` menu; choosing one only throws "Function run is missing", which is harmless.

export type JackpotContract = OpenedContract<Jackpot>

/** Refuses an address that is not on the basechain: Hipo's wallet refuses to pay to any other chain. */
export function basechain(address: Address, what: string): Address {
    if (address.workChain !== 0) {
        throw new Error(`${what} must be a basechain address (workchain 0), got ${address.toString()}`)
    }
    return address
}

/** Asks for the Jackpot's address and opens it. */
export async function openJackpot(provider: NetworkProvider) {
    const addressString = await provider.ui().input('Enter the friendly address of the Jackpot')
    return provider.open(Jackpot.createFromAddress(Address.parse(addressString)))
}

/** Reads an amount in GRAM (or hGRAM) typed by the person, with a default for an empty answer. */
export async function askAmount(provider: NetworkProvider, question: string, defaultValue?: string): Promise<bigint> {
    const suffix = defaultValue == null ? '' : ` (default: ${defaultValue})`
    const answer = (await provider.ui().input(`${question}${suffix}`)).trim() || defaultValue
    if (answer == null) {
        throw new Error('An amount is required')
    }
    return toNano(answer)
}

/** Reads a whole number, with a default for an empty answer. */
export async function askInteger(provider: NetworkProvider, question: string, defaultValue?: string): Promise<bigint> {
    const suffix = defaultValue == null ? '' : ` (default: ${defaultValue})`
    const answer = (await provider.ui().input(`${question}${suffix}`)).trim() || defaultValue
    if (answer == null || !/^\d+$/.test(answer)) {
        throw new Error('A whole number is required')
    }
    return BigInt(answer)
}

/** Reads an address. It must be on the basechain; this covers owners, the burner and every other typed address. */
export async function askAddress(provider: NetworkProvider, question: string, defaultValue?: Address) {
    const suffix = defaultValue == null ? '' : ` (default: ${defaultValue.toString()})`
    const answer = (await provider.ui().input(`${question}${suffix}`)).trim()
    if (answer === '') {
        if (defaultValue == null) {
            throw new Error('An address is required')
        }
        return basechain(defaultValue, 'The address')
    }
    return basechain(Address.parse(answer), 'The address')
}

/** Formats nano units as whole units, e.g. 1500000000n as "1.5". */
export function amount(nano: bigint): string {
    return fromNano(nano)
}

export function hashes(code: Cell) {
    return { hex: code.hash().toString('hex'), base64: code.hash().toString('base64') }
}

/** Lets the person type back a hash from the audit record; anything else stops the script. */
export async function typeBackHash(provider: NetworkProvider, what: string, actual: string) {
    const typed = (await provider.ui().input(`Type the ${what} from the audit record (not the one printed above)`))
        .trim()
        .toLowerCase()
    if (typed.length < 8 || !actual.startsWith(typed)) {
        throw new Error(`The ${what} typed does not match the build. Nothing sent.`)
    }
}

/**
 * Warns when the sending wallet is not the address that holds a role in the Jackpot. The contract refuses
 * anyone else, so a wrong wallet costs only the bounced gas; the warning saves the trip.
 */
export async function warnIfNotRole(provider: NetworkProvider, jackpot: JackpotContract, role: 'governor' | 'halter') {
    const sender = provider.sender().address
    const addresses = await jackpot.getAddresses()
    const holder = addresses[role]
    if (sender == null) {
        provider.ui().write(`Could not tell which wallet sends. The ${role} is ${holder.toString()}.`)
    } else if (!sender.equals(holder)) {
        provider
            .ui()
            .write(
                `WARNING: the sending wallet ${sender.toString()} is not the ${role} ${holder.toString()}. ` +
                    'If the ' +
                    role +
                    ' is a multisig, its signers submit this message (answer "b" to print it); ' +
                    'sent from this wallet it would be refused.',
            )
    }
}

const printers = new WeakSet<Sender>()

/** A sender that sends nothing: it prints the message, for the governor's multisig to submit. */
export function bodyPrinter(ui: UIProvider, notes: string[] = []): Sender {
    const printer: Sender = {
        send: (args) => {
            ui.write('\nMessage to submit from the governor contract (nothing was sent):')
            ui.write(`  to:     ${args.to.toString()}`)
            ui.write(`  value:  ${amount(args.value)} GRAM`)
            ui.write(`  bounce: ${String(args.bounce ?? true)}`)
            ui.write(`  body:   ${args.body?.toBoc().toString('base64') ?? ''}`)
            for (const note of notes) {
                ui.write(`  ${note}`)
            }
            return Promise.resolve()
        },
    }
    printers.add(printer)
    return printer
}

/** Ends a script: "Done" after a send, and a plain statement after a printed body. */
export function done(ui: UIProvider, via: Sender) {
    ui.write(printers.has(via) ? 'Printed, nothing sent.' : 'Done')
}

export interface ConfirmOptions {
    /** Lines printed under a body printed with "b": what the order was checked against. */
    bodyNotes?: string[]
    /** False for messages anyone may send: there is no multisig path to offer. */
    allowBody?: boolean
}

/**
 * Prints what is about to be sent and asks. "y" returns the sending wallet; "b" returns a sender that only
 * prints the message body, for when the governor is a multisig that submits it; anything else returns null.
 * Nothing is sent here; the caller sends only with the returned sender.
 */
export async function confirmSend(
    provider: NetworkProvider,
    title: string,
    to: Address,
    value: bigint,
    details: string[],
    options: ConfirmOptions = {},
): Promise<Sender | null> {
    const ui = provider.ui()
    const allowBody = options.allowBody ?? true
    ui.write(`\n${title}`)
    ui.write(`  network:  ${provider.network()}`)
    ui.write(`  to:       ${to.toString()}`)
    ui.write(`  value:    ${amount(value)} GRAM`)
    for (const line of details) {
        ui.write(`  ${line}`)
    }
    const question = allowBody
        ? 'Send this message? [yN], or "b" to only print the body for the governor contract to submit'
        : 'Send this message? [yN]'
    const answer = (await ui.input(question)).trim().toLowerCase()
    if (answer === 'y') {
        return provider.sender()
    }
    if (answer === 'b' && allowBody) {
        return bodyPrinter(ui, options.bodyNotes)
    }
    return null
}

/** Hipo's hGRAM wallet code, read from the parent on chain (get_jetton_data), so it is the code Hipo uses. */
export async function readWalletCode(provider: NetworkProvider, parent: Address): Promise<Cell> {
    const { stack } = await provider.provider(parent).get('get_jetton_data', [])
    stack.skip(4)
    return stack.readCell()
}

/** The parent's admin: the address Hipo's parent takes as its treasury. */
export async function readParentAdmin(provider: NetworkProvider, parent: Address): Promise<Address> {
    const { stack } = await provider.provider(parent).get('get_jetton_data', [])
    stack.skip(2)
    return stack.readAddress()
}

/** The hGRAM wallet of an owner, asked of the parent on chain. */
export async function readWalletAddress(provider: NetworkProvider, parent: Address, owner: Address) {
    const { stack } = await provider
        .provider(parent)
        .get('get_wallet_address', [{ type: 'slice', cell: beginCell().storeAddress(owner).endCell() }])
    return stack.readAddress()
}

/** The halter and governor of Hipo's treasury, read from get_treasury_state on chain (never typed in). */
export async function readTreasuryRoles(provider: NetworkProvider, treasury: Address) {
    const { stack } = await provider.provider(treasury).get('get_treasury_state', [])
    // Sixteen fields (total_coins ... last_settled_round) come first, then the halter and the governor: the
    // order of getTreasuryState in the Hipo contract repo's wrappers/Treasury.ts.
    stack.skip(16)
    return { halter: stack.readAddress(), governor: stack.readAddress() }
}

/** The treasury's rate (total_coins, total_tokens), the first two fields of get_treasury_state, read on chain. */
export async function readTreasuryRate(provider: NetworkProvider, treasury: Address) {
    const { stack } = await provider.provider(treasury).get('get_treasury_state', [])
    return { coins: stack.readBigNumber(), tokens: stack.readBigNumber() }
}

interface JettonList {
    jettons?: { metadata?: { symbol?: string } }[]
}

/**
 * Asks an indexer's jetton list whether a jetton already uses a symbol: true, false, or null when the list could
 * not be read (the caller then asks the person). Reads tonapi's list in pages of 1000, at most 20 pages.
 */
export async function symbolInUse(provider: NetworkProvider, symbol: string): Promise<boolean | null> {
    const base = provider.network() === 'mainnet' ? 'https://tonapi.io' : 'https://testnet.tonapi.io'
    try {
        for (let page = 0; page < 20; page++) {
            const response = await fetch(`${base}/v2/jettons?limit=1000&offset=${String(page * 1000)}`)
            if (!response.ok) {
                return null
            }
            const body = (await response.json()) as JettonList
            const jettons = body.jettons ?? []
            if (jettons.some((j) => j.metadata?.symbol?.toLowerCase() === symbol.toLowerCase())) {
                return true
            }
            if (jettons.length < 1000) {
                return false
            }
        }
        return null
    } catch {
        return null
    }
}

export interface Pool {
    /** The Jackpot's hGRAM wallet balance, W; 0 while the wallet does not exist yet. */
    wallet: bigint
    /** T, the hGRAM the Jackpot counts as its own. */
    held: bigint
    /** W - T: hGRAM in the wallet that the Jackpot does not count. Every recovery draws on it. */
    outside: bigint
    /** Deposits received and not yet booked or returned; they are inside T. */
    incoming: bigint
    /** hGRAM sent to Hipo to unstake and not yet reported back; outside both W and T. */
    unstaking: bigint
    halted: boolean
    drawState: number
}

/** W, the Jackpot's hGRAM wallet balance: 0 before the first hGRAM arrives, when the wallet is not deployed. */
export async function readWalletBalance(provider: NetworkProvider, wallet: Address): Promise<bigint> {
    const walletProvider = provider.provider(wallet)
    if ((await walletProvider.getState()).state.type !== 'active') {
        return 0n
    }
    const { stack } = await walletProvider.get('get_wallet_data', [])
    return stack.readBigNumber()
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Reads W, T and W - T and the draw state, one call at a time. With `twice` (the default) W and T are read a
 * second time about 10 s later and the smaller W - T is used: prizes and burns in transit, and mints before
 * their notification, inflate it for a few seconds. The Jackpot keeps no record of payouts, so nothing else
 * says that an hGRAM transfer is still on its way.
 */
export async function readPool(provider: NetworkProvider, jackpot: JackpotContract, twice = true): Promise<Pool> {
    const addresses = await jackpot.getAddresses()
    const readOnce = async () => {
        const wallet = await readWalletBalance(provider, addresses.wallet)
        const state = await jackpot.getJackpotState()
        return { wallet, state }
    }
    let first = await readOnce()
    if (twice) {
        provider.ui().write('Reading the pool twice, 10 seconds apart...')
        await sleep(10_000)
        const second = await readOnce()
        if (second.wallet - second.state.heldTokens < first.wallet - first.state.heldTokens) {
            first = second
        }
    }
    const draw = await jackpot.getDrawState()
    return {
        wallet: first.wallet,
        held: first.state.heldTokens,
        outside: first.wallet - first.state.heldTokens,
        incoming: first.state.incomingTokens,
        unstaking: first.state.unstakingTokens,
        halted: first.state.halted,
        drawState: draw.state,
    }
}

/** Prints W, T and W - T, the pool every recovery draws on. */
export function printPool(ui: UIProvider, pool: Pool) {
    ui.write(`Jackpot wallet W:      ${amount(pool.wallet)} hGRAM`)
    ui.write(`Counted as T:          ${amount(pool.held)} hGRAM (of which incoming ${amount(pool.incoming)})`)
    ui.write(`Outside T (W - T):     ${amount(pool.outside)} hGRAM`)
    ui.write(`Unstaking at Hipo:     ${amount(pool.unstaking)} hGRAM (in neither W nor T)`)
    ui.write('  (a prize or burn still in transit also shows in W - T; the lower of two reads is used)')
}

/**
 * Asks whether this is a verify-only run: it re-reads everything and runs every check, prints pass or fail,
 * and sends nothing. Signers of a multisig order run it just before signing.
 */
export async function askVerifyOnly(provider: NetworkProvider): Promise<boolean> {
    const answer = await provider
        .ui()
        .input('Verify only? Answer "v" to run the checks and send nothing, anything else to go on')
    return answer.trim().toLowerCase() === 'v'
}

/**
 * Ends the checks. In a verify-only run it prints pass or fail and returns false; otherwise it throws on a
 * problem and returns true when there is none.
 */
export function conclude(ui: UIProvider, problems: string[], verifyOnly: boolean): boolean {
    if (verifyOnly) {
        if (problems.length === 0) {
            ui.write('\nVERIFY: PASS. Every check holds now. Nothing was sent.')
        } else {
            ui.write('\nVERIFY: FAIL. Nothing was sent.')
            for (const p of problems) {
                ui.write(`  - ${p}`)
            }
        }
        return false
    }
    if (problems.length > 0) {
        throw new Error(problems.join('; '))
    }
    return true
}

/**
 * Throws unless no draw is resolving. A draw that is waiting is quiet: a halted Jackpot or a silent drand leaves
 * it waiting for good, and no search is in flight.
 */
export function requireQuiet(pool: Pool, what: string) {
    if (pool.drawState === DrawState.resolving) {
        throw new Error(`${what}: a draw is resolving`)
    }
}
