import type { StoreApi } from 'zustand/vanilla'
import type { Client, Delta, EventsUpdate } from '@opencomputer/sdk/computer'
import { EMPTY_CONVO, type Convo, type State } from './surface-state'
import type { OpenBlock } from './transcript'

// The conversations the panes show: each session's events and the text still
// streaming, read while a pane watches it.
export function watchConversations({
  client,
  store,
  onServer,
}: {
  client: Client
  store: StoreApi<State>
  // The server holds this session: in the feed, or read by query.
  onServer: (sid: string) => boolean
}) {
  const get = store.getState
  const set = store.setState

  const watching = new Map<string, { n: number; started: boolean; stop: () => void }>()
  const patchConvo = (sid: string, fn: (c: Convo) => Convo) => {
    const convos = get().convos
    const next = fn(convos[sid] ?? EMPTY_CONVO)
    if (next !== convos[sid]) set({ convos: { ...convos, [sid]: next } })
  }
  const onEvents = (sid: string, u: EventsUpdate) =>
    patchConvo(sid, (c) => {
      let events = c.events
      if (u.reset) events = u.reset.seq === null ? [] : events.filter((e) => e.seq <= u.reset!.seq!)
      if (u.events.length) {
        const last = events.length ? events[events.length - 1].seq : -1
        if (u.events[0].seq > last) events = [...events, ...u.events]
        else {
          const bySeq = new Map(events.map((e) => [e.seq, e]))
          for (const e of u.events) bySeq.set(e.seq, e)
          events = [...bySeq.values()].sort((a, b) => a.seq - b.seq)
        }
      }
      // The block that was streaming has arrived whole, or its turn is over.
      const closes = u.events.some((e) => e.type === 'message.completed' || e.type.startsWith('turn.'))
      return { events, loaded: true, open: closes || u.reset ? null : c.open }
    })

  // Deltas are applied at most every 50 ms (spec 26.4).
  const buffered = new Map<string, OpenBlock | null>()
  let flush: ReturnType<typeof setTimeout> | null = null
  const onDelta = (sid: string, d: Delta) => {
    if (d.type !== 'message.delta' || typeof d.data.text !== 'string') return
    const blockId = d.data.blockId ?? d.turnId
    const held = buffered.has(sid) ? buffered.get(sid)! : (get().convos[sid]?.open ?? null)
    let text: string
    if (d.whole || !held || held.blockId !== blockId) text = d.offset === 0 || d.whole ? d.data.text : ''
    else if (d.offset === held.text.length) text = held.text + d.data.text
    else if (d.offset < held.text.length) text = held.text.slice(0, d.offset) + d.data.text
    else return
    buffered.set(sid, { blockId, type: d.type, turnId: d.turnId, text })
    flush ??= setTimeout(() => {
      flush = null
      for (const [id, open] of buffered) {
        // A delta that trails its completed message is dropped.
        const done = get().convos[id]?.events.some(
          (e) => e.type === 'message.completed' && (e.data as { blockId?: string } | null)?.blockId === open?.blockId,
        )
        patchConvo(id, (c) => ({ ...c, open: done ? null : open }))
      }
      buffered.clear()
    }, 50)
  }

  // Ref-counted: a pane watches the session it shows; the last to leave stops
  // the streams, and what was read stays in memory.
  // A session still being created has no log to read yet: its streams start
  // when its row arrives.
  const begin = (sid: string) => {
    const w = watching.get(sid)
    if (!w || w.started || !onServer(sid)) return
    const a = client.events(sid, { tailTurns: 30 }).subscribe((u) => onEvents(sid, u))
    const b = client.deltas(sid).subscribe((d) => onDelta(sid, d))
    w.started = true
    w.stop = () => (a(), b())
  }
  function watch(sid: string): () => void {
    let w = watching.get(sid)
    if (!w) {
      w = { n: 0, started: false, stop: () => {} }
      watching.set(sid, w)
      begin(sid)
    }
    w.n++
    let left = false
    return () => {
      if (left) return
      left = true
      // Let a pane that remounts at once keep its streams.
      setTimeout(() => {
        if (--w.n === 0) {
          w.stop()
          watching.delete(sid)
        }
      }, 1000)
    }
  }

  return { watching, begin, watch }
}
