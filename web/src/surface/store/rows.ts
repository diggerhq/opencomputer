import type {
  FeedFrame,
  Row,
  RowKind,
  RowOf,
} from '@opencomputer/sdk/computer'
import { ROW_KINDS } from '@opencomputer/sdk/computer'

// Rows as last received from the feed: a map per kind, keyed by id. Maps are
// replaced, never changed in place, so a selector can compare by identity.

export type Rows = { readonly [K in RowKind]: ReadonlyMap<string, RowOf<K>> }

export function emptyRows(): Rows {
  const rows = {} as Record<RowKind, Map<string, Row>>
  for (const k of ROW_KINDS) rows[k] = new Map()
  return rows as unknown as Rows
}

// A copy that is written to; a kind's map is copied on its first write.
export class Draft {
  private own = new Set<RowKind>()
  private maps: Record<RowKind, Map<string, Row>>
  constructor(base: Rows) {
    this.maps = { ...base } as unknown as Record<RowKind, Map<string, Row>>
  }
  get<K extends RowKind>(kind: K, id: string): RowOf<K> | undefined {
    return this.maps[kind].get(id) as RowOf<K> | undefined
  }
  all<K extends RowKind>(kind: K): IterableIterator<RowOf<K>> {
    return this.maps[kind].values() as IterableIterator<RowOf<K>>
  }
  private mine(kind: RowKind) {
    if (!this.own.has(kind)) {
      this.maps[kind] = new Map(this.maps[kind])
      this.own.add(kind)
    }
    return this.maps[kind]
  }
  set(row: Row) {
    this.mine(row.kind).set(row.id, row)
  }
  patch<K extends RowKind>(kind: K, id: string, change: Partial<RowOf<K>>) {
    const row = this.get(kind, id)
    if (row) this.set({ ...row, ...change } as Row)
  }
  delete(kind: RowKind, id: string) {
    if (this.maps[kind].has(id)) this.mine(kind).delete(id)
  }
  done(): Rows {
    return this.maps as unknown as Rows
  }
}

export function applyFrame(rows: Rows, frame: FeedFrame): Rows {
  const d = new Draft(frame.from === null ? emptyRows() : rows)
  for (const row of frame.rows) {
    if (!(row.kind in rows)) continue
    const have = d.get(row.kind, row.id)
    if (!have || have.version <= row.version) d.set(row)
  }
  for (const g of frame.gone)
    if (g.kind in rows) d.delete(g.kind as RowKind, g.id)
  return d.done()
}
