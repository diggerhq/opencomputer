import { useEffect, useMemo, useRef, useState } from 'react'
import { openManagedAgentEventStream } from './api'
import type { ManagedAgentEvent } from './events'

const NEXT_TIMEOUT_MS = 60 * 60 * 1_000
const FLUSH_MS = 40

/** Union of two seq-ordered event lists, de-duplicated by `seq`. */
export function mergeManagedAgentEvents(
  base: ManagedAgentEvent[],
  extra: ManagedAgentEvent[],
): ManagedAgentEvent[] {
  if (extra.length === 0) return base
  if (base.length === 0) return extra
  const seen = new Set(base.map((event) => event.seq))
  const added = extra.filter((event) => !seen.has(event.seq))
  if (added.length === 0) return base
  return [...base, ...added].sort((a, b) => a.seq - b.seq)
}

/**
 * Overlays live session events on top of a fetched history while `active`.
 * Events are pushed the moment they arrive (WebSocket, polling fallback) and
 * coalesced into ~25fps state updates so the inspector re-renders smoothly.
 */
export function useLiveSessionEvents(
  sessionId: string | undefined,
  history: ManagedAgentEvent[] | undefined,
  active: boolean,
) {
  const [live, setLive] = useState<{
    sessionId: string | undefined
    events: ManagedAgentEvent[]
  }>({ sessionId, events: [] })

  const historyRef = useRef(history)
  useEffect(() => {
    historyRef.current = history
  }, [history])

  useEffect(() => {
    if (!sessionId || !active) return
    const known = historyRef.current
    const stream = openManagedAgentEventStream(
      sessionId,
      known?.[known.length - 1]?.seq ?? 0,
    )
    let buffer: ManagedAgentEvent[] = []
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    let stopped = false

    const flush = () => {
      flushTimer = null
      if (buffer.length === 0) return
      const batch = buffer
      buffer = []
      setLive((prev) =>
        prev.sessionId === sessionId
          ? { sessionId, events: mergeManagedAgentEvents(prev.events, batch) }
          : { sessionId, events: batch },
      )
    }
    const pump = async () => {
      try {
        while (!stopped) {
          buffer.push(await stream.next(NEXT_TIMEOUT_MS))
          flushTimer ??= setTimeout(flush, FLUSH_MS)
        }
      } catch {
        // Stream closed (unmount, session change) or failed; the fetched
        // history remains the source of truth.
      }
    }
    void pump()
    return () => {
      stopped = true
      if (flushTimer) clearTimeout(flushTimer)
      stream.close()
    }
  }, [sessionId, active])

  return useMemo(
    () =>
      mergeManagedAgentEvents(
        history ?? [],
        live.sessionId === sessionId ? live.events : [],
      ),
    [history, live, sessionId],
  )
}
