import { Address, beginCell, Cell, fromNano, OpenedContract, Sender, toNano } from '@ton/core'
import { NetworkProvider, UIProvider } from '@ton/blueprint'
import { DrawState, Jackpot, PayoutKind } from '../../wrappers/Jackpot'

// Shared by the scripts. Blueprint 0.45 finds scripts recursively, so the files in this folder also appear in
// the `npx blueprint run` menu; choosing one only throws "Function run is missing", which is harmless.

export type JackpotContract = OpenedContract<Jackpot>
export type Books = Awaited<ReturnType<Jackpot['getBooks']>>

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
                    'The Jackpot will refuse this message.',
            )
    }
}

/** A sender that sends nothing: it prints the message, for the governor's multisig to submit. */
export function bodyPrinter(ui: UIProvider): Sender {
    return {
        send: (args) => {
            ui.write('\nMessage to submit from the governor contract (nothing was sent):')
            ui.write(`  to:     ${args.to.toString()}`)
            ui.write(`  value:  ${amount(args.value)} GRAM`)
            ui.write(`  bounce: ${String(args.bounce ?? true)}`)
            ui.write(`  body:   ${args.body?.toBoc().toString('base64') ?? ''}`)
            return Promise.resolve()
        },
    }
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
    question = 'Send this message? [yN], or "b" to only print the body for the governor contract to submit',
): Promise<Sender | null> {
    const ui = provider.ui()
    ui.write(`\n${title}`)
    ui.write(`  network:  ${provider.network()}`)
    ui.write(`  to:       ${to.toString()}`)
    ui.write(`  value:    ${amount(value)} GRAM`)
    for (const line of details) {
        ui.write(`  ${line}`)
    }
    const answer = (await ui.input(question)).trim().toLowerCase()
    if (answer === 'y') {
        return provider.sender()
    }
    if (answer === 'b') {
        return bodyPrinter(ui)
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

export interface Pool {
    /** The Jackpot's hGRAM wallet balance, W. */
    wallet: bigint
    /** T, the hGRAM the Jackpot counts as its own. */
    held: bigint
    /** W - T: hGRAM in the wallet that the Jackpot does not count. Only this pool may be given out by hand. */
    outside: bigint
    books: Books
    halted: boolean
    drawState: number
}

/** Reads W, T and W - T, the books and the draw state, one call at a time. */
export async function readPool(provider: NetworkProvider, jackpot: JackpotContract): Promise<Pool> {
    const addresses = await jackpot.getAddresses()
    const { stack } = await provider.provider(addresses.wallet).get('get_wallet_data', [])
    const wallet = stack.readBigNumber()
    const state = await jackpot.getJackpotState()
    const draw = await jackpot.getDrawState()
    const books = await jackpot.getBooks()
    return {
        wallet,
        held: state.totalTokens,
        outside: wallet - state.totalTokens,
        books,
        halted: state.halted,
        drawState: draw.state,
    }
}

/** Prints W, T, W - T and every open payout and pending record, which all draw on the same outside pool. */
export function printPool(ui: UIProvider, pool: Pool) {
    ui.write(`Jackpot wallet W:      ${amount(pool.wallet)} hGRAM`)
    ui.write(`Counted as T:          ${amount(pool.held)} hGRAM`)
    ui.write(`Outside T (W - T):     ${amount(pool.outside)} hGRAM`)
    for (const [id, p] of pool.books.pending) {
        ui.write(
            `  pending ${id.toString()}: ${p.owner.toString()} coins ${amount(p.coins)} cap ${amount(p.cap)} at ${String(p.createdAt)}`,
        )
    }
    for (const [id, p] of pool.books.payouts) {
        ui.write(
            `  payout ${id.toString()}: ${payoutKindName(p.kind)} ${amount(p.amount)} hGRAM to ${p.recipient.toString()}`,
        )
    }
    if (pool.books.pending.size + pool.books.payouts.size > 0) {
        ui.write('  (every record above draws on the same outside pool; give out at most the pool in all)')
    }
}

export function payoutKindName(kind: number) {
    return (Object.keys(PayoutKind) as (keyof typeof PayoutKind)[]).find((k) => PayoutKind[k] === kind) ?? String(kind)
}

/** Throws unless the draw is idle and there are no quotes and no pending deposits. */
export function requireQuiet(pool: Pool, what: string, alsoPayouts = false) {
    if (pool.drawState !== DrawState.idle) {
        throw new Error(`${what}: the draw is not idle`)
    }
    if (pool.books.quotes.size > 0 || pool.books.pending.size > 0) {
        throw new Error(`${what}: quotes or pending deposits are open`)
    }
    if (alsoPayouts && pool.books.payouts.size > 0) {
        throw new Error(`${what}: payouts are open`)
    }
}

interface ToncenterTx {
    account?: string
    description?: { aborted?: boolean }
    in_msg?: { source?: string | null; message_content?: { body?: string } }
}

/**
 * Checks on chain that the transfer of a payout bounced at the recipient's wallet: the transaction is at the
 * recipient's wallet, was aborted, and was a receive_tokens from the Jackpot's wallet with the payout's query
 * id. A success gas_excess that never arrived is NOT evidence of a failure: Hipo sends it with ignore_errors.
 * The transaction is read from toncenter's v3 API; confirm it on an explorer as well.
 */
export async function verifyBouncedReceive(
    provider: NetworkProvider,
    hash: string,
    recipientWallet: Address,
    jackpotWallet: Address,
    queryId: bigint,
): Promise<string[]> {
    const base = provider.network() === 'mainnet' ? 'https://toncenter.com' : 'https://testnet.toncenter.com'
    const response = await fetch(`${base}/api/v3/transactions?hash=${encodeURIComponent(hash)}&limit=1`)
    if (!response.ok) {
        throw new Error(`toncenter answered ${String(response.status)}`)
    }
    const body = (await response.json()) as { transactions?: ToncenterTx[] }
    const tx = body.transactions?.[0]
    if (tx == null) {
        throw new Error('No such transaction found')
    }
    const problems: string[] = []
    if (tx.account == null || !Address.parse(tx.account).equals(recipientWallet)) {
        problems.push(`the transaction is not at the recipient's wallet ${recipientWallet.toString()}`)
    }
    if (tx.description?.aborted !== true) {
        problems.push('the transaction did not abort, so the transfer did not bounce')
    }
    if (tx.in_msg?.source == null || !Address.parse(tx.in_msg.source).equals(jackpotWallet)) {
        problems.push("the message did not come from the Jackpot's wallet")
    }
    try {
        const s = Cell.fromBase64(tx.in_msg?.message_content?.body ?? '').beginParse()
        const op = s.loadUint(32)
        const id = s.loadUintBig(64)
        if (op !== 0x178d4519) {
            problems.push(`the message is not a receive_tokens (op ${op.toString(16)})`)
        }
        if (id !== queryId) {
            problems.push(`the query id is ${id.toString()}, not ${queryId.toString()}`)
        }
    } catch {
        problems.push('the message body could not be read')
    }
    return problems
}
