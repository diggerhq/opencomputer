import type { SessionEvent } from '@/api/client'

// Pure, React-free grouping of a session's raw event stream into turns.
//
// The backend never interrupts a running turn: input typed mid-turn is queued
// and gets its own follow-up turn on completion. The only wire linkage between
// an input event and the turn that consumes it is the inclusive seq range on
// the turn's `turn.started` body (`input_from_seq`/`input_to_seq`). Input events
// carry `turn_id == null`, so they cannot be grouped by turn_id — only by range.
//
// Rule: an input event with seq S belongs to the turn whose started bounds
// satisfy `from <= S <= to`. If no started turn covers S, the input is pending
// (typed but not yet claimed by a turn).

export type TurnState = 'running' | 'completed' | 'error' | 'canceled'

export interface TurnGroup {
  turnId: string
  fromSeq: number | null
  toSeq: number | null
  state: TurnState
  yieldReason?: string
  // seq-ordered; the turn's inputs + its outputs; excludes turn.started/turn.completed.
  events: SessionEvent[]
}

export interface GroupedTimeline {
  groups: TurnGroup[] // ordered by turn.started seq
  pending: SessionEvent[] // input events (turn_id==null) not yet claimed by any turn, seq-ordered
}

// body is unknown (inline JSON <=32KB); pull the common { text } shape defensively.
export function bodyText(ev: SessionEvent): string | null {
  const b = ev.body
  if (
    b &&
    typeof b === 'object' &&
    typeof (b as Record<string, unknown>).text === 'string'
  ) {
    return (b as Record<string, string>).text
  }
  return null
}

// The runtime's failPreExec emits an agent.message tagged with an
// insufficient_credits code so the UI can offer a "top up" affordance.
export function isOutOfCredits(ev: SessionEvent): boolean {
  return (
    ev.type === 'agent.message' &&
    (ev.body as Record<string, unknown> | null | undefined)?.code ===
      'insufficient_credits'
  )
}

// Reads input_from_seq/input_to_seq off a turn.started body, coercing legacy
// string seqs; null when a bound is absent (a turn with null bounds can't claim
// inputs by range).
export function turnBounds(ev: SessionEvent): {
  from: number | null
  to: number | null
} {
  const b = (ev.body ?? {}) as Record<string, unknown>
  const num = (v: unknown) =>
    v == null || Number.isNaN(Number(v)) ? null : Number(v)
  return { from: num(b.input_from_seq), to: num(b.input_to_seq) }
}

export function groupIntoTurns(input: SessionEvent[]): GroupedTimeline {
  const sorted = [...input].sort((a, b) => a.seq - b.seq)
  const byTurn = new Map<string, TurnGroup>()
  const order: string[] = []

  // Pass 1: skeletons from turn.started (defines the seq ranges + order).
  for (const ev of sorted) {
    if (ev.type !== 'turn.started' || !ev.turn_id) continue
    const { from, to } = turnBounds(ev)
    byTurn.set(ev.turn_id, {
      turnId: ev.turn_id,
      fromSeq: from,
      toSeq: to,
      state: 'running',
      events: [],
    })
    order.push(ev.turn_id)
  }

  // Pass 2: completion -> state.
  for (const ev of sorted) {
    if (ev.type !== 'turn.completed' || !ev.turn_id) continue
    const g = byTurn.get(ev.turn_id)
    if (!g) continue
    const rawYr = ((ev.body ?? {}) as Record<string, unknown>).yield_reason
    const yr = typeof rawYr === 'string' ? rawYr : ''
    g.yieldReason = yr || undefined
    g.state =
      yr === 'error' ? 'error' : yr === 'canceled' ? 'canceled' : 'completed'
  }

  // Pass 3: assign every event.
  const pending: SessionEvent[] = []
  for (const ev of sorted) {
    // chrome; state already captured above.
    if (ev.type === 'turn.started' || ev.type === 'turn.completed') continue
    if (ev.turn_id && byTurn.has(ev.turn_id)) {
      // agent.message / agent.result / tool.call / error.
      byTurn.get(ev.turn_id)!.events.push(ev)
      continue
    }
    if (ev.turn_id == null) {
      // input event: claim by seq range.
      const g = [...byTurn.values()].find(
        (t) =>
          t.fromSeq != null &&
          t.toSeq != null &&
          ev.seq >= t.fromSeq &&
          ev.seq <= t.toSeq,
      )
      if (g) g.events.push(ev)
      else pending.push(ev) // seq beyond every started turn -> not yet claimed
      continue
    }
    // turn_id set but no matching started skeleton (out-of-order/late): lazily create.
    const g: TurnGroup = {
      turnId: ev.turn_id,
      fromSeq: null,
      toSeq: null,
      state: 'running',
      events: [ev],
    }
    byTurn.set(ev.turn_id, g)
    order.push(ev.turn_id)
  }

  for (const g of byTurn.values()) g.events.sort((a, b) => a.seq - b.seq)
  return {
    groups: order.map((id) => byTurn.get(id)!),
    pending: pending.sort((a, b) => a.seq - b.seq),
  }
}
