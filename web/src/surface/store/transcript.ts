import type { ApiEvent, Ask, InboxEntry, OpRow, Pending, Subagent } from '@opencomputer/sdk/computer'

// Folds a session's events into what a conversation shows: people's messages,
// the agent's replies, its steps as single lines, its asks, and the subagents
// it launched with their own steps. Types it does
// not know are skipped, as the API asks of every client.

// Where a message was written, when it was not here.
const VIA: Record<string, string> = { slack: 'Slack', opc: 'CLI', api: 'API' }

export type Item =
  | { kind: 'user'; key: string; text: string; author: string | null; via?: string; at: string; state?: 'sending' | 'queued' | 'failed'; reason?: string }
  | { kind: 'agent'; key: string; text: string; at: string }
  // A turn's work: its steps, thinking and passing messages, in order. While
  // the turn runs, only its latest message stays out; once it has ended,
  // everything before its last message folds into this one line (the settled pattern).
  | { kind: 'work'; key: string; entries: Entry[]; settled: boolean; ms: number | null; at: string }
  | { kind: 'ask'; key: string; ask: Ask; at: string }
  // A subagent, where it was launched: its latest state, and its steps so far.
  // `activity`: what it is doing now, while it runs.
  | { kind: 'subagent'; key: string; sub: Subagent; steps: Step[]; activity: string | null; at: string }
  // A line that is not a message: a structural change, "Stopped", a failure.
  | { kind: 'line'; key: string; text: string; tone: 'muted' | 'error'; at: string; undo?: string; undone?: boolean }

export type Step = { kind: 'step'; key: string; title: string; status: 'running' | 'done' | 'failed' }

// `text` of thinking is empty when the model hid it.
export type Entry = Step | { kind: 'thinking'; key: string; text: string; ms: number | null } | { kind: 'text'; key: string; text: string }

export type OpenBlock = { blockId: string; type: string; turnId: string; text: string }

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

const withoutSlackHeader = (text: string | null): string | null =>
  text && text.replace(/^\[Slack: from [^\n]*\]\n?/gm, '').trim()

// `me`: the person looking; their own messages carry no name.
export function buildTranscript(events: readonly ApiEvent[], me?: string): Item[] {
  let items: Item[] = []
  const steps = new Map<string, Step>()
  type Work = Extract<Item, { kind: 'work' }>
  type Agent = Extract<Item, { kind: 'agent' }>
  // Each turn's work and messages, which fold when it ends, and when it began.
  const turns = new Map<string, { items: (Work | Agent)[]; began: string; settled: boolean }>()
  const asks = new Map<string, Extract<Item, { kind: 'ask' }>>()
  type Sub = Extract<Item, { kind: 'subagent' }>
  const subs = new Map<string, Sub>()
  const turnOf = (e: ApiEvent) => {
    const id = e.turnId ?? ''
    let t = turns.get(id)
    if (!t) turns.set(id, (t = { items: [], began: e.createdAt, settled: false }))
    return t
  }
  // The turn's open work item: the last item, if it is this turn's; else a new one.
  // A message the agent left in passing folds into it once the agent works on.
  const work = (e: ApiEvent, key: string): Work => {
    const t = turnOf(e)
    let last = items[items.length - 1]
    let passing: Agent | null = null
    if (last?.kind === 'agent' && t.items.includes(last)) {
      passing = items.pop() as Agent
      t.items.splice(t.items.indexOf(passing), 1)
      last = items[items.length - 1]
    }
    const text = passing && { kind: 'text' as const, key: passing.key, text: passing.text }
    if (last?.kind === 'work' && t.items.includes(last)) {
      if (text) last.entries.push(text)
      return last
    }
    const w: Work = { kind: 'work', key, entries: text ? [text] : [], settled: t.settled, ms: null, at: passing?.at ?? e.createdAt }
    t.items.push(w)
    items.push(w)
    return w
  }
  // A turn that has ended. Each unbroken run of its work and messages folds into
  // one work item, except the run's last message, which stays: the answer, or
  // what the agent said before it asked.
  const settle = (turnId: string | null | undefined, at: string) => {
    const t = turns.get(turnId ?? '')
    if (!t || t.settled) return
    t.settled = true
    const mine = new Set<Item>(t.items)
    const out: Item[] = []
    let first = true
    for (let i = 0; i < items.length; ) {
      if (!mine.has(items[i])) {
        out.push(items[i++])
        continue
      }
      let j = i
      while (j < items.length && mine.has(items[j])) j++
      const run = items.slice(i, j) as (Work | Agent)[]
      const kept = run[run.length - 1].kind === 'agent' ? (run.pop() as Agent) : null
      const head = run.find((r): r is Work => r.kind === 'work')
      if (head) {
        head.entries = run.flatMap((r) => (r.kind === 'work' ? r.entries : [{ kind: 'text' as const, key: r.key, text: r.text }]))
        head.settled = true
        for (const en of head.entries) if (en.kind === 'step' && en.status === 'running') en.status = 'done'
        const end = kept?.at ?? items[j]?.at ?? at
        head.ms = Date.parse(end) - Date.parse(first ? t.began : run[0].at)
        head.at = run[0].at
        out.push(head)
      } else out.push(...run)
      if (kept) out.push(kept)
      first = false
      i = j
    }
    items = out
  }
  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>
    switch (e.type) {
      case 'message.received': {
        // Input the platform writes is not drawn as a message (R15).
        if (e.actor?.via === 'platform' || e.actor?.id === 'platform') break
        const text = withoutSlackHeader(str(d.input))
        // Journals before the computer stopped using the git author name carry " via Computer".
        const name = e.actor?.name?.replace(/ via Computer$/, '')
        if (!text) break
        // What a track's agent passes to a thread is a marked line, not the person speaking (G4).
        if (e.actor?.via === 'agent') items.push({ kind: 'line', key: e.turnId ?? e.id, text, tone: 'muted', at: e.createdAt })
        else
          items.push({
            kind: 'user',
            key: e.turnId ?? e.id,
            text,
            author: name && name !== e.actor?.id && e.actor?.id !== me ? name : null,
            via: e.actor?.via && VIA[e.actor.via],
            at: e.createdAt,
          })
        break
      }
      case 'message.completed': {
        if (d.parentCallId) break
        const text = str(d.text)
        if (!text) break
        const item: Agent = { kind: 'agent', key: e.id, text, at: e.createdAt }
        items.push(item)
        if (e.turnId) turnOf(e).items.push(item)
        break
      }
      case 'tool.started':
      case 'tool.completed':
      case 'tool.failed': {
        // A subagent's steps are its own; other nested calls are not shown.
        const sub = subs.get(str(d.subagentId) ?? '')
        if (!sub && d.parentCallId) break
        const callId = str(d.callId) ?? e.id
        const status = e.type === 'tool.started' ? 'running' : e.type === 'tool.completed' ? 'done' : 'failed'
        let step = steps.get(callId)
        if (step) step.status = status
        else {
          step = { kind: 'step', key: `step-${callId}`, title: str(d.title) ?? str(d.toolName) ?? 'Tool', status }
          steps.set(callId, step)
          if (sub) sub.steps.push(step)
          else work(e, `work-${callId}`).entries.push(step)
        }
        if (sub) {
          if (status === 'running') sub.activity = step.title
          sub.sub = { ...sub.sub, toolCalls: Math.max(sub.sub.toolCalls, sub.steps.length) }
        }
        break
      }
      case 'subagent.started':
      case 'subagent.ended': {
        const a = d.subagent as Subagent | undefined
        if (!a?.id) break
        const seen = subs.get(a.id)
        if (seen) {
          seen.sub = { ...a, toolCalls: Math.max(a.toolCalls ?? 0, seen.steps.length) }
          if (a.status !== 'running') {
            seen.activity = null
            for (const s of seen.steps) if (s.status === 'running') s.status = 'done'
          }
        } else {
          const item: Sub = { kind: 'subagent', key: `sa-${a.id}`, sub: a, steps: [], activity: a.activity ?? null, at: e.createdAt }
          subs.set(a.id, item)
          items.push(item)
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
          const item = { kind: 'ask' as const, key: `ask-${ask.id}`, ask, at: e.createdAt }
          asks.set(ask.id, item)
          items.push(item)
        }
        break
      }
      case 'reasoning.completed': {
        if (d.parentCallId) break
        work(e, `work-${e.id}`).entries.push({ kind: 'thinking', key: e.id, text: str(d.text) ?? '', ms: typeof d.durationMs === 'number' ? d.durationMs : null })
        break
      }
      case 'session.compacted':
        items.push({ kind: 'line', key: e.id, text: 'Context compacted', tone: 'muted', at: e.createdAt })
        break
      case 'track.note': {
        const text = str(d.text)
        if (text) items.push({ kind: 'line', key: e.id, text, tone: 'muted', at: e.createdAt })
        break
      }
      case 'turn.failed': {
        settle(e.turnId, e.createdAt)
        const err = d.error as { message?: unknown } | undefined
        items.push({ kind: 'line', key: e.id, text: str(err?.message) ?? 'The turn failed.', tone: 'error', at: e.createdAt })
        break
      }
      case 'turn.cancelled':
        settle(e.turnId, e.createdAt)
        items.push({ kind: 'line', key: e.id, text: 'Stopped', tone: 'muted', at: e.createdAt })
        break
      case 'turn.completed':
        settle(e.turnId, e.createdAt)
        break
      case 'turn.started':
        turnOf(e).began = e.createdAt
        break
    }
  }
  return items
}

// The person's own messages that no event shows yet: queued here, waiting in
// the session's inbox, or refused by the host (spec 40.2, steps 6 and 7).
export function unsent(events: readonly ApiEvent[], pending: readonly Pending[], inbox: readonly InboxEntry[], sid: string): Item[] {
  const seen = new Set<string>()
  for (const e of events) if (e.type === 'message.received' && e.turnId) seen.add(e.turnId)
  const out: Item[] = []
  const mine = new Set<string>()
  for (const p of pending) {
    if (p.kind === 'session' && p.sessionId === sid) {
      mine.add(p.body.turnId)
      if (!seen.has(p.body.turnId))
        out.push({ kind: 'user', key: p.body.turnId, text: p.body.input, author: null, at: new Date(p.at).toISOString(), state: 'sending' })
    } else if (p.kind === 'turn' && p.sessionId === sid) {
      mine.add(p.turnId)
      if (!seen.has(p.turnId))
        out.push({ kind: 'user', key: p.turnId, text: p.input, author: null, at: new Date(p.at).toISOString(), state: 'sending' })
    }
  }
  for (const i of inbox) {
    if (i.kind !== 'turn' || seen.has(i.id) || mine.has(i.id) || !i.text) continue
    if (i.by.startsWith('agent:') || i.by === 'platform') continue
    out.push({ kind: 'user', key: i.id, text: i.text, author: null, at: i.at, state: i.error ? 'failed' : 'queued', reason: i.error ?? undefined })
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
    if (inThread ? op.sessionId !== where.sessionId : op.trackId !== where.trackId) continue
    if (!op.by.startsWith('agent:') || op.name === 'undo') continue
    const a = op.args as Record<string, string | null | undefined>
    const before = (op.inverse as { args?: Record<string, string> } | null)?.args
    let text: string | null = null
    if (op.name === 'track.create' && inThread) text = op.undoneBy ? 'Was made a track' : `Now in the track **${names.track(String(a.tid))}**`
    else if (op.name === 'thread.place' && inThread)
      text = a.trackId ? `Moved to the track **${names.track(a.trackId)}**` : 'Taken out of its track'
    else if (op.name === 'thread.place' && a.sid) text = `**${names.thread(a.sid)}** joined`
    else if (op.name === 'thread.rename' && before?.title && inThread) text = `Renamed from **${before.title}**`
    else if (op.name === 'track.rename' && before?.name && !inThread) text = `Renamed from **${before.name}**`
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
