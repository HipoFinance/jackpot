// The text of each chapter of docs/message-graphs.md, with the numbers it quotes read from the story's own trace. The
// text is HTML-lite (<code>, <strong>); markdown.ts turns it into markdown.
import { n, nano, rate } from './dot'
import { TraceChapter, TraceState, TraceTx } from './types'

export const GROUPS: [string, string[]][] = [
    ['Deposits', ['alice-1', 'bob-1']],
    ['A reward and an early poke', ['reward-1', 'poke-early']],
    ['Deposit options and a refusal', ['carol-gift', 'eve-refused']],
    ['The boundary and the draw', ['boundary', 'draw']],
    ['Withdrawals', ['bob-burn', 'alice-w']],
    ['The float and a foreign jetton', ['refill', 'foreign']],
    ['The end', ['retire', 'withdraw-for', 'move', 'sweep']],
]

export const TITLES: Record<string, string> = {
    'alice-1': 'Alice makes the first deposit',
    'bob-1': 'Bob deposits',
    'reward-1': "Hipo's reward lands",
    'poke-early': 'A poke that is not a boundary',
    'carol-gift': 'Carol deposits for Dave, with options',
    'eve-refused': "Eve's deposit is refused: reason 5",
    boundary: 'The poke that is a boundary',
    draw: 'The draw: drand, the searches, three prizes',
    'bob-burn': 'Bob withdraws part by burn',
    'alice-w': 'Alice withdraws everything with "w"',
    refill: 'A refill unstakes',
    foreign: 'A foreign jetton goes back',
    retire: 'The governor retires the Jackpot and names a successor',
    'withdraw-for': 'withdraw_for pays Bob',
    move: 'withdraw_for moves Dave to the successor',
    sweep: 'sweep: the rest burned, the tree closed',
}

type Log = Record<string, string>

export function captions(chapters: TraceChapter[]): Record<string, string[]> {
    const d = new Map(chapters.map((c) => [c.id, c]))
    const T = (id: string) => {
        const c = d.get(id)
        if (c == null) throw new Error(`no chapter ${id}`)
        return c
    }
    const A = (id: string): TraceState => T(id).after
    const logs = (id: string, topic: string) =>
        T(id).txs.flatMap((t) => t.logs).filter((l) => l.topic === topic) as unknown as Log[]
    const first = (id: string, topic: string) => {
        const l = logs(id, topic)[0] as Log | undefined
        if (l == null) throw new Error(`no ${topic} log in ${id}`)
        return l
    }
    const tx = (id: string, op: string): TraceTx => {
        const t = T(id).txs.find((x) => x.op === op)
        if (t?.fields == null) throw new Error(`no ${op} in ${id}`)
        return t
    }
    const s = (st: TraceState, k: string) => String(st[k])
    const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1)

    const bkAlice = first('alice-1', 'booking')
    const pe = A('poke-early')
    const r1 = rate(s(pe, 'quote_coins'), s(pe, 'quote_tokens'))
    const cg = first('carol-gift', 'booking')
    const cgT = BigInt(cg.tokens)
    const cgC = BigInt(cg.principal)
    const cgV = (cgT * BigInt(s(pe, 'quote_coins'))) / BigInt(s(pe, 'quote_tokens'))
    const cgMin = tx('carol-gift', 'prepare_deposit').fields?.min_principal ?? '0'
    const ev = first('eve-refused', 'refused')
    const bd = first('boundary', 'boundary') as unknown as Record<string, unknown>
    const un = first('boundary', 'unstake')
    const wn = tx('boundary', 'withdrawal_notification').fields ?? {}
    const r2 = rate(String(bd.quoteCoins), String(bd.quoteTokens))
    const prizes = (bd.prizes as string[]).map((p) => nano(p))
    const slots = logs('draw', 'slot')
    const places = ['1st', '2nd', '3rd']
    const wins = slots.map((x) => `${places[Number(x.slot)]} ${nano(x.amount)} hGRAM to ${cap(x.owner)}`).join(', ')
    const wb = first('bob-burn', 'withdrawal')
    const wa = first('alice-w', 'withdrawal')
    const rf = first('refill', 'unstake')
    const rfn = tx('refill', 'withdrawal_notification').fields ?? {}
    const r3 = rate(s(A('refill'), 'quote_coins'), s(A('refill'), 'quote_tokens'))
    const sc = first('retire', 'successor')
    const wf = first('withdraw-for', 'withdrawal')
    const mv = first('move', 'withdrawal')
    const mvb = first('move', 'booking')
    const mvMin = tx('move', 'prepare_deposit').fields?.min_principal ?? '0'
    const sw = first('sweep', 'swept')
    const swFloat0 = A('move').float
    const swFloat1 = A('sweep').float

    return {
        'alice-1': [
            "Alice's wallet app sends hGRAM to the Jackpot with the deposit fee attached. Arrows 1 to 3 are an ordinary jetton transfer: her hGRAM wallet moves the tokens to the Jackpot's hGRAM wallet, which tells the Jackpot. The Jackpot does not book yet. It sends <code>prepare_deposit</code> to Alice's jGRAM wallet, with the wallet's StateInit, so the first deposit deploys it (5).",
            `The wallet answers <code>deposit_ready</code> (6): no position yet. The booking happens there, in one Jackpot transaction, at the stored rate: this is the first deposit, so <code>principal</code> is 0 and there is no price, <code>booked_principal = deposit_value</code>. The rate starts at exactly 1 in this sandbox, so 100,000 hGRAM books ${nano(bkAlice.principal)} GRAM of principal, at position 0.`,
            "Two things go out from the booking: the tree update (7, 9, 11, 12) and <code>deposit_booked</code> to the wallet (8), which credits 100,000 jGRAM. The first position deploys all four tree nodes, paid from the Jackpot's float. Alice's unused GRAM comes back on three arrows (4, 10, 13). The treasury is in none of this: no quote.",
        ],
        'bob-1': [
            "The same shape as Alice's deposit. Bob's jGRAM wallet is new too, so <code>prepare_deposit</code> deploys it and <code>deposit_ready</code> says he has no position. The Jackpot gives him position 1.",
            "The nodes over positions 0 to 63 already exist, so nothing new is deployed. Hipo's rate has not moved, so the pot is 0 and Bob pays no price.",
        ],
        'reward-1': [
            "Hipo's round ends and its rate rises 0.031%, the size of a real round today. <strong>No message reaches the Jackpot</strong>, so there is no graph, and none of its numbers change: it only learns the new rate when someone pokes. In this sandbox the reward is a gift to Hipo's treasury, standing in for a real round.",
        ],
        'poke-early': [
            "Anyone may poke. Here the keeper does, two hours after deploy. The Jackpot asks Hipo's treasury for its rate (2), carrying the poke's context in the quote's <code>custom_payload</code>; the treasury echoes it back with the rate (3).",
            `The reply stores the new rate, ${r1}. It is <strong>not a boundary</strong>: the rate has risen past <code>rise_min</code>, but <code>min_gap</code> (32,768 s, about nine hours) has not passed since the last boundary, here the deploy. So the reply only stores the rate and sends the rest of the GRAM back to the keeper (4). The pot in the numbers below now shows the yield on the hGRAM the Jackpot holds.`,
        ],
        'carol-gift': [
            `Carol deposits 30,000 hGRAM <strong>for Dave</strong>, with <code>deposit_options</code> in the transfer's payload: Dave as beneficiary, a <code>min_principal</code> of ${n(cgMin)} (she accepts a price of up to 0.5%), and a forward amount of 0.01 GRAM with the comment "A gift from Carol". Her app attaches the deposit fee plus that 0.01 and the payload's fee.`,
            `The context in <code>prepare_deposit</code> (5) names Dave as owner, so it goes to Dave's jGRAM wallet and deploys it. At the stored rate her hGRAM is worth ${nano(cgV)} GRAM, and the pot is not 0, so she pays the entry price: she books <strong>${nano(cgC)} GRAM</strong> and ${nano(cgV - cgC)} GRAM goes into the pot. That price is her share of the pot she is joining, so on average Dave wins it back.`,
            'New here: Dave\'s jGRAM wallet sends Dave a <code>transfer_notification</code> (10) with Carol\'s comment and her 0.01 GRAM, as any jetton wallet does. The leftover GRAM goes to Carol, the response destination (11). The last of the tree update goes to Dave (14), the beneficiary.',
        ],
        'eve-refused': [
            `Eve sends 1,000 hGRAM with a <code>min_principal</code> of 999,999 GRAM, which no deposit of that size can meet, and asks for a 0.01 GRAM forward amount. Up to <code>deposit_ready</code> (6) it looks like any first deposit. There the Jackpot works out the price, ${nano(ev.principal)} GRAM of principal for ${nano(ev.value)} GRAM of value, and refuses it with <strong>reason 5, <code>price</code></strong>.`,
            'The refusal is one step: <code>deposit_cancelled</code> to her new wallet, which deletes itself and returns its GRAM (7, 9), and the 1,000 hGRAM back to Eve (8, 10). Because she sent options with a forward amount, the refund carries <code>deposit_refused</code> with the reason code as its payload, and her hGRAM wallet notifies her (11). A deposit without options would get the comment "Hipo Jackpot: deposit returned (entry price above your limit)" instead. Nothing in the Jackpot\'s numbers changed; she lost only gas.',
        ],
        boundary: [
            `Nine hours later the next reward lands, and the keeper pokes. This time <code>min_gap</code> has passed and the rate has risen past <code>rise_min</code> since the deploy, so the reply (3) <strong>is a boundary</strong>, and the boundary's work runs inside that same transaction: <code>tag</code> becomes 1, the snapshot takes all ${nano(String(bd.snapshotTickets), 0)} tickets, and the pot is fixed at the new rate ${r2}: <strong>${nano(String(bd.pot))} hGRAM</strong>, the yield of both rewards.`,
            `Before this poke the float was set to 7.5 GRAM by hand, below the low mark of 8, so the boundary also unstakes: ${nano(un.amount)} hGRAM, enough to bring the float back to 15 (4). From the rest, 10% is the burn, ${nano(String(bd.burn))} hGRAM, and the prizes are ${prizes.join(', ')} hGRAM. They are set aside in <code>reserved_tokens</code>. The drand round is fixed too: ${String(bd.round)}. Nothing about this draw can change once that round is published.`,
            `The second graph is Hipo's own instant unstake: Hipo burns the hGRAM and its parent passes the GRAM back to the Jackpot's hGRAM wallet, which sends the Jackpot <code>withdrawal_notification</code> with ${n(wn.coins)} GRAM (10). The keeper got back what a plain poke returns (5): the float paid the boundary's gas.`,
        ],
        draw: [
            `drand has published round ${String(bd.round)}, and the keeper brings its signature (1). <code>submit_randomness</code> no longer asks for a quote: the pot was fixed at the boundary. The Jackpot checks the signature, mixes it with the masterchain block hash stored at the boundary to make the seed, and sends three searches into the tree, one per prize (2 to 4). The keeper gets the rest of its GRAM back plus a 0.02 GRAM reward (5).`,
            `Each search walks down the four levels, and the level-1 node answers by itself. All three are hits this time: ${wins}.`,
            `Each prize is an hGRAM transfer with 0.01 GRAM forward and a comment naming the draw and the place, so the winner's hGRAM wallet sends a notification (the <code>transfer_notification</code> arrows to Bob and Alice). The Jackpot does not wait to hear that a payout arrived: the <code>gas_excess</code> arrows back to it are ignored. When the last prize is paid the draw ends, and the burn owed, ${nano(String(bd.burn))} hGRAM, is above this story's batch of 5, so it goes to the burner in the same step.`,
        ],
        'bob-burn': [
            'Bob takes out 20,000 GRAM with a standard TEP-74 <code>burn</code> on his jGRAM wallet (1). The burn\'s <code>custom_payload</code> holds <code>withdraw_options</code>: a 0.02 GRAM forward amount and the comment "Savings app: order 17", the kind of thing an app would send. Its <code>query_id</code> rides along on every message.',
            `The wallet lowers his balance and sends <code>burn_notification</code> (2). The Jackpot pays in that same step, at the stored rate ${r2}: ${nano(wb.tokens)} hGRAM for 20,000 GRAM of principal. It sends the tree update (3) and the payout (4) together, and Bob's hGRAM wallet notifies him with his own payload (8). No quote, no confirmation, and nothing passes back through the Jackpot. Bob keeps 30,000 jGRAM and his position.`,
        ],
        'alice-w': [
            'Alice sends the Jackpot the fee with the text comment <code>w</code>, from any wallet app (1). The Jackpot turns it into a burn of everything on her jGRAM wallet (2), with the wallet\'s StateInit in case it did not exist.',
            `Her balance is now 0, so <code>burn_notification</code> says <code>last: true</code> (3). The Jackpot pays ${nano(wa.tokens)} hGRAM for her 100,000 GRAM of principal, with the comment "Hipo Jackpot withdrawal" and 1 nano-GRAM so it shows in her wallet (6, 9, 11), and sends <code>close_wallet</code> (5): the wallet deletes itself and returns its storage reserve (8). Her position 0 is never used again.`,
        ],
        refill: [
            `Before this step: a third reward and a poke that was not a boundary, so the stored rate is ${r3} and a pot of new yield is free again. Then the float was set to 3.5 GRAM by hand, below what a draw needs (<code>fee::draw_budget</code>).`,
            `Anyone may send <code>refill</code> then; here Frank does (1). It asks for no quote: it unstakes at the stored rate, at most a fifth of the free pot, here ${nano(rf.amount)} hGRAM (2). The rest of Frank's GRAM comes back (3), and Hipo's instant unstake brings ${n(rfn.coins)} GRAM into the float (8), the same chain as at the boundary.`,
        ],
        foreign: [
            'Frank sends the Jackpot 25 tokens of some other jetton, XYZ, by mistake, with 0.15 GRAM forward. The Jackpot\'s XYZ wallet is deployed by the transfer and notifies the Jackpot (3). The notification does not come from the Jackpot\'s own hGRAM wallet, so the Jackpot treats it as foreign: nothing is booked and no counter moves.',
            'The value covers <code>fee::foreign_return</code>, so it sends the 25 XYZ straight back with a TEP-74 transfer to the wallet that notified it (5), paid entirely from the notification\'s own value, with the comment "Hipo Jackpot: this token is not accepted" (7). In this sandbox XYZ is Hipo\'s wallet code under a stand-in minter: a real TEP-74 wallet of a different jetton.',
        ],
        retire: [
            `The governor sends <code>retire</code> (1). From now on deposits are refused with reason <code>retired</code>, and nothing can clear it. Withdrawals, <code>w</code>, boundaries and draws keep working. Then it names a successor (2), a new Jackpot deployed in the same sandbox, with the GRAM each move must send it for its deposit fee: ${nano(sc.depositFee, 4)} GRAM.`,
            'Each is one message with a log and no reply. In a real end the governor would now wait for the next boundary and its draw, which pays the last pot to the players. This story goes straight on.',
        ],
        'withdraw-for': [
            'The governor withdraws for Bob (1): <code>withdraw_for</code> lists up to 100 owners and pays the gas for each. The Jackpot sends Bob\'s jGRAM wallet the same burn a <code>w</code> sends (2), and returns what is above the cost to the governor (3).',
            `From there it is Alice's <code>w</code> again: Bob's ${nano(wf.principal, 0)} GRAM of principal is paid to Bob himself as ${nano(wf.tokens)} hGRAM, with the comment "Hipo Jackpot withdrawal", and his wallet closes. The governor chooses only whom to process, never where the hGRAM goes.`,
        ],
        move: [
            `Now <code>withdraw_for</code> with <code>to_successor: true</code> for Dave (1). The burn carries that flag (2), and since a successor is set and the value covers its deposit fee, the payout of ${nano(mv.tokens)} hGRAM goes to the <strong>new Jackpot</strong> as a deposit (7), with <code>deposit_options</code> the old Jackpot builds itself: Dave as beneficiary and response destination, and a <code>min_principal</code> of ${n(mvMin)} (a price of at most 1%).`,
            `In the second graph the successor runs an ordinary first deposit: it deploys Dave's jGRAM wallet there, books ${nano(mvb.principal)} GRAM of principal at position 0, deploys its own four nodes, and notifies Dave with the comment "Hipo Jackpot: moved". Dave's principal survived the move to the last rounding nano-GRAM. Had the new Jackpot refused, its refund would have gone to Dave's own hGRAM wallet, never back to the old one.`,
        ],
        sweep: [
            `Nobody is owed anything now: <code>principal</code> is 0. Anyone may send <code>sweep</code>; the governor does, bringing <code>fee::sweep</code> plus the cost of closing the tree (1). What the Jackpot still holds, ${nano(sw.tokens)} hGRAM, goes to the burner (2, 5, 8). That is the yield since the last boundary, from the third reward, plus rounding: it is here only because this story did not wait for a last draw.`,
            `Then <code>close_node</code> goes to the top node (3). Each node checks that every sum under it is 0, forwards <code>close_node</code> to each child that exists, and deletes itself, sending its whole balance, storage reserve included, back to the Jackpot. The float rose from ${nano(String(swFloat0), 2)} to ${nano(String(swFloat1), 2)} GRAM. All four nodes are gone, and the Jackpot is at its end.`,
        ],
    }
}
