import { NetworkProvider } from '@ton/blueprint'
import { handlerFee, treeLevels } from '../wrappers/Jackpot'
import { amount, askAmount, askInteger, confirmSend, openJackpot, warnIfNotRole, done } from './lib/common'
import { TreeNode, highestStanding } from './lib/closeSubtree'

const arity = 64n
// the most nodes read per level; a level-1 node covers 64 positions, so this is already a large tree
const scanLimit = 1000n

// Restarts the close of the tree at one node, after the sweep, when the cascade left a node standing. Only the
// governor may. The script first lists the nodes still standing (account active or frozen), level by level, and offers only the
// highest ones: closing a child before its stranded parent would leave the parent's later close sending that child
// its share to an empty address. The message carries the subtree's cost times the margin (get_subtree_close_cost);
// what is not spent comes back to the Jackpot with the nodes' balances. A node closes only if all its own sums are 0,
// which they are after the sweep.
export async function run(provider: NetworkProvider) {
    const ui = provider.ui()
    const jackpot = await openJackpot(provider)

    const state = await jackpot.getJackpotState()
    if (!(await jackpot.getRetirement()).retired) {
        throw new Error('The Jackpot is not retired, so nothing is swept')
    }
    ui.write(`Positions ever made: ${state.nextPosition.toString()}`)
    const nodes: TreeNode[] = []

    for (let level = treeLevels; level >= 1; level--) {
        const span = arity ** BigInt(level)
        const count = (state.nextPosition + span - 1n) / span
        const limit = count < scanLimit ? count : scanLimit
        const standing: string[] = []
        for (let index = 0n; index < limit; index++) {
            const address = await jackpot.getNodeAddress(level, index)
            const nodeState = (await provider.provider(address).getState()).state
            const frozen = nodeState.type === 'frozen'
            nodes.push({ level, index: Number(index), standing: nodeState.type === 'active' || frozen, frozen })
            if (nodeState.type === 'active' || frozen) {
                standing.push(`(${String(level)}, ${index.toString()}) ${address.toString()}${frozen ? ' FROZEN: revive it with its state first' : ''}`)
            }
        }
        ui.write(
            `Level ${String(level)}: ${String(standing.length)} standing of ${count.toString()} nodes` +
                (limit < count ? ` (read the first ${limit.toString()} only)` : ''),
        )
        for (const line of standing) {
            ui.write(`  ${line}`)
        }
    }

    const highest = highestStanding(nodes)
    if (highest.length === 0) {
        ui.write('No node is standing in the part read. Nothing to do.')
        return
    }
    ui.write('Offered, the highest nodes standing:')
    for (const n of highest) ui.write(`  (${String(n.level)}, ${String(n.index)})${n.frozen ? ' (frozen: revive it first)' : ''}`)
    const level = Number(await askInteger(provider, 'Enter the level of the node to close (1 to 4)'))
    if (level < 1 || level > treeLevels) {
        throw new Error('The level is between 1 and 4')
    }
    const index = Number(await askInteger(provider, 'Enter the index of the node to close'))
    if (!highest.some((n) => n.level === level && n.index === index)) {
        throw new Error('Only the highest nodes standing are closed: a child first would strand its parent')
    }
    if (highest.find((n) => n.level === level && n.index === index)?.frozen) {
        throw new Error('That node is frozen and cannot run: revive it with its state first, then close it')
    }
    const cost = await jackpot.getSubtreeCloseCost(level, index)

    await warnIfNotRole(provider, jackpot, 'governor')
    const value = await askAmount(provider, 'Enter the GRAM to send', amount(cost + handlerFee))
    if (value < cost + handlerFee) {
        throw new Error(`The close needs at least ${amount(cost + handlerFee)} GRAM`)
    }

    const via = await confirmSend(provider, 'Restart the close of the tree at one node', jackpot.address, value, [
        `node:        level ${String(level)}, index ${String(index)}`,
        `cost:        ${amount(cost)} GRAM (the rest comes back)`,
    ])
    if (via == null) {
        return
    }

    await jackpot.sendCloseSubtree(via, { value, level, index })

    done(ui, via)
}
