import type {
  ApiEvent,
  Ask,
  InboxEntry,
  OpRow,
  Pending,
} from '@opencomputer/sdk/computer'

// Folds a session's events into what a conversation shows: people's messages,
// the agent's replies, its steps as single lines, and its asks. Types it does
// not know are skipped, as the API asks of every client.

export type Item =
  | {
      kind: 'user'
      key: string
      text: string
      author: string | null
      at: string
      state?: 'sending' | 'queued' | 'failed'
      reason?: string
    }
  | {
      kind: 'agent'
      key: string
      text: string
      at: string
      streaming?: boolean
    }
  | {
      kind: 'step'
      key: string
      title: string
      status: 'running' | 'done' | 'failed'
      at: string
    }
  | { kind: 'ask'; key: string; ask: Ask; at: string }
  // A line that is not a message: a structural change, "Stopped", a failure.
  | {
      kind: 'line'
      key: string
      text: string
      tone: 'muted' | 'error'
      at: string
      undo?: string
      undone?: boolean
    }

export type OpenBlock = {
  blockId: string
  type: string
  turnId: string
  text: string
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

const withoutSlackHeader = (text: string | null): string | null =>
  text && text.replace(/^\[Slack: from [^\n]*\]\n?/gm, '').trim()

// `me`: the person looking; their own messages carry no name.
export function buildTranscript(
  events: readonly ApiEvent[],
  me?: string,
): Item[] {
  const items: Item[] = []
  const steps = new Map<string, Extract<Item, { kind: 'step' }>>()
  const asks = new Map<string, Extract<Item, { kind: 'ask' }>>()
  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>
    switch (e.type) {
      case 'message.received': {
        // Input the platform writes is not drawn as a message (R15).
        if (e.actor?.via === 'platform' || e.actor?.id === 'platform') break
        const text = withoutSlackHeader(str(d.input))
        const name = e.actor?.name
        if (!text) break
        // What a track's agent passes to a thread is a marked line, not the person speaking (G4).
        if (e.actor?.via === 'agent')
          items.push({
            kind: 'line',
            key: e.turnId ?? e.id,
            text,
            tone: 'muted',
            at: e.createdAt,
          })
        else
          items.push({
            kind: 'user',
            key: e.turnId ?? e.id,
            text,
            author:
              name && name !== e.actor?.id && e.actor?.id !== me ? name : null,
            at: e.createdAt,
          })
        break
      }
      case 'message.completed': {
        if (d.parentCallId) break
        const text = str(d.text)
        if (text)
          items.push({ kind: 'agent', key: e.id, text, at: e.createdAt })
        break
      }
      case 'tool.started':
      case 'tool.completed':
      case 'tool.failed': {
        if (d.parentCallId) break
        const callId = str(d.callId) ?? e.id
        const status =
          e.type === 'tool.started'
            ? 'running'
            : e.type === 'tool.completed'
              ? 'done'
              : 'failed'
        const have = steps.get(callId)
        if (have) have.status = status
        else {
          const step = {
            kind: 'step' as const,
            key: `step-${callId}`,
            title: str(d.title) ?? str(d.toolName) ?? 'Tool',
            status,
            at: e.createdAt,
          } as Extract<Item, { kind: 'step' }>
          steps.set(callId, step)
          items.push(step)
        }
        break
      }
      case 'ask.opened':
      case 'ask.closed': {
        const ask = d.ask as Ask | undefined
        if (!ask) break
        const seen = asks.get(ask.id)
        if (seen) seen.ask = ask
        else {
          const item = {
            kind: 'ask' as const,
            key: `ask-${ask.id}`,
            ask,
            at: e.createdAt,
          }
          asks.set(ask.id, item)
          items.push(item)
        }
        break
      }
      case 'track.note': {
        const text = str(d.text)
        if (text)
          items.push({
            kind: 'line',
            key: e.id,
            text,
            tone: 'muted',
            at: e.createdAt,
          })
        break
      }
      case 'turn.failed': {
        const err = d.error as { message?: unknown } | undefined
        items.push({
          kind: 'line',
          key: e.id,
          text: str(err?.message) ?? 'The turn failed.',
          tone: 'error',
          at: e.createdAt,
        })
        break
      }
      case 'turn.cancelled':
        items.push({
          kind: 'line',
          key: e.id,
          text: 'Stopped',
          tone: 'muted',
          at: e.createdAt,
        })
        break
      case 'turn.completed':
      case 'turn.started':
        break
    }
  }
  // A step still running in a turn that has ended is not running.
  return items
}

// The person's own messages that no event shows yet: queued here, waiting in
// the session's inbox, or refused by the host (spec 40.2, steps 6 and 7).
export function unsent(
  events: readonly ApiEvent[],
  pending: readonly Pending[],
  inbox: readonly InboxEntry[],
  sid: string,
): Item[] {
  const seen = new Set<string>()
  for (const e of events)
    if (e.type === 'message.received' && e.turnId) seen.add(e.turnId)
  const out: Item[] = []
  const mine = new Set<string>()
  for (const p of pending) {
    if (p.kind === 'session' && p.sessionId === sid) {
      mine.add(p.body.turnId)
      if (!seen.has(p.body.turnId))
        out.push({
          kind: 'user',
          key: p.body.turnId,
          text: p.body.input,
          author: null,
          at: new Date(p.at).toISOString(),
          state: 'sending',
        })
    } else if (p.kind === 'turn' && p.sessionId === sid) {
      mine.add(p.turnId)
      if (!seen.has(p.turnId))
        out.push({
          kind: 'user',
          key: p.turnId,
          text: p.input,
          author: null,
          at: new Date(p.at).toISOString(),
          state: 'sending',
        })
    }
  }
  for (const i of inbox) {
    if (i.kind !== 'turn' || seen.has(i.id) || mine.has(i.id) || !i.text)
      continue
    if (i.by.startsWith('agent:') || i.by === 'platform') continue
    out.push({
      kind: 'user',
      key: i.id,
      text: i.text,
      author: null,
      at: i.at,
      state: i.error ? 'failed' : 'queued',
      reason: i.error ?? undefined,
    })
  }
  return out
}

export function formatDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
}

// One line per structural change an agent made, with its Undo (A18, R15):
// "Now in the track X · Undo" in a thread, "Renamed from X · Undo".
export function opLines(
  ops: Iterable<OpRow>,
  where: { sessionId: string } | { trackId: string },
  names: { track(id: string): string; thread(id: string): string },
): Item[] {
  const out: Item[] = []
  const inThread = 'sessionId' in where
  for (const op of ops) {
    if (
      inThread ? op.sessionId !== where.sessionId : op.trackId !== where.trackId
    )
      continue
    if (!op.by.startsWith('agent:') || op.name === 'undo') continue
    const a = op.args as Record<string, string | null | undefined>
    const before = (op.inverse as { args?: Record<string, string> } | null)
      ?.args
    let text: string | null = null
    if (op.name === 'track.create' && inThread)
      text = op.undoneBy
        ? 'Was made a track'
        : `Now in the track **${names.track(String(a.tid))}**`
    else if (op.name === 'thread.place' && inThread)
      text = a.trackId
        ? `Moved to the track **${names.track(a.trackId)}**`
        : 'Taken out of its track'
    else if (op.name === 'thread.place' && a.sid)
      text = `**${names.thread(a.sid)}** joined`
    else if (op.name === 'thread.rename' && before?.title && inThread)
      text = `Renamed from **${before.title}**`
    else if (op.name === 'track.rename' && before?.name && !inThread)
      text = `Renamed from **${before.name}**`
    if (!text) continue
    out.push({
      kind: 'line',
      key: op.id,
      text,
      tone: 'muted',
      at: new Date(op.at).toISOString(),
      undo: op.undoneBy ? undefined : op.id,
      undone: !!op.undoneBy,
    })
  }
  return out
}
