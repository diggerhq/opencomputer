import type {
  Ask,
  PlaceRow,
  ProposalRow,
  ResultRow,
  SessionRow,
  TrackRow,
} from '@opencomputer/sdk/computer'
import { readRow, type Rows } from './rows'

// What the screen reads, derived from the rows: the marks of spec section 3
// and a track's mark (R10). Everything here is a pure function of the rows,
// cached on their identity.

export type Mark = 'blocked' | 'ready' | 'working' | null

export interface ThreadView {
  id: string
  title: string
  mark: Mark
  // Something the person has not seen: the name is bold (R6).
  unread: boolean
  // 'working' | 'blocked on you' | 'ready for you' | ''.
  word: string
  // One line of where it is, for its card in the track.
  line: string | null
  // What a thread that has not begun waits on (its machine starting), else null.
  waiting: string | null
  trackId: string | null
  done: boolean
  outcome: string | null
  earlier: boolean
  keep: boolean
  position: number
  lastSeq: number
  results: ResultRow[]
  // The oldest open ask, and what the agent says it needs.
  ask: Ask | null
  attention: string | null
  // Open proposals on this thread (done, move).
  proposals: ProposalRow[]
  // The result the ring is on (R20).
  readyResult: string | null
  session: SessionRow
  place: PlaceRow
}

export interface TrackView {
  id: string
  name: string
  stand: string | null
  mark: Mark
  unread: boolean
  threads: ThreadView[]
  // Its threads under Earlier that the feed holds.
  earlierThreads: ThreadView[]
  earlier: number
  agentSession: string
  agent: SessionRow | undefined
  done: boolean
  keep: boolean
  proposals: ProposalRow[]
  track: TrackRow
}

export interface ListView {
  tracks: TrackView[]
  threads: ThreadView[]
  earlierThreads: ThreadView[]
  earlierTracks: TrackView[]
  earlier: number
  blocked: number
}

const RANK = { blocked: 3, ready: 2, working: 1 } as const
const rank = (m: Mark) => (m ? RANK[m] : 0)
export const strongest = (marks: Mark[]): Mark =>
  marks.reduce<Mark>((a, b) => (rank(b) > rank(a) ? b : a), null)

const WORD: Record<string, string> = {
  working: 'working',
  blocked: 'blocked on you',
  ready: 'ready for you',
}

// A thread that has not begun waits on its machine: say so while the machine is not up, or a
// brand-new organization's first message (minutes of provisioning) looks like nothing happening.
const MACHINE_LINE: Record<string, string> = {
  provisioning: 'Setting up your computer: the first start takes a few minutes',
  waking: 'Waking your computer',
  failed: 'Your computer could not start',
  deleting: 'Your computer is being deleted',
}

export function machineLine(rows: Rows, session: SessionRow): string | null {
  if (session.status !== 'starting' || session.lastSeq > 0) return null
  // An optimistic row does not know its machine yet; an organization has one.
  const machine = rows.machine.get(session.machine) ?? (rows.machine.size === 1 ? rows.machine.values().next().value : undefined)
  return machine ? (MACHINE_LINE[machine.state] ?? null) : null
}

const firstLine = (s: string | null | undefined) =>
  s ? (s.split('\n').find((l) => l.trim()) ?? null) : null

export const askLine = (ask: Ask): string => {
  if (ask.kind === 'approval') {
    const a = ask.approval ?? {}
    return String(a.title ?? a.command ?? a.toolName ?? 'Needs your OK')
  }
  if (ask.kind === 'question') {
    const qs = (ask.question?.questions ?? []) as { text?: string }[]
    return qs[0]?.text ?? 'Has a question'
  }
  return 'Needs a secret'
}

type Index = {
  results: Map<string, ResultRow[]>
  proposals: Map<string, ProposalRow[]>
  byTrack: Map<string | null, PlaceRow[]>
}
const indexes = new WeakMap<object, Index>()

function index(rows: Rows): Index {
  let ix = indexes.get(rows)
  if (ix) return ix
  ix = { results: new Map(), proposals: new Map(), byTrack: new Map() }
  const push = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
    const l = m.get(k)
    if (l) l.push(v)
    else m.set(k, [v])
  }
  for (const r of rows.result.values()) push(ix.results, r.sessionId, r)
  for (const p of rows.proposal.values())
    if (p.state === 'open') push(ix.proposals, p.target, p)
  for (const p of rows.place.values()) push(ix.byTrack, p.trackId, p)
  for (const l of ix.byTrack.values()) l.sort((a, b) => b.position - a.position || (a.id < b.id ? 1 : -1))
  indexes.set(rows, ix)
  return ix
}

const NONE: never[] = []
const threadCache = new WeakMap<SessionRow, { key: unknown[]; view: ThreadView }>()

export function threadView(rows: Rows, me: string, sid: string): ThreadView | undefined {
  const session = rows.session.get(sid)
  const place = rows.place.get(sid)
  if (!session || !place) return undefined
  const ix = index(rows)
  const read = readRow((id) => rows.read.get(id), me, sid)
  const results = ix.results.get(sid) ?? NONE
  const proposals = ix.proposals.get(sid) ?? NONE
  const key = [place, read, rows.result, rows.proposal, rows.machine]
  const hit = threadCache.get(session)
  if (hit && hit.key.every((k, i) => k === key[i])) return hit.view

  const readSeq = read?.readSeq ?? 0
  const working = session.status === 'running' || session.status === 'starting'
  // Opening a thread clears the ring of a done proposal (R7); a suggestion's stays until answered (A5).
  const ready =
    (place.readySeq ?? -1) > readSeq || proposals.some((p) => p.type !== 'done' || (p.atSeq ?? -1) > readSeq)
  const mark: Mark = session.blocked ? 'blocked' : working ? 'working' : ready ? 'ready' : null
  const ask = session.asks.find((a) => a.status === 'open') ?? null
  const waiting = machineLine(rows, session)
  const view: ThreadView = {
    id: sid,
    title: session.title || 'New thread',
    mark,
    unread: session.lastAgentSeq > readSeq,
    word: mark ? WORD[mark] : '',
    line:
      place.attention ??
      (ask ? askLine(ask) : null) ??
      (session.lastTurn?.status === 'failed' ? (session.lastTurn.error?.message ?? 'The turn failed') : null) ??
      (ready ? place.readyWhat : null) ??
      waiting ??
      firstLine(session.lastText),
    waiting,
    trackId: place.trackId,
    done: place.doneAt !== null,
    outcome: place.outcome,
    earlier: place.earlierAt !== null,
    keep: place.keep,
    position: place.position,
    lastSeq: session.lastSeq,
    results,
    ask,
    attention: place.attention,
    proposals,
    readyResult: ready ? place.readyResult : null,
    session,
    place,
  }
  threadCache.set(session, { key, view })
  return view
}

function trackView(rows: Rows, me: string, track: TrackRow, open: string | null, trackEarlier: number): TrackView {
  const ix = index(rows)
  const threads: ThreadView[] = []
  const earlierThreads: ThreadView[] = []
  for (const p of ix.byTrack.get(track.id) ?? NONE) {
    const t = threadView(rows, me, p.id)
    if (!t) continue
    // A thread that is open stays in the list whatever its age says (R24).
    if (t.earlier && t.id !== open) earlierThreads.push(t)
    else threads.push(t)
  }
  const agent = rows.session.get(track.agentSession)
  const proposals = ix.proposals.get(track.id) ?? NONE
  const own: Mark = agent?.blocked
    ? 'blocked'
    : proposals.length
      ? 'ready'
      : agent && (agent.status === 'running' || agent.status === 'starting') && !threads.length
        ? 'working'
        : null
  const mark = strongest([own, ...threads.map((t) => t.mark)])
  const lead = threads.find((t) => t.mark === mark) ?? threads[0]
  return {
    id: track.id,
    name: track.name || 'New track',
    stand: track.stand || lead?.line || null,
    mark,
    unread: threads.some((t) => t.unread),
    threads,
    earlierThreads,
    earlier: earlierThreads.length + trackEarlier,
    agentSession: track.agentSession,
    agent,
    done: track.doneAt !== null,
    keep: track.keep,
    proposals,
    track,
  }
}

export type Counts = { earlier: number; trackEarlier: Record<string, number> }

let lastList: { rows: Rows; me: string; open: string | null; counts: Counts; view: ListView } | null = null

export function listView(rows: Rows, me: string, open: string | null, counts: Counts): ListView {
  if (lastList && lastList.rows === rows && lastList.me === me && lastList.open === open && lastList.counts === counts)
    return lastList.view
  const ix = index(rows)
  const tracks: TrackView[] = []
  const earlierTracks: TrackView[] = []
  for (const t of rows.track.values()) {
    if (t.owner !== me) continue
    const v = trackView(rows, me, t, open, counts.trackEarlier[t.id] ?? 0)
    if (v.done) earlierTracks.push(v)
    else tracks.push(v)
  }
  tracks.sort((a, b) => b.track.position - a.track.position)
  const threads: ThreadView[] = []
  const earlierThreads: ThreadView[] = []
  for (const p of ix.byTrack.get(null) ?? NONE) {
    const t = threadView(rows, me, p.id)
    if (!t || t.session.owner.id !== me || t.session.role === 'track') continue
    if (t.earlier && t.id !== open) earlierThreads.push(t)
    else threads.push(t)
  }
  let blocked = 0
  for (const t of threads) if (t.mark === 'blocked') blocked++
  for (const k of tracks) {
    for (const t of k.threads) if (t.mark === 'blocked') blocked++
    if (k.agent?.blocked) blocked++
  }
  const view: ListView = {
    tracks,
    threads,
    earlierThreads,
    earlierTracks,
    earlier: counts.earlier + earlierThreads.length + earlierTracks.length,
    blocked,
  }
  lastList = { rows, me, open, counts, view }
  return view
}

export function findTrack(list: ListView, id: string | null): TrackView | undefined {
  if (!id) return undefined
  return list.tracks.find((t) => t.id === id) ?? list.earlierTracks.find((t) => t.id === id)
}
