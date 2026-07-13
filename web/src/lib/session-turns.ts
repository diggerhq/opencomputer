import type { SessionEvent } from '@/api/client'

// Pure, React-free reconstruction of the durable event log into neutral OC turns.
// New inputs already carry their platform turn id. Older brain-box and preview
// Flue inputs may need explicit seq bounds or the conservative legacy fallback.

export type TurnState =
  | 'queued'
  | 'running'
  | 'completed'
  | 'error'
  | 'canceled'

export interface TurnGroup {
  turnId: string
  fromSeq: number | null
  toSeq: number | null
  state: TurnState
  yieldReason?: string
  errorMessage?: string
  inferredBounds?: boolean
  // seq-ordered inputs and outputs; lifecycle markers stay as group metadata.
  events: SessionEvent[]
}

export interface GroupedTimeline {
  groups: TurnGroup[]
  // Inputs with no authoritative or unambiguous inferred owner.
  pending: SessionEvent[]
}

interface MutableTurn extends TurnGroup {
  firstSeq: number
  startSeq: number | null
  completion: SessionEvent | null
}

const FAILURE_OUTCOMES = new Set([
  'error',
  'failed',
  'deadline_exceeded',
  'max_turns',
  'budget_exceeded',
])

const TERMINAL_SESSION_STATUSES = new Set([
  'idle',
  'awaiting_input',
  'failed',
  'archived',
])

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

// body is unknown (inline JSON <=32KB); pull the common { text } shape defensively.
export function bodyText(ev: SessionEvent): string | null {
  const text = record(ev.body).text
  return typeof text === 'string' ? text : null
}

// The runtime's failPreExec emits an agent.message tagged with an
// insufficient_credits code so the UI can offer a "top up" affordance.
export function isOutOfCredits(ev: SessionEvent): boolean {
  return (
    ev.type === 'agent.message' &&
    record(ev.body).code === 'insufficient_credits'
  )
}

export function isTurnInput(ev: SessionEvent): boolean {
  return (
    ev.type === 'user.message' ||
    ev.source === 'client' ||
    ev.source === 'github'
  )
}

export function isTerminalSessionStatus(status?: string): boolean {
  return status != null && TERMINAL_SESSION_STATUSES.has(status)
}

// Reads input_from_seq/input_to_seq off a turn.started body, coercing legacy
// string seqs. A partial or invalid range is not authoritative.
export function turnBounds(ev: SessionEvent): {
  from: number | null
  to: number | null
} {
  const body = record(ev.body)
  const num = (value: unknown) => {
    if (value == null) return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return { from: num(body.input_from_seq), to: num(body.input_to_seq) }
}

function turnIdOf(ev: SessionEvent): string | null {
  if (typeof ev.turn_id === 'string' && ev.turn_id) return ev.turn_id
  const bodyTurnId = record(ev.body).turn_id
  return typeof bodyTurnId === 'string' && bodyTurnId ? bodyTurnId : null
}

function completionOutcome(ev: SessionEvent): string {
  const body = record(ev.body)
  const raw =
    typeof body.outcome === 'string'
      ? body.outcome
      : typeof body.yield_reason === 'string'
        ? body.yield_reason
        : ''
  return raw.toLowerCase()
}

function completionState(ev: SessionEvent): TurnState {
  const outcome = completionOutcome(ev)
  if (outcome === 'canceled' || outcome === 'cancelled') return 'canceled'
  if (FAILURE_OUTCOMES.has(outcome)) return 'error'
  return 'completed'
}

function errorText(value: unknown): string | null {
  if (typeof value === 'string' && value) return value
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const error = value as Record<string, unknown>
  const code = typeof error.code === 'string' ? error.code : null
  const message = [error.message, error.error, error.detail].find(
    (candidate): candidate is string =>
      typeof candidate === 'string' && candidate.length > 0,
  )
  if (code && message) return `${code}: ${message}`
  if (message) return message
  if (code) return code
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function completionError(ev: SessionEvent): string | null {
  const body = record(ev.body)
  return (
    errorText(body.error) ?? errorText(body.message) ?? errorText(body.detail)
  )
}

export function groupIntoTurns(input: SessionEvent[]): GroupedTimeline {
  // History and SSE intentionally overlap. Event id is the durable identity;
  // the later copy wins and seq ordering makes arrival order irrelevant.
  const deduped = new Map<string, SessionEvent>()
  for (const event of input) deduped.set(event.id, event)
  const sorted = [...deduped.values()].sort(
    (a, b) => a.seq - b.seq || a.id.localeCompare(b.id),
  )

  const byTurn = new Map<string, MutableTurn>()
  const ensureTurn = (turnId: string, seq: number): MutableTurn => {
    const existing = byTurn.get(turnId)
    if (existing) {
      existing.firstSeq = Math.min(existing.firstSeq, seq)
      return existing
    }
    const created: MutableTurn = {
      turnId,
      fromSeq: null,
      toSeq: null,
      state: 'queued',
      events: [],
      firstSeq: seq,
      startSeq: null,
      completion: null,
    }
    byTurn.set(turnId, created)
    return created
  }

  // Lifecycle pass. Completion is authoritative even if it arrived before
  // history or its start marker in the browser.
  for (const event of sorted) {
    const turnId = turnIdOf(event)
    if (!turnId) continue
    const group = ensureTurn(turnId, event.seq)
    if (event.type === 'turn.started') {
      const bounds = turnBounds(event)
      group.startSeq =
        group.startSeq == null ? event.seq : Math.min(group.startSeq, event.seq)
      if (bounds.from != null && bounds.to != null) {
        group.fromSeq = bounds.from
        group.toSeq = bounds.to
      }
    } else if (
      event.type === 'turn.completed' &&
      (!group.completion || event.seq >= group.completion.seq)
    ) {
      group.completion = event
    }
  }

  const claimedInputs = new Set<string>()

  // Direct turn ids are strongest. New OC inputs use this path, as do outputs.
  for (const event of sorted) {
    if (event.type === 'turn.started' || event.type === 'turn.completed')
      continue
    const turnId = turnIdOf(event)
    if (!turnId) continue
    const group = ensureTurn(turnId, event.seq)
    group.events.push(event)
    if (isTurnInput(event)) claimedInputs.add(event.id)
  }

  const inputs = sorted.filter(isTurnInput)

  // Older inputs have no turn id. Explicit inclusive bounds remain authoritative.
  for (const event of inputs) {
    if (claimedInputs.has(event.id)) continue
    const owners = [...byTurn.values()].filter(
      (group) =>
        group.fromSeq != null &&
        group.toSeq != null &&
        event.seq >= group.fromSeq &&
        event.seq <= group.toSeq,
    )
    const owner = owners.length === 1 ? owners[0] : undefined
    if (!owner) continue
    owner.events.push(event)
    owner.firstSeq = Math.min(owner.firstSeq, event.seq)
    claimedInputs.add(event.id)
  }

  // One-release preview fallback. Only a real start with both bounds absent
  // may claim the nearest earlier input, and never one already owned elsewhere.
  const legacyStarts = [...byTurn.values()]
    .filter(
      (group) =>
        group.startSeq != null &&
        group.fromSeq == null &&
        group.toSeq == null &&
        !group.events.some(isTurnInput),
    )
    .sort(
      (a, b) =>
        (a.startSeq ?? 0) - (b.startSeq ?? 0) ||
        a.turnId.localeCompare(b.turnId),
    )
  for (const group of legacyStarts) {
    const candidates = inputs.filter(
      (event) =>
        !claimedInputs.has(event.id) && event.seq < (group.startSeq ?? 0),
    )
    const candidate = candidates[candidates.length - 1]
    if (!candidate) continue
    group.events.push(candidate)
    group.fromSeq = candidate.seq
    group.toSeq = candidate.seq
    group.inferredBounds = true
    group.firstSeq = Math.min(group.firstSeq, candidate.seq)
    claimedInputs.add(candidate.id)
  }

  const pending = inputs.filter((event) => !claimedInputs.has(event.id))

  for (const group of byTurn.values()) {
    group.events.sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
    if (group.completion) {
      group.state = completionState(group.completion)
      const outcome = completionOutcome(group.completion)
      group.yieldReason = outcome || undefined
      if (group.state === 'error') {
        group.errorMessage = completionError(group.completion) ?? undefined
      }
    } else if (group.startSeq != null) {
      group.state = 'running'
    }
  }

  return {
    groups: [...byTurn.values()]
      .sort(
        (a, b) => a.firstSeq - b.firstSeq || a.turnId.localeCompare(b.turnId),
      )
      .map(
        (group): TurnGroup => ({
          turnId: group.turnId,
          fromSeq: group.fromSeq,
          toSeq: group.toSeq,
          state: group.state,
          events: group.events,
          ...(group.yieldReason ? { yieldReason: group.yieldReason } : {}),
          ...(group.errorMessage ? { errorMessage: group.errorMessage } : {}),
          ...(group.inferredBounds ? { inferredBounds: true } : {}),
        }),
      ),
    pending,
  }
}
