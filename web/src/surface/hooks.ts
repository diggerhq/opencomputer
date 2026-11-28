import { createContext, useContext, useEffect, useMemo } from 'react'
import { useStore } from 'zustand'
import type { State } from './store/surface-state'
import type { Surface } from './store/surface-store'
import type { OpRow } from '@opencomputer/sdk/computer'
import type { Rows } from './store/rows'
import { buildTranscript, opLines, unsent, type Item } from './store/transcript'
import { findTrack, listView, threadView, type ListView, type ThreadView, type TrackView } from './store/views'

// How components read the store: selectors, never a fetch (spec 26.2).

export const SurfaceContext = createContext<Surface | null>(null)

export function useSurface(): Surface {
  const s = useContext(SurfaceContext)
  if (!s) throw new Error('no surface')
  return s
}

export function useS<T>(select: (s: State) => T): T {
  return useStore(useSurface().store, select)
}

export const useList = (): ListView => useS((s) => listView(s.rows, s.me, s.loc.thread, s.counts))

export const useThread = (sid: string | null): ThreadView | undefined =>
  useS((s) => (sid ? threadView(s.rows, s.me, sid) : undefined))

export const useTrack = (tid: string | null): TrackView | undefined => findTrack(useList(), tid)

// The track a pane belongs to: an open thread's own, else the one selected.
export const useOpenTrackId = (): string | null =>
  useS((s) => (s.loc.thread ? (s.rows.place.get(s.loc.thread)?.trackId ?? null) : s.loc.track))

export interface Conversation {
  // With the reply being written, as the message it will be.
  items: Item[]
  // False until there is enough of it to draw: nothing is drawn in parts (work 139).
  loaded: boolean
  // Events exist before the first one held: `surface.earlier` reads a page of them.
  hasEarlier: boolean
  working: boolean
  // The session has a row: its conversation exists to be read.
  known: boolean
}

const NO_EVENTS: never[] = []

// A session's conversation, watched while something shows it. `trackId` adds
// the track's structural lines to its agent's conversation.
export function useConversation(sid: string | null, trackId?: string): Conversation {
  const surface = useSurface()
  useEffect(() => (sid ? surface.watch(sid) : undefined), [surface, sid])
  const convo = useS((s) => (sid ? s.convos[sid] : undefined))
  const session = useS((s) => (sid ? s.rows.session.get(sid) : undefined))
  const pending = useS((s) => s.pending)
  const attachments = useS((s) => s.attachments)
  const ops = useS((s) => s.rows.op)
  // A track's threads are drawn where they joined it.
  const places = useS((s) => (trackId ? s.rows.place : null))
  const loaded = convo?.loaded ?? false
  const hasEarlier = convo?.hasEarlier ?? false
  const events = (loaded && convo?.events) || NO_EVENTS
  const open = convo?.open ?? null
  const items = useMemo(() => {
    if (!sid) return []
    const rows = surface.get().rows
    // Structural lines are placed by time, so those older than the window
    // wait for the events they belong between.
    const from = hasEarlier ? events[0]?.createdAt : undefined
    const held = (i: Item) => loaded && (!from || i.at >= from)
    const lines = opLines(ops.values(), trackId ? { trackId } : { sessionId: sid }, {
      track: (id) => rows.track.get(id)?.name ?? 'a track',
      thread: (id) => rows.session.get(id)?.title ?? 'A thread',
      me: `user:${surface.me}`,
    })
    const base = buildTranscript(events, surface.me, open)
    const extra = (trackId ? [...lines, ...joined(rows, ops.values(), trackId)] : lines).filter(held)
    const merged = extra.length ? group([...base, ...extra].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))) : base
    return [...merged, ...unsent(events, pending, session?.inbox ?? NO_EVENTS, sid, attachments)]
  }, [surface, sid, trackId, events, loaded, hasEarlier, open, pending, attachments, session?.inbox, ops, places])
  return {
    items,
    loaded,
    hasEarlier,
    known: !!session,
    working: session?.status === 'running' || session?.status === 'starting',
  }
}

// Each of a track's threads, at the moment it joined: its latest move into the
// track, else its start.
function joined(rows: Rows, ops: Iterable<OpRow>, tid: string): Item[] {
  const moved = new Map<string, number>()
  for (const op of ops) {
    const a = op.args as { sid?: string; trackId?: string | null }
    if (op.name === 'thread.place' && a.sid && a.trackId === tid && !op.undoneBy)
      moved.set(a.sid, Math.max(moved.get(a.sid) ?? 0, op.at))
  }
  const out: Item[] = []
  for (const p of rows.place.values()) {
    if (p.trackId !== tid) continue
    const s = rows.session.get(p.sessionId)
    if (!s || s.role) continue
    const m = moved.get(p.sessionId)
    const at = m ? new Date(m).toISOString() : s.createdAt
    if (at) out.push({ kind: 'threads', key: `th:${p.sessionId}`, ids: p.sessionId, at })
  }
  return out
}

// Threads that joined one after another share one group.
function group(items: Item[]): Item[] {
  const out: Item[] = []
  for (const i of items) {
    const last = out[out.length - 1]
    if (i.kind === 'threads' && last?.kind === 'threads')
      out[out.length - 1] = { ...last, ids: `${last.ids},${i.ids}` }
    else out.push(i)
  }
  return out
}
