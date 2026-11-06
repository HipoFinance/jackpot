/** A node of the tree and whether its account is still active. */
export interface TreeNode {
    level: number
    index: number
    standing: boolean
    /** A frozen account counts as standing: it cannot run until it is revived, and its children wait under it. */
    frozen?: boolean
}

/**
 * The highest nodes still standing: those with no standing ancestor. close_subtree is sent to these only. If a child
 * were closed before its stranded parent, the parent's later close would still send that child its share, to an
 * address that is now empty, where it stays.
 */
export function highestStanding(nodes: TreeNode[]): TreeNode[] {
    const standing = new Set(nodes.filter((n) => n.standing).map((n) => `${String(n.level)}:${String(n.index)}`))
    return nodes.filter((n) => {
        if (!n.standing) return false
        let level = n.level
        let index = n.index
        while (level < 4) {
            level += 1
            index = Math.floor(index / 64)
            if (standing.has(`${String(level)}:${String(index)}`)) return false
        }
        return true
    })
}
