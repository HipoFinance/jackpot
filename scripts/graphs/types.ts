// What the story spec records of each chapter: its transactions, decoded, and the Jackpot's numbers afterwards.
export interface TraceTx {
    i: number
    parent: number | null
    from: string
    to: string
    op: string
    fields?: Record<string, string>
    valueGram: string
    bounced: boolean
    bounceable: boolean
    deploy: boolean
    destroyed: boolean
    exit: number | 'skipped'
    actionResult: number | null
    logs: Record<string, unknown>[]
}

export type TraceState = Record<string, string | number | boolean | string[]>;

export interface TraceChapter {
    id: string
    txs: TraceTx[]
    after: TraceState
}
