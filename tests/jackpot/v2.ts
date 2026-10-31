// A test-only "version 2" of the Jackpot for the upgrade dry run: the real contracts/jackpot.fc compiled with
// storage_version = 2 and a migrate step that reads version-1 data and rewrites its first byte (and accepts data already at version 2,
// as a re-upgrade to the same code needs), so the layout
// bump is a real one (the old code cannot read the result, the new code reads only it). The patch is made in
// memory; nothing under contracts/ changes.
import { compileFunc } from '@ton-community/func-js'
import { Cell } from '@ton/core'
import { readFileSync } from 'fs'

function patch(source: string, from: string, to: string): string {
    if (!source.includes(from)) throw new Error(`v2 patch: ${from} not found`)
    return source.replace(from, to)
}

export async function compileJackpotV2(): Promise<Cell> {
    const result = await compileFunc({
        targets: ['contracts/jackpot.fc'],
        sources: (path: string) => {
            const source = readFileSync(path, 'utf8')
            if (path.endsWith('imports/constants.fc')) {
                return patch(source, 'const int storage_version = 1;', 'const int storage_version = 2;')
            }
            if (path.endsWith('contracts/jackpot.fc')) {
                return patch(
                    source,
                    '() migrate(int old_draw_id, int old_draw_state) impure method_id {\n    load_data();',
                    '() migrate(int old_draw_id, int old_draw_state) impure method_id {\n' +
                        '    slice old = get_data().begin_parse();\n' +
                        '    int old_version = old~load_uint(8);\n' +
                        '    throw_unless(413, (old_version == 1) | (old_version == 2));\n' +
                        '    if old_version == 1 {\n' +
                        '        set_data(begin_cell().store_uint(2, 8).store_slice(old).end_cell());\n' +
                        '    }\n' +
                        '    load_data();',
                )
            }
            return source
        },
    })
    if (result.status === 'error') throw new Error(result.message)
    return Cell.fromBase64(result.codeBoc)
}
