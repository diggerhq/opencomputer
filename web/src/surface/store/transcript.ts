import type { ApiEvent, Ask, AttachmentRef, InboxEntry, OpRow, Pending, PendingAttachment, Subagent } from '@opencomputer/sdk/computer'

// Folds a session's events into what a conversation shows: people's messages,
// the agent's replies, its steps as single lines, its asks, and the subagents
// it launched with their own steps. Types it does
// not know are skipped, as the API asks of every client.

// Where a message was written, when it was not here.
const VIA: Record<string, string> = { slack: 'Slack', opc: 'CLI', api: 'API' }

// A file of a person's message (work 126): what the event says of it, or, while
// the message is still being sent, how far its upload is.
export type ItemAttachment = AttachmentRef & { progress?: number; upload?: PendingAttachment['state']; error?: string }

export type Item =
  | {
      kind: 'user'
      key: string
      text: string
      author: string | null
      via?: string
      at: string
      state?: Delivery
      reason?: string
      behind?: Behind
      attachments?: ItemAttachment[]
    }
  // `streaming`: still being written; its key is the one it keeps once whole.
  | { kind: 'agent'; key: string; text: string; at: string; streaming?: boolean }
  // A turn's work: its steps, thinking and earlier messages, in order, drawn
  // as one line before its latest message (see buildTranscript).
  | { kind: 'work'; key: string; entries: Entry[]; settled: boolean; ms: number | null; at: string }
  | { kind: 'ask'; key: string; ask: Ask; at: string }
  // A subagent, where it was launched: its latest state, and its steps so far.
  // `activity`: what it is doing now, while it runs.
  | { kind: 'subagent'; key: string; sub: Subagent; steps: Step[]; activity: string | null; at: string }
  // A line that is not a message: a structural change, "Stopped", a failure.
  | { kind: 'line'; key: string; text: string; tone: 'muted' | 'error'; at: string; undo?: string; undone?: boolean }
  // A track's threads, where they joined it, drawn as one group of rows. `ids`:
  // their session ids, comma-joined, so an unchanged group compares equal.
  | { kind: 'threads'; key: string; ids: string; at: string }

// Where the person's own message is on its way to the agent (work 134). No
// state: the agent has read it, and it is drawn where it did.
// `sending`: not yet accepted. `queued`: accepted, the machine not yet up.
// `waiting` (the server's `delivery: 'steered'`): with the running turn, read
// at its next step. `next` (`delivery: 'queued'`): read when the running turn ends. `failed`: refused, with the reason.
export type Delivery = 'sending' | 'queued' | 'waiting' | 'next' | 'failed'

// What a waiting message waits behind: the step running longest, and since when.
export type Behind = { title: string; since: string }

export type Step = { kind: 'step'; key: string; title: string; status: 'running' | 'done' | 'failed' }

// `text` of thinking is empty when the model hid it.
export type Entry = Step | { kind: 'thinking'; key: string; text: string; ms: number | null } | { kind: 'text'; key: string; text: string }

// The failed steps that still mean something (work 147): those no later step
// in the same block got past. Most failures are an agent's trial and error (a
// search that found nothing, a missing file, a test fixed on the next try),
// and a step that succeeds after them says the agent moved on. The same rule
// holds while the block runs and once it ends, so settling changes nothing.
export function failuresThatMatter(entries: readonly Entry[]): Set<Step> {
  const out = new Set<Step>()
  let passed = false
  for (let i = entries.length - 1; i >= 0; i--) {
    const en = entries[i]
    if (en.kind !== 'step') continue
    if (en.status === 'done') passed = true
    else if (en.status === 'failed' && !passed) out.add(en)
  }
  return out
}

export type OpenBlock = { blockId: string; type: string; turnId: string; text: string }

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

const withoutSlackHeader = (text: string | null): string | null =>
  text && text.replace(/^\[Slack: from [^\n]*\]\n?/gm, '').trim()

// One rule for what a turn shows (work 133): its latest message is the answer
// and stays in view, in place, from its first streamed token; everything else
// it does (steps, thinking, the messages before that one) is work, drawn as one
// line before it. A turn is laid out this way from its start, so nothing it
// does later moves what is drawn: a new message takes its predecessor's place,
// which folds into the line, and the turn's end only settles the line.
// Something else between (an ask, a subagent) closes the turn's segment, so
// what the agent said before it stays beside it, and a new segment begins.
//
// `me`: the person looking. `open`: the text still streaming, drawn as the
// message it will become, under the same key.
export function buildTranscript(events: readonly ApiEvent[], me?: string, open?: OpenBlock | null): Item[] {
  const items: Item[] = []
  const steps = new Map<string, Step>()
  type Work = Extract<Item, { kind: 'work' }>
  type Agent = Extract<Item, { kind: 'agent' }>
  // A run of a turn's own items: its work line and its latest message, with
  // how much work came before that message, where it folds in.
  type Segment = { work: Work | null; agent: Agent | null; said: number; began: string; end: string }
  const turns = new Map<string, { segments: Segment[]; began: string; settled: boolean }>()
  const asks = new Map<string, Extract<Item, { kind: 'ask' }>>()
  type Sub = Extract<Item, { kind: 'subagent' }>
  const subs = new Map<string, Sub>()
  // The person's messages the agent has not read yet (work 134): a steer
  // until `turn.steered` names its seq or its turn ends, a queued message
  // until its own turn starts. Each is drawn where it was read.
  type User = Extract<Item, { kind: 'user' }>
  const unread: { item: User; seq: number; turnId: string; queued: boolean }[] = []
  const read = (match: (u: (typeof unread)[number]) => boolean, at: string) => {
    for (let i = 0; i < unread.length; ) {
      if (!match(unread[i])) {
        i++
        continue
      }
      items.push({ ...unread[i].item, at })
      unread.splice(i, 1)
    }
  }
  // Steps running in each turn, by when they began, for what a steer waits behind.
  const running = new Map<string, { title: string; since: string; turnId: string }>()
  const turnOf = (id: string, at: string) => {
    let t = turns.get(id)
    if (!t) turns.set(id, (t = { segments: [], began: at, settled: false }))
    return t
  }
  // The turn's open segment: its last, while nothing else has been drawn after it.
  const segment = (id: string, at: string): Segment => {
    const t = turnOf(id, at)
    const seg = t.segments[t.segments.length - 1]
    const tail = items[items.length - 1]
    if (seg && tail && (tail === seg.agent || tail === seg.work)) return seg
    const next: Segment = { work: null, agent: null, said: 0, began: at, end: at }
    t.segments.push(next)
    return next
  }
  const newWork = (key: string, at: string): Work => ({ kind: 'work', key, entries: [], settled: false, ms: null, at })
  // The segment's work line, made before its message if it has none.
  const workOf = (seg: Segment, key: string, at: string): Work => {
    if (seg.work) return seg.work
    seg.work = newWork(key, at)
    const i = seg.agent ? items.indexOf(seg.agent) : items.length
    items.splice(i, 0, seg.work)
    return seg.work
  }
  const addEntry = (e: ApiEvent, key: string, entry: Entry) => {
    const seg = segment(e.turnId ?? '', e.createdAt)
    workOf(seg, key, e.createdAt).entries.push(entry)
    seg.end = e.createdAt
  }
  // A message: the segment's latest, in its predecessor's place, which folds into the work line.
  const say = (turnId: string, msg: Agent) => {
    const seg = segment(turnId, msg.at)
    const was = seg.agent
    if (was) {
      workOf(seg, `work-${was.key}`, was.at).entries.splice(seg.said, 0, { kind: 'text', key: was.key, text: was.text })
      items[items.indexOf(was)] = msg
    } else items.push(msg)
    seg.agent = msg
    seg.said = seg.work?.entries.length ?? 0
    seg.end = msg.at
  }
  const settle = (turnId: string | null | undefined, at: string) => {
    const t = turns.get(turnId ?? '')
    if (!t || t.settled) return
    t.settled = true
    t.segments.forEach((seg, i) => {
      const w = seg.work
      if (!w) return
      // A line reserved at the turn's start that nothing came to.
      if (!w.entries.length) {
        items.splice(items.indexOf(w), 1)
        return
      }
      w.settled = true
      for (const en of w.entries) if (en.kind === 'step' && en.status === 'running') en.status = 'done'
      w.ms = Date.parse(seg.end === seg.began ? at : seg.end) - Date.parse(i === 0 ? t.began : seg.began)
    })
  }
  for (const e of events) {
    const d = (e.data ?? {}) as Record<string, unknown>
    switch (e.type) {
      case 'message.received': {
        // Input the platform writes is not drawn as a message (R15).
        if (e.actor?.via === 'platform' || e.actor?.id === 'platform') break
        const text = withoutSlackHeader(str(d.input)) ?? ''
        // The event's own array is kept: an unchanged item compares equal by field.
        const attachments = Array.isArray(d.attachments) && d.attachments.length ? (d.attachments as ItemAttachment[]) : undefined
        // Journals before the computer stopped using the git author name carry " via Computer".
        const name = e.actor?.name?.replace(/ via Computer$/, '')
        if (!text && !attachments) break
        // What a track's agent passes to a thread is a marked line, not the person speaking (G4).
        if (e.actor?.via === 'agent') {
          if (text) items.push({ kind: 'line', key: messageKey(e), text, tone: 'muted', at: e.createdAt })
        } else {
          const item: User = {
            kind: 'user',
            key: messageKey(e),
            text,
            author: name && name !== e.actor?.id && e.actor?.id !== me ? name : null,
            via: e.actor?.via && VIA[e.actor.via],
            at: e.createdAt,
            ...(attachments && { attachments }),
          }
          const delivery = str(d.delivery)
          if ((delivery === 'steered' || delivery === 'queued') && e.turnId && !turns.get(e.turnId)?.settled)
            unread.push({ item, seq: e.seq, turnId: e.turnId, queued: delivery === 'queued' })
          else items.push(item)
        }
        break
      }
      case 'message.completed': {
        if (d.parentCallId) break
        const text = str(d.text)
        if (!text) break
        const item: Agent = { kind: 'agent', key: str(d.blockId) ?? e.id, text, at: e.createdAt }
        if (e.turnId && !turns.get(e.turnId)?.settled) say(e.turnId, item)
        else items.push(item)
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
        if (!sub && status === 'running') running.set(callId, { title: str(d.title) ?? str(d.toolName) ?? 'Tool', since: e.createdAt, turnId: e.turnId ?? '' })
        else running.delete(callId)
        let step = steps.get(callId)
        if (step) step.status = status
        else {
          step = { kind: 'step', key: `step-${callId}`, title: str(d.title) ?? str(d.toolName) ?? 'Tool', status }
          steps.set(callId, step)
          if (sub) sub.steps.push(step)
          else addEntry(e, `work-${callId}`, step)
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
        addEntry(e, `work-${e.id}`, { kind: 'thinking', key: e.id, text: str(d.text) ?? '', ms: typeof d.durationMs === 'number' ? d.durationMs : null })
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
        // Steers its turn did not take start the next one.
        read((u) => !u.queued && u.turnId === e.turnId, e.createdAt)
        break
      }
      case 'turn.cancelled':
        settle(e.turnId, e.createdAt)
        // A queued message whose turn is withdrawn before it starts comes
        // first; steers the stopped turn did not take start the next one.
        read((u) => u.queued && u.turnId === e.turnId, e.createdAt)
        items.push({ kind: 'line', key: e.id, text: 'Stopped', tone: 'muted', at: e.createdAt })
        read((u) => u.turnId === e.turnId, e.createdAt)
        break
      case 'turn.completed':
        settle(e.turnId, e.createdAt)
        read((u) => !u.queued && u.turnId === e.turnId, e.createdAt)
        break
      case 'turn.steered': {
        const seq = d.messageSeq
        read((u) => u.seq === seq, e.createdAt)
        break
      }
      case 'turn.started': {
        const id = e.turnId ?? ''
        read((u) => u.queued && u.turnId === id, e.createdAt)
        const t = turnOf(id, e.createdAt)
        t.began = e.createdAt
        // The turn's work line is drawn from its start, so what comes later does not move it.
        if (!t.settled) workOf(segment(id, e.createdAt), `work-${id}`, e.createdAt)
        break
      }
    }
  }
  // The text streaming: the message it will be, under the key it will have.
  if (open?.text && !turns.get(open.turnId)?.settled && !items.some((i) => i.key === open.blockId)) {
    const last = events[events.length - 1]
    say(open.turnId, { kind: 'agent', key: open.blockId, text: open.text, at: last?.createdAt ?? new Date(0).toISOString(), streaming: true })
  }
  // Not read yet: last, with where each waits.
  for (const u of unread) {
    let behind: Behind | undefined
    if (!u.queued)
      for (const r of running.values()) if (r.turnId === u.turnId && (!behind || r.since < behind.since)) behind = { title: r.title, since: r.since }
    items.push({ ...u.item, state: u.queued ? 'next' : 'waiting', ...(behind ? { behind } : {}) })
  }
  return items
}

// The id the sender gave a message. A steer joins the running turn, so its
// turnId is that turn's and its own id is messageId: two messages in one turn
// must not share a key.
const messageKey = (e: ApiEvent): string => {
  const id = (e.data as { messageId?: unknown } | undefined)?.messageId
  return typeof id === 'string' ? id : (e.turnId ?? e.id)
}

// The person's own messages that no event shows yet: queued here, waiting in
// the session's inbox, or refused by the host (spec 40.2, steps 6 and 7).
// `attachments`: the client's pending files, for how far a message's uploads are.
export function unsent(
  events: readonly ApiEvent[],
  pending: readonly Pending[],
  inbox: readonly InboxEntry[],
  sid: string,
  attachments: readonly PendingAttachment[] = [],
): Item[] {
  const seen = new Set<string>()
  for (const e of events) if (e.type === 'message.received') seen.add(messageKey(e))
  const out: Item[] = []
  const mine = new Set<string>()
  const files = (ids: string[] | undefined): Pick<Item & { kind: 'user' }, 'attachments'> => {
    if (!ids?.length) return {}
    const held = new Map(attachments.map((a) => [a.id, a]))
    return {
      attachments: ids.map((id) => {
        const a = held.get(id)
        return a
          ? { id, name: a.name, mimetype: a.mimetype, bytes: a.bytes, progress: a.progress, upload: a.state, error: a.error?.reason }
          : { id, name: 'file', mimetype: '', bytes: 0 }
      }),
    }
  }
  for (const p of pending) {
    if (p.kind === 'session' && p.sessionId === sid) {
      // Created without a message (files go first): nothing of the person's to show.
      if (!p.body.turnId || p.body.input === undefined) continue
      mine.add(p.body.turnId)
      if (!seen.has(p.body.turnId))
        out.push({ kind: 'user', key: p.body.turnId, text: p.body.input, author: null, at: new Date(p.at).toISOString(), state: 'sending', ...files(p.body.attachments) })
    } else if (p.kind === 'turn' && p.sessionId === sid) {
      mine.add(p.turnId)
      if (!seen.has(p.turnId))
        out.push({ kind: 'user', key: p.turnId, text: p.input, author: null, at: new Date(p.at).toISOString(), state: 'sending', ...files(p.attachments) })
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
  names: { track(id: string): string; thread(id: string): string; me?: string },
): Item[] {
  const out: Item[] = []
  const inThread = 'sessionId' in where
  for (const op of ops) {
    if (inThread ? op.sessionId !== where.sessionId : op.trackId !== where.trackId) continue
    // A person's merge of a pull request, and its revert (work 118): GitHub's, so said whoever did it.
    if ((op.name === 'result.merge' || op.name === 'result.revert') && inThread) {
      const m = op.args as { number?: number; base?: string; method?: string | null; branchDeleted?: boolean }
      const who = op.by === names.me ? 'You' : op.by.startsWith('agent:') ? 'The agent' : 'A teammate'
      const how = m.method === 'squash' ? ' · squashed' : m.method === 'rebase' ? ' · rebased' : ''
      const merged = op.name === 'result.merge'
      out.push({
        kind: 'line',
        key: op.id,
        text: merged
          ? `${who} merged #${m.number} into **${m.base}**${how}${m.branchDeleted ? ' · branch deleted' : ''}`
          : `${who} reverted it with #${m.number}`,
        tone: 'muted',
        at: new Date(op.at).toISOString(),
        undo: merged && !op.undoneBy ? op.id : undefined,
        undone: merged && !!op.undoneBy,
      })
      continue
    }
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
