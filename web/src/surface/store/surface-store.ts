import { createStore, type StoreApi } from 'zustand/vanilla'
import {
  makeId,
  Refused,
  type Answer,
  type Failure,
  type FeedFrame,
  type MutationArgs,
  type MutationName,
  type Pending,
  type ResultRow,
  type Row,
  type SettingsPatch,
} from '@opencomputer/sdk/computer'
import type { Location } from '../host'
import { NOWHERE } from '../host'
import { blockedIn } from './blocked'
import { watchConversations } from './conversations'
import { saveMerged } from './doc-save'
import { OUT_OF_CREDITS, sayFailure, whatFailed } from './failure-text'
import { hurriedClient } from './hurried-client'
import { overlay } from './overlay'
import { pageWake } from './page-wake'
import { serverReads } from './server-reads'
import { readRow, applyFrame, Draft, emptyRows, type Rows } from './rows'
import { KEPT, NO_COUNTS, type Kept, type Layout, type State, type SurfaceOptions, type Theme, type Toast, type TrackTab } from './surface-state'
import { listView, threadView, type Counts, type ListView } from './views'

// The surface's one store (spec 26.2): what the server last said, the
// person's unconfirmed writes replayed on top, and what is open on screen.
// Components read it through selectors and never await.

function without<T>(r: Record<string, T>, key: string): Record<string, T> {
  const next = { ...r }
  delete next[key]
  return next
}

export type Surface = ReturnType<typeof createSurface>

export function createSurface(o: SurfaceOptions) {
  const { host } = o
  const me = host.principal.subject
  const { client, hurry } = hurriedClient(host, o.storage)

  let kept: Partial<Kept> = {}
  try {
    kept = JSON.parse(o.kept?.get() ?? '{}') as Partial<Kept>
  } catch {
    // A cache that does not parse is dropped.
  }
  const here = host.location.get()
  const somewhere = here.thread || here.track || here.start

  const store: StoreApi<State> = createStore<State>(() => ({
    me,
    ready: false,
    synced: false,
    status: 'connecting',
    base: emptyRows(),
    rows: emptyRows(),
    pending: [],
    counts: NO_COUNTS,
    convos: {},
    toasts: [],
    palette: false,
    keysSheet: false,
    earlierNext: {},
    missing: {},
    unopened: {},
    layout: {},
    trackTab: {},
    listHidden: false,
    openTracks: {},
    earlierOpen: false,
    trackEarlierOpen: {},
    drafts: {},
    theme: 'system',
    reviewMode: 'summary',
    ...kept,
    loc: somewhere ? here : (kept.loc ?? NOWHERE),
  }))
  const get = store.getState
  const set = store.setState

  // ---- rows ----

  // Rows read by query (Earlier's pages, search): beneath the feed's.
  let under: Rows = emptyRows()
  const answered = new Map<string, Extract<Pending, { kind: 'answer' | 'dismiss' }>>()
  const compose = (base: Rows, pending: Pending[]): Rows => {
    const d = new Draft(base)
    for (const kind of ['session', 'place', 'track', 'result'] as const)
      for (const row of under[kind].values()) {
        const have = d.get(kind, row.id)
        if (!have || have.version < row.version) d.set(row)
      }
    // An answer leaves `pending` on its 2xx reply, which can come before the
    // feed's row: until that row says the ask is closed the answer stays on
    // top, so the dot does not come back and is not announced again.
    for (const p of pending) if (p.kind === 'answer' || p.kind === 'dismiss') answered.set(p.key, p)
    const held: Pending[] = []
    for (const [key, p] of answered) {
      if (pending.some((x) => x.key === key)) continue
      if (base.session.get(p.sessionId)?.asks.some((x) => x.id === p.askId && x.status === 'open')) held.push(p)
      else answered.delete(key)
    }
    return overlay(d.done(), held.length ? [...pending, ...held] : pending, me)
  }
  const recompose = (change: Partial<State> = {}) => {
    const s = { ...get(), ...change }
    set({ ...change, rows: compose(s.base, s.pending) })
    after()
  }
  // The server counts every thread under Earlier; the ones read by query are
  // then held as rows too, so the count shown leaves those out.
  let served = NO_COUNTS
  const counted = (base: Rows): Counts => {
    const c: Counts = { earlier: served.earlier, trackEarlier: { ...served.trackEarlier } }
    for (const p of under.place.values()) {
      if (p.earlierAt === null || base.place.has(p.id)) continue
      if (p.trackId) c.trackEarlier[p.trackId] = Math.max(0, (c.trackEarlier[p.trackId] ?? 0) - 1)
      else c.earlier = Math.max(0, c.earlier - 1)
    }
    return c
  }
  const addUnder = (rows: Row[]) => {
    const d = new Draft(under)
    for (const row of rows) d.set(row)
    under = d.done()
    recompose({ counts: counted(get().base) })
    for (const sid of watching.keys()) begin(sid)
  }
  // The server holds this session: in the feed, or read by query.
  const onServer = (sid: string) => get().base.session.has(sid) || under.session.has(sid)

  const stops: (() => void)[] = []
  const onFrame = (frame: FeedFrame) => {
    const s = get()
    // The pending copies this frame confirms have already left `pending()`
    // (the SDK drops them in the same step), so one set shows neither twice.
    const base = applyFrame(s.base, frame)
    if (frame.counts) served = frame.counts
    set({
      base,
      pending: client.pending().get(),
      counts: frame.counts ? counted(base) : s.counts,
      synced: s.synced || s.status === 'online',
    })
    for (const sid of watching.keys()) begin(sid)
    recompose()
  }

  // ---- what follows a change: reading, notifying, staying somewhere real ----

  let blockedBefore: Set<string> | null = null
  const list = (): ListView => {
    const s = get()
    return listView(s.rows, me, s.loc.thread, s.counts)
  }
  const visible = o.visible ?? (() => typeof document === 'undefined' || document.visibilityState === 'visible')

  function after() {
    const s = get()
    if (!s.ready) return
    // Opening a thread reads it (R7): the bold and the ring clear.
    const sid = s.loc.thread
    if (sid && visible() && !s.loc.result) {
      const row = s.rows.session.get(sid)
      const read = readRow((id) => s.rows.read.get(id), me, sid)?.readSeq ?? 0
      if (row && row.lastSeq > read && onServer(sid)) mutate('read.set', { sid, seq: row.lastSeq })
    }
    // An agent wrapped the open thread in a new track (J3): its row stays in sight.
    const around = sid ? s.rows.place.get(sid)?.trackId : null
    if (around && s.openTracks[around] === undefined) set({ openTracks: { ...s.openTracks, [around]: true } })
    if (sid && s.rows.session.has(sid)) shown.add(sid)
    // The thread that was open is gone: a start-box thread that became a track
    // lands on the track (J5), anything else on the start box. One a link named
    // and the feed does not hold is read by itself; one the server does not
    // have is shown as not found.
    if (sid && s.synced && !s.rows.session.has(sid)) {
      let track: string | null = null
      for (const t of s.rows.track.values()) if (t.createdBy === `agent:${sid}`) track = t.id
      if (track || shown.has(sid)) go({ ...NOWHERE, track, start: !track }, { replace: true })
      else lookUp(sid)
    } else if (!sid && s.loc.track && s.synced && !s.rows.track.has(s.loc.track)) {
      go({ ...NOWHERE, start: true }, { replace: true })
    }
    // Only a new block is announced outside the app (R27).
    const l = list()
    const now = blockedIn(l)
    if (blockedBefore && s.synced)
      for (const [id, b] of now)
        if (!blockedBefore.has(id))
          host.notify({
            threadId: id,
            askId: b.askId,
            title: b.title,
            body: b.body,
            choices: b.approval
              ? [
                  { id: 'allow', label: 'Allow' },
                  { id: 'deny', label: 'Deny' },
                ]
              : undefined,
          })
    if (!blockedBefore || blockedBefore.size !== now.size) host.badge(now.size)
    blockedBefore = new Set(now.keys())
  }

  // Threads that were on screen, and threads read by themselves (once each).
  const shown = new Set<string>()
  const looked = new Set<string>()
  function lookUp(sid: string) {
    if (looked.has(sid)) return
    looked.add(sid)
    client.read<{ rows: Row[] }>(`/work/threads/${encodeURIComponent(sid)}`).then(
      (reply) => {
        if (get().unopened[sid]) set({ unopened: without(get().unopened, sid) })
        addUnder(reply.rows)
      },
      (e: unknown) => {
        if (e instanceof Refused && e.code === 'session_not_found') return set({ missing: { ...get().missing, [sid]: true } })
        // Offline or failing: said, and read again when it is next named.
        looked.delete(sid)
        if (!get().unopened[sid]) set({ unopened: { ...get().unopened, [sid]: true } })
      },
    )
  }

  // ---- where the person is ----

  function go(loc: Location, opt?: { replace?: boolean }) {
    const s = get()
    const change: Partial<State> = { loc }
    const track = loc.thread ? (s.rows.place.get(loc.thread)?.trackId ?? null) : loc.track
    // A track opens in the list when something in it is selected (R12).
    if (track && !s.openTracks[track]) change.openTracks = { ...s.openTracks, [track]: true }
    set(change)
    host.location.set(loc, opt)
    after()
  }
  stops.push(
    host.location.onChange((loc) => {
      set({ loc })
      after()
    }),
  )
  host.onOpen((t) => {
    if (t.new) go({ ...NOWHERE, start: true })
    else if (t.threadId) {
      // A track's agent has no row of its own: open its track.
      const s = get()
      for (const k of s.rows.track.values())
        if (k.agentSession === t.threadId) return go({ ...NOWHERE, track: k.id })
      go({ ...NOWHERE, thread: t.threadId })
    } else if (t.trackId) go({ ...NOWHERE, track: t.trackId })
  })
  host.onAnswer?.((a) => {
    client.answer(a.threadId, a.askId, { decision: a.choice === 'allow' ? 'allow' : 'deny' })
    sync()
  })

  // ---- writes ----

  const sync = () => recompose({ pending: client.pending().get() })
  const toast = (t: Omit<Toast, 'id'>) => {
    const id = makeId('op')
    set({ toasts: [...get().toasts.slice(-2), { ...t, id }] })
    setTimeout(() => dismissToast(id), t.undo ? 8000 : 5000)
  }
  const dismissToast = (id: string) => set({ toasts: get().toasts.filter((t) => t.id !== id) })

  function mutate<N extends MutationName>(name: N, args: MutationArgs[N]) {
    const r = client.mutate(name, args)
    r.settled.catch(() => {})
    sync()
    return r
  }
  const settle = (r: { settled: Promise<void> }) => {
    r.settled.catch(() => {})
    sync()
  }

  const onFailure = (f: Failure) => {
    answered.delete(f.entry.key)
    sync()
    const e = f.entry
    if (e.kind === 'mutation' && e.name === 'read.set') return
    // saveDoc merges and saves again.
    if (e.kind === 'mutation' && e.name === 'doc.save' && f.code === 'conflict') return
    const what = whatFailed(e)
    // What the person typed is not lost: it goes back in its box, unless
    // something new was typed there meanwhile.
    if (e.kind === 'turn' || e.kind === 'session') {
      const input = e.kind === 'turn' ? e.input : e.body.input
      const key = e.kind === 'session' ? 'new' : draftKeyOf(e.sessionId)
      if (!get().drafts[key]) actions.setDraft(key, input)
    }
    const billing = host.billing
    toast({
      text: `${what}: ${sayFailure(f)}`,
      tone: 'error',
      action: billing && OUT_OF_CREDITS.has(f.code) ? { label: 'Add credits', run: () => host.openExternal(billing) } : undefined,
    })
  }
  // The composer a session's messages are typed in: its track's, or its own.
  const draftKeyOf = (sid: string) => {
    for (const k of get().rows.track.values()) if (k.agentSession === sid) return `k:${k.id}`
    return `t:${sid}`
  }

  // ---- conversations ----

  const { watching, begin, watch } = watchConversations({ client, store, onServer })

  // ---- start ----

  void client.ready.then(() => {
    stops.push(client.feed(['session', 'place', 'track', 'result', 'proposal', 'doc', 'read', 'pref', 'machine', 'op']).subscribe(onFrame))
    stops.push(client.pending().subscribe((pending) => recompose({ pending })))
    stops.push(client.failures.subscribe(onFailure))
    stops.push((o.wake ?? pageWake)(hurry))
    stops.push(
      client.status.subscribe((status) => {
        set({ status })
        if (status === 'online') set({ synced: true })
      }),
    )
    set({ ready: true, status: client.status.get(), pending: client.pending().get() })
    recompose()
  })
  stops.push(
    store.subscribe((s, p) => {
      if (KEPT.some((k) => s[k] !== p[k])) o.kept?.set(JSON.stringify(Object.fromEntries(KEPT.map((k) => [k, s[k]]))))
    }),
  )

  const place = (sid: string) => get().rows.place.get(sid)
  const stopIfWorking = (sid: string) => {
    const st = get().rows.session.get(sid)?.status
    if (st === 'running' || st === 'starting') settle(client.interrupt(sid))
  }

  const actions = {
    // -- going places (only ever on the person's click, R22) --
    openThread(sid: string) {
      go({ ...NOWHERE, thread: sid })
    },
    openTrack(tid: string) {
      go({ ...NOWHERE, track: tid })
    },
    openStart() {
      go({ ...NOWHERE, start: true })
    },
    // A thread a link named that could not be read: read it again.
    retryThread(sid: string) {
      set({ unopened: without(get().unopened, sid) })
      lookUp(sid)
    },
    openResult(r: ResultRow) {
      // A preview opens in the browser: the app's shell allows no frames (spec 24.2).
      if (r.type === 'preview') return host.openExternal(r.ref)
      if (r.type === 'file' || r.type === 'document') {
        if (/^https?:/.test(r.ref)) host.openExternal(r.ref)
        return
      }
      const s = get()
      go({ ...NOWHERE, thread: s.loc.thread, track: s.loc.track, result: r.id })
    },
    closeResult() {
      const s = get()
      if (s.loc.result) go({ ...s.loc, result: null })
    },
    setLayout(tid: string, layout: Layout) {
      set({ layout: { ...get().layout, [tid]: layout } })
    },
    setTrackTab(tid: string, tab: TrackTab) {
      set({ trackTab: { ...get().trackTab, [tid]: tab } })
    },
    toggleList() {
      set({ listHidden: !get().listHidden })
    },
    toggleTrack(tid: string) {
      const s = get()
      set({ openTracks: { ...s.openTracks, [tid]: !s.openTracks[tid] } })
    },
    toggleEarlier(tid?: string) {
      const s = get()
      if (tid) set({ trackEarlierOpen: { ...s.trackEarlierOpen, [tid]: !s.trackEarlierOpen[tid] } })
      else set({ earlierOpen: !s.earlierOpen })
      const key = tid ?? ''
      if (get().earlierNext[key] === undefined) void actions.loadEarlier(tid)
    },
    setDraft(key: string, text: string) {
      const drafts = { ...get().drafts }
      if (text) drafts[key] = text
      else delete drafts[key]
      set({ drafts })
    },
    setTheme(theme: Theme) {
      set({ theme })
    },
    setReviewMode(reviewMode: 'summary' | 'full') {
      set({ reviewMode })
    },
    setPalette(palette: boolean) {
      set({ palette })
    },
    setKeysSheet(keysSheet: boolean) {
      set({ keysSheet })
    },
    toast,
    dismissToast,

    // -- talking --
    // A1, A22: the agent decides what this becomes; `open` lands on it.
    start(input: string, opt: { open: boolean; settings?: SettingsPatch }) {
      const r = client.createSession({ input, role: 'start', ...opt.settings })
      settle(r)
      if (opt.open) go({ ...NOWHERE, thread: r.id })
      return r.id
    },
    // A2, A3: a reply to a working agent steers it.
    send(sid: string, input: string) {
      const st = get().rows.session.get(sid)?.status
      settle(client.send(sid, input, { ifBusy: st === 'running' || st === 'starting' ? 'steer' : undefined }))
    },
    answer(sid: string, askId: string, answer: Answer) {
      settle(client.answer(sid, askId, answer))
    },
    dismissAsk(sid: string, askId: string) {
      settle(client.dismiss(sid, askId))
    },
    stop(sid: string) {
      settle(client.interrupt(sid))
    },
    // The model, effort or mode of an open session (spec 19.1).
    setSettings(sid: string, settings: SettingsPatch) {
      settle(client.settings(sid, settings))
    },
    // A secret goes to the session's sealed store, never through the
    // conversation; the agent's next message then closes its ask.
    async setSecret(sid: string, name: string, secret: { value: string; file: boolean }) {
      await client.setSecret(sid, name, secret)
      // Queued, not steered: a turn still running finishes before it reads this.
      const st = get().rows.session.get(sid)?.status
      settle(
        client.send(
          sid,
          `Secret $${name} is set for this session. It is available in your next command${secret.file ? ' as the path of a file holding it' : ''}. Continue.`,
          { ifBusy: st === 'running' || st === 'starting' ? 'queue' : undefined },
        ),
      )
    },

    // -- threads --
    // A9: lands on the track if it has one, else the start box.
    done(sid: string, opt?: { stay?: boolean }) {
      const p = place(sid)
      if (!p || p.doneAt !== null) return
      stopIfWorking(sid)
      mutate('thread.done', { sid })
      const s = get()
      if (s.loc.thread === sid && !opt?.stay) go({ ...NOWHERE, track: p.trackId, start: !p.trackId })
      toast({ text: 'Marked done', undo: () => actions.reopen(sid) })
    },
    reopen(sid: string) {
      mutate('thread.reopen', { sid })
    },
    rename(sid: string, title: string) {
      if (title.trim()) mutate('thread.rename', { sid, title: title.trim() })
    },
    // A7: the thread becomes the first thread of a new track.
    trackIt(sid: string) {
      const tid = makeId('trk')
      mutate('track.create', { tid, agentSessionId: makeId('cs'), sid })
      set({ openTracks: { ...get().openTracks, [tid]: true } })
      toast({ text: 'Now in a track', undo: () => mutate('track.dissolve', { tid, threads: 'keep' }) })
    },
    place(sid: string, trackId: string | null) {
      const from = place(sid)?.trackId ?? null
      if (from === trackId) return
      mutate('thread.place', { sid, trackId })
      toast({ text: trackId ? 'Moved' : 'Taken out of the track', undo: from ? () => mutate('thread.place', { sid, trackId: from }) : undefined })
    },
    keep(sid: string, keep: boolean) {
      mutate('thread.keep', { sid, keep })
    },
    deleteThread(sid: string) {
      const s = get()
      const p = place(sid)
      stopIfWorking(sid)
      if (s.loc.thread === sid) go({ ...NOWHERE, track: p?.trackId ?? null, start: !p?.trackId })
      mutate('thread.delete', { sid })
    },

    // -- tracks --
    renameTrack(tid: string, name: string) {
      if (name.trim()) mutate('track.rename', { tid, name: name.trim() })
    },
    stopAll(tid: string) {
      for (const p of get().rows.place.values()) if (p.trackId === tid) stopIfWorking(p.id)
    },
    // A11: lands on the start box.
    trackDone(tid: string, proposalId?: string) {
      actions.stopAll(tid)
      if (proposalId) mutate('proposal.accept', { proposalId })
      else mutate('track.done', { tid })
      const s = get()
      const open = s.loc.thread ? place(s.loc.thread)?.trackId : s.loc.track
      if (open === tid) go({ ...NOWHERE, start: true })
      toast({ text: 'Marked done', undo: () => mutate('track.reopen', { tid }) })
    },
    trackReopen(tid: string) {
      mutate('track.reopen', { tid })
    },
    trackKeep(tid: string, keep: boolean) {
      mutate('track.keep', { tid, keep })
    },
    // A13: lands on the thread that was open, on its own.
    dissolve(tid: string) {
      const s = get()
      mutate('track.dissolve', { tid, threads: 'keep' })
      if (!s.loc.thread && s.loc.track === tid) go({ ...NOWHERE, start: true })
    },
    deleteTrack(tid: string) {
      const s = get()
      const open = s.loc.thread ? place(s.loc.thread)?.trackId : s.loc.track
      if (open === tid) go({ ...NOWHERE, start: true })
      mutate('track.delete', { tid })
    },
    // Merged three ways when the Doc moved meanwhile (spec 22.3).
    async saveDoc(tid: string, text: string, base: { rev: number; text: string }): Promise<{ conflicts: number }> {
      return saveMerged({ get, me, mutate, toast, send: (sid, input) => actions.send(sid, input) }, tid, text, base)
    },

    // -- suggestions and undo --
    accept(proposalId: string) {
      const p = get().rows.proposal.get(proposalId)
      // G8 accepted is A11.
      if (p?.type === 'done' && get().rows.track.has(p.target)) return actions.trackDone(p.target, proposalId)
      mutate('proposal.accept', { proposalId })
      if (p?.type === 'done') toast({ text: 'Marked done', undo: () => mutate('thread.reopen', { sid: p.target }) })
    },
    dismissProposal(proposalId: string) {
      mutate('proposal.dismiss', { proposalId })
    },
    undo(opId: string) {
      mutate('undo', { opId })
    },
    // Z: the last thing that offered an Undo.
    undoLast() {
      const t = [...get().toasts].reverse().find((x) => x.undo)
      if (!t) return false
      t.undo!()
      dismissToast(t.id)
      return true
    },

    // -- reads that are not streams --
    ...serverReads({ client, store, addUnder, toast }),
    openExternal(url: string) {
      host.openExternal(url)
    },
  }

  return {
    host,
    client,
    me,
    store,
    get,
    list,
    thread: (sid: string) => threadView(get().rows, me, sid),
    watch,
    ...actions,
    close() {
      for (const stop of stops) stop()
      for (const w of watching.values()) w.stop()
      client.close()
    },
  }
}
