import type {
  MutationArgs,
  MutationName,
  Pending,
  PlaceRow,
  SessionRow,
} from '@opencomputer/sdk/computer'
import { Draft, readRow, type Rows } from './rows'

// What each of the person's unconfirmed writes does to the rows, applied
// locally until the feed confirms it (spec 42.2). One function per mutation of
// section 39, shared with nothing on the server: each need only be right for
// what the screen draws.

type Ctx = { me: string; at: number }
type Apply<N extends MutationName> = (
  d: Draft,
  a: MutationArgs[N],
  c: Ctx,
) => void

const closeThread = (
  d: Draft,
  sid: string,
  outcome: string | undefined,
  c: Ctx,
) =>
  d.patch('place', sid, {
    doneAt: c.at,
    outcome: outcome ?? 'done',
    doneBy: c.me,
    earlierAt: c.at,
  })

const dissolveIfEmpty = (d: Draft, tid: string | null) => {
  if (!tid) return
  for (const p of d.all('place')) if (p.trackId === tid) return
  d.delete('track', tid)
  d.delete('doc', tid)
}

const TABLE: { [N in MutationName]: Apply<N> } = {
  'thread.rename': (d, a, c) =>
    d.patch('session', a.sid, { title: a.title, titleBy: c.me }),
  'thread.place': (d, a, c) => {
    const from = d.get('place', a.sid)?.trackId ?? null
    d.patch('place', a.sid, {
      trackId: a.trackId,
      placedBy: c.me,
      position: c.at,
    })
    if (from !== a.trackId) dissolveIfEmpty(d, from)
  },
  'thread.done': (d, a, c) => {
    closeThread(d, a.sid, a.outcome, c)
    for (const p of d.all('proposal'))
      if (p.target === a.sid && p.type === 'done' && p.state === 'open')
        d.patch('proposal', p.id, { state: 'accepted' })
  },
  'thread.reopen': (d, a, c) =>
    d.patch('place', a.sid, {
      doneAt: null,
      outcome: null,
      doneBy: null,
      earlierAt: null,
      broughtBackAt: c.at,
    }),
  'thread.keep': (d, a) =>
    d.patch('place', a.sid, a.keep ? { keep: true, earlierAt: null } : { keep: false }),
  'thread.ready': (d, a) =>
    d.patch('place', a.sid, {
      readySeq: d.get('session', a.sid)?.lastSeq ?? 0,
      readyWhat: a.what,
      readyResult: a.resultId ?? null,
    }),
  'thread.attention': (d, a) => d.patch('place', a.sid, { attention: a.what }),
  'thread.writers': () => {},
  'thread.delete': (d, a) => {
    const tid = d.get('place', a.sid)?.trackId ?? null
    d.delete('session', a.sid)
    d.delete('place', a.sid)
    for (const r of [...d.all('result')])
      if (r.sessionId === a.sid) d.delete('result', r.id)
    dissolveIfEmpty(d, tid)
  },
  'track.create': (d, a, c) => {
    const first = a.sid ? d.get('session', a.sid) : undefined
    d.set({
      kind: 'track',
      id: a.tid,
      version: 0,
      owner: c.me,
      name: a.name ?? first?.title ?? null,
      nameBy: null,
      formerNames: [],
      stand: null,
      standAt: null,
      agentSession: a.agentSessionId,
      position: c.at,
      keep: false,
      doneAt: null,
      outcome: null,
      createdBy: c.me,
    })
    d.set({ kind: 'doc', id: a.tid, version: 0, trackId: a.tid, rev: 0, text: '', spans: [] })
    if (a.sid) d.patch('place', a.sid, { trackId: a.tid, placedBy: c.me })
  },
  'track.rename': (d, a, c) =>
    d.patch('track', a.tid, { name: a.name, nameBy: c.me }),
  'track.set_stand': (d, a, c) =>
    d.patch('track', a.tid, { stand: a.stand, standAt: c.at }),
  'track.done': (d, a, c) => {
    for (const p of [...d.all('place')])
      if (p.trackId === a.tid && !p.doneAt) closeThread(d, p.id, a.outcome, c)
    d.patch('track', a.tid, { doneAt: c.at, outcome: a.outcome ?? 'done' })
    for (const p of d.all('proposal'))
      if (p.target === a.tid && p.type === 'done' && p.state === 'open')
        d.patch('proposal', p.id, { state: 'accepted' })
  },
  'track.reopen': (d, a) =>
    d.patch('track', a.tid, { doneAt: null, outcome: null }),
  'track.keep': (d, a) => d.patch('track', a.tid, { keep: a.keep }),
  'track.dissolve': (d, a) => {
    for (const p of [...d.all('place')])
      if (p.trackId === a.tid) d.patch('place', p.id, { trackId: null })
    d.delete('track', a.tid)
    d.delete('doc', a.tid)
  },
  'track.delete': (d, a) => {
    for (const p of [...d.all('place')])
      if (p.trackId === a.tid) {
        d.delete('place', p.id)
        d.delete('session', p.id)
      }
    d.delete('track', a.tid)
    d.delete('doc', a.tid)
  },
  'read.set': (d, a, c) => {
    const have = readRow((id) => d.get('read', id), c.me, a.sid)
    if (have && have.readSeq >= a.seq) return
    d.set({ kind: 'read', id: have?.id ?? a.sid, version: have?.version ?? 0, member: c.me, sessionId: a.sid, readSeq: a.seq })
  },
  'pref.set': (d, a, c) =>
    d.set({ kind: 'pref', id: `${c.me}:${a.key}`, version: 0, member: c.me, key: a.key, value: a.value }),
  'doc.save': (d, a) =>
    d.patch('doc', a.tid, { rev: a.baseRev + 1, text: a.text, spans: a.spans }),
  'result.add': () => {},
  'review.save': () => {},
  // GitHub merges it; until the feed says so, the chip says it is on its way.
  'result.merge': (d, a, c) => {
    const r = d.get('result', a.resultId)
    if (r) d.patch('result', a.resultId, { pull: { ...r.pull, merging: { by: `user:${c.me}`, at: Date.now(), head: a.head ?? '' } } })
  },
  'result.revert': (d, a, c) => {
    const r = d.get('result', a.resultId)
    if (r) d.patch('result', a.resultId, { pull: { ...r.pull, reverting: { by: `user:${c.me}`, at: Date.now() } } })
  },
  'proposal.create': () => {},
  'proposal.accept': (d, a, c) => {
    const p = d.get('proposal', a.proposalId)
    if (!p || p.state !== 'open') return
    d.patch('proposal', p.id, { state: 'accepted' })
    const args = p.args ?? {}
    if (p.type === 'done') {
      if (d.get('track', p.target)) TABLE['track.done'](d, { tid: p.target }, c)
      else TABLE['thread.done'](d, { sid: p.target }, c)
    } else if (p.type === 'move') {
      TABLE['thread.place'](d, { sid: p.target, trackId: (args.trackId as string) ?? null }, c)
    } else if (p.type === 'edit' && typeof args.text === 'string') {
      const doc = d.get('doc', p.target)
      if (doc) d.patch('doc', doc.id, { text: args.text, rev: doc.rev + 1 })
    }
  },
  'proposal.dismiss': (d, a) =>
    d.patch('proposal', a.proposalId, { state: 'dismissed' }),
  // The inverse is the server's to work out; the op is shown as undone and
  // the rows follow when the feed confirms.
  undo: (d, a, c) => d.patch('op', a.opId, { undoneBy: c.me }),
}

const newSession = (p: Extract<Pending, { kind: 'session' }>, me: string): [SessionRow, PlaceRow] => {
  const at = new Date(p.at).toISOString()
  return [
    {
      kind: 'session',
      id: p.sessionId,
      version: 0,
      title: (p.body.input ?? '').slice(0, 80),
      status: 'starting',
      archived: false,
      owner: { id: me, name: '', email: null },
      origin: { type: 'dashboard', client: null, slack: null },
      // No mode asked for runs with full access: the server's default, as the feed will say.
      settings: { model: p.body.model ?? null, effort: p.body.effort ?? null, mode: p.body.mode ?? 'bypassPermissions', speed: null },
      metadata: {},
      activeTurnId: null,
      queued: [],
      asks: [],
      subagents: [],
      lastTurn: null,
      lastText: null,
      context: { usedTokens: null, windowTokens: null },
      lastSeq: 0,
      logEpoch: 0,
      epochStartSeq: 0,
      createdAt: at,
      lastActiveAt: at,
      syncedAt: null,
      urls: { dashboard: null },
      titleBy: null,
      agentTitle: null,
      lastAgentSeq: 0,
      blocked: false,
      inbox: [],
      machine: '',
      role: p.body.role ?? null,
    },
    {
      kind: 'place',
      id: p.sessionId,
      version: 0,
      sessionId: p.sessionId,
      trackId: p.body.trackId ?? null,
      position: p.at,
      placedBy: me,
      parentSession: null,
      doneAt: null,
      outcome: null,
      doneBy: null,
      keep: false,
      broughtBackAt: null,
      earlierAt: null,
      readySeq: null,
      readyWhat: null,
      readyResult: null,
      attention: null,
    },
  ]
}

export function overlay(rows: Rows, pending: Pending[], me: string): Rows {
  if (!pending.length) return rows
  const d = new Draft(rows)
  for (const p of pending) {
    const c = { me, at: p.at }
    if (p.kind === 'mutation') {
      const apply = TABLE[p.name] as Apply<MutationName> | undefined
      apply?.(d, p.args as never, c)
    } else if (p.kind === 'session') {
      if (!d.get('session', p.sessionId)) {
        const [s, place] = newSession(p, me)
        d.set(s)
        d.set(place)
      }
    } else if (p.kind === 'turn') {
      // A reply returns a thread to Working (T7) and clears what was waiting.
      const s = d.get('session', p.sessionId)
      if (s && s.status !== 'running' && s.status !== 'starting')
        d.patch('session', s.id, { status: 'running' })
      const place = d.get('place', p.sessionId)
      if (place?.doneAt || place?.earlierAt || place?.attention)
        d.patch('place', place.id, { doneAt: null, outcome: null, doneBy: null, earlierAt: null, attention: null })
    } else if (p.kind === 'answer' || p.kind === 'dismiss') {
      const s = d.get('session', p.sessionId)
      if (s) {
        const asks = s.asks.filter((a) => a.id !== p.askId)
        d.patch('session', s.id, {
          asks,
          blocked: asks.some((a) => a.status === 'open') || !!d.get('place', s.id)?.attention,
          status: p.kind === 'answer' ? 'running' : s.status,
        })
      }
    } else if (p.kind === 'settings') {
      const s = d.get('session', p.sessionId)
      if (s) d.patch('session', s.id, { settings: { ...s.settings, ...p.settings } })
    } else if (p.kind === 'interrupt') {
      const s = d.get('session', p.sessionId)
      if (s && (s.status === 'running' || s.status === 'starting'))
        d.patch('session', s.id, { status: 'idle' })
    }
  }
  return d.done()
}
