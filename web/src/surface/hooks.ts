import { createContext, useContext, useEffect, useMemo } from 'react'
import { useStore } from 'zustand'
import type { State } from './store/surface-state'
import type { Surface } from './store/surface-store'
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
  // False only for a conversation never seen on this device.
  loaded: boolean
  working: boolean
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
  const events = convo?.events ?? NO_EVENTS
  const open = convo?.open ?? null
  const items = useMemo(() => {
    if (!sid) return []
    const rows = surface.get().rows
    const lines = opLines(ops.values(), trackId ? { trackId } : { sessionId: sid }, {
      track: (id) => rows.track.get(id)?.name ?? 'a track',
      thread: (id) => rows.session.get(id)?.title ?? 'A thread',
      me: `user:${surface.me}`,
    })
    const base = buildTranscript(events, surface.me, open)
    const merged = lines.length ? [...base, ...lines].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)) : base
    return [...merged, ...unsent(events, pending, session?.inbox ?? NO_EVENTS, sid, attachments)]
  }, [surface, sid, trackId, events, open, pending, attachments, session?.inbox, ops])
  return {
    items,
    loaded: convo?.loaded ?? false,
    working: session?.status === 'running' || session?.status === 'starting',
  }
}
