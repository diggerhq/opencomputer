// LogsPanel — sandbox session logs view.
//
// Streams from /api/dashboard/sessions/:sandboxId/logs (SSE) and renders
// a live, source-color-coded timeline of events: lines from /var/log
// inside the sandbox, stdout/stderr of every platform-exec'd command,
// and synthetic "exit_code" markers showing how each command finished.
//
// Design contract:
//
//   - Auto-scroll to bottom unless the user has scrolled up. Scrolling
//     up "pins" the view; scrolling back to within ~40px of the bottom
//     unpins it.
//   - Hard cap on retained events (visibleCap below). Once exceeded,
//     drop the oldest. Memory grows linearly with cap and is bounded.
//   - Search filters server-side (the SSE re-opens with `?q=...`); we
//     debounce so each keystroke isn't a new connection.
//   - Source filter is a comma-separated allowlist that maps directly
//     to the server's ?source= param.
//   - Pause toggle freezes display only — the EventSource keeps
//     receiving so unpausing catches up; if buffer overflows, oldest
//     pending events drop.
//
// PTY content is intentionally not part of this view (consent surface
// is different — see design doc).

import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { streamSessionLogs, type LogEvent } from '@/api/client'

const visibleCap = 3000 // hard cap on retained events
const debounceMs = 200 // search-box debounce
const nearBottomPx = 40 // "auto-scroll if within this many px of bottom"

// One colour per source. Distinct hues across the four; no overlap
// with the green used for success-EOF rows (✓ exited 0) and the rose
// used for failure-EOF rows.
// Dark-surface palette: one distinct hue per source, no overlap with the
// emerald (✓ exited 0) / rose (✗) used for EOF rows.
const sources: { value: LogEvent['source']; label: string; color: string }[] = [
  { value: 'exec_stdout', label: 'stdout', color: '#a1a1aa' }, // zinc-400
  { value: 'exec_stderr', label: 'stderr', color: '#fb7185' }, // rose-400
  { value: 'var_log', label: 'var/log', color: '#fbbf24' }, // amber-400
  { value: 'agent', label: 'agent', color: '#38bdf8' }, // sky-400
]

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(t)
  }, [value, delayMs])
  return debounced
}

interface LogsPanelProps {
  sandboxId: string
  onClose?: () => void
}

export default function LogsPanel({ sandboxId, onClose }: LogsPanelProps) {
  const [query, setQuery] = useState('')
  const [paused, setPaused] = useState(false)
  // Subtractive filter: every source is shown by default. Clicking a
  // chip *hides* that source; clicking again brings it back.
  const [hiddenSources, setHiddenSources] = useState<Set<LogEvent['source']>>(
    new Set(),
  )
  const [events, setEvents] = useState<LogEvent[]>([])
  const [connState, setConnState] = useState<
    'connecting' | 'open' | 'error' | 'closed'
  >('connecting')

  const debouncedQuery = useDebouncedValue(query, debounceMs)

  // Buffered events that arrived while paused; flushed on resume.
  const pausedBufRef = useRef<LogEvent[]>([])
  const containerRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)

  // Open the EventSource ONCE per sandbox. Search and source filters
  // are applied client-side against the in-memory buffer — no SSE
  // re-open on filter change, no flicker. The historical batch is
  // bounded by visibleCap so memory stays cheap; if a user really
  // wants to search beyond the current buffer they can adjust the
  // since= URL param later.
  useEffect(() => {
    // Reset + (re)subscribe when the sandbox changes. The synchronous resets
    // are intentional here (clear the stream before opening a new EventSource).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEvents([])
    pausedBufRef.current = []
    stickToBottomRef.current = true
    setConnState('connecting')

    const es = streamSessionLogs(sandboxId, { tail: true })

    es.onopen = () => setConnState('open')
    es.onerror = () => setConnState('error')
    es.onmessage = (e) => {
      let ev: LogEvent
      try {
        ev = JSON.parse(e.data) as LogEvent
      } catch {
        return
      }
      if (paused) {
        pausedBufRef.current.push(ev)
        // Defensive cap on the paused buffer.
        if (pausedBufRef.current.length > visibleCap) {
          pausedBufRef.current = pausedBufRef.current.slice(-visibleCap)
        }
        return
      }
      setEvents((prev) => {
        const next =
          prev.length >= visibleCap
            ? prev.slice(prev.length - visibleCap + 1)
            : prev.slice()
        next.push(ev)
        return next
      })
    }

    return () => {
      es.close()
      setConnState('closed')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sandboxId])

  // When unpausing, drain the paused buffer into events.
  useEffect(() => {
    if (!paused && pausedBufRef.current.length > 0) {
      const buf = pausedBufRef.current
      pausedBufRef.current = []
      setEvents((prev) => {
        const merged = prev.concat(buf)
        return merged.length > visibleCap
          ? merged.slice(merged.length - visibleCap)
          : merged
      })
    }
  }, [paused])

  // Auto-scroll to bottom when new events arrive — but only if the
  // user is already near the bottom (i.e. they haven't scrolled up to
  // read older lines).
  useEffect(() => {
    if (!stickToBottomRef.current) return
    const el = containerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [events])

  const handleScroll = () => {
    const el = containerRef.current
    if (!el) return
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottomRef.current = distFromBottom <= nearBottomPx
  }

  const toggleSource = (src: LogEvent['source']) => {
    setHiddenSources((prev) => {
      const next = new Set(prev)
      if (next.has(src)) next.delete(src)
      else next.add(src)
      return next
    })
  }

  // Client-side filter pipeline: source filter → text search → EOF
  // dedup. Each command emits one EOF event per stream (stdout AND
  // stderr) so without dedup the timeline shows "exited 0" twice for
  // the same exec. We collapse them to one per exec_id.
  const visible = useMemo(() => {
    const lowerQuery = debouncedQuery.trim().toLowerCase()

    // Two-pass:
    //  1. Dedupe EOFs by exec_id — agent emits one EOF on stdout AND
    //     one on stderr per exec; we keep the first (stdout, by emit
    //     order), drop the rest. Must happen BEFORE the source filter
    //     — otherwise hiding stdout lets the suppressed stderr-EOF
    //     through and the row "moves" from stdout-coloured to stderr.
    //  2. Apply source + text filters to the deduped list.
    const seenEofExecIDs = new Set<string>()
    const deduped: LogEvent[] = []
    for (const ev of events) {
      const isEof = ev.line === '' && ev.exit_code !== undefined
      if (isEof && ev.exec_id) {
        if (seenEofExecIDs.has(ev.exec_id)) continue
        seenEofExecIDs.add(ev.exec_id)
      }
      deduped.push(ev)
    }

    return deduped.filter((ev) => {
      if (hiddenSources.has(ev.source)) return false
      if (lowerQuery && !searchCorpus(ev).includes(lowerQuery)) return false
      return true
    })
  }, [events, hiddenSources, debouncedQuery])

  return (
    <div className="bg-terminal border-code-border flex h-[480px] flex-col overflow-hidden rounded-lg border">
      {/* Header */}
      <div className="border-code-border flex flex-wrap items-center gap-3 border-b px-3 py-2.5">
        <span className="text-code-muted text-xs font-medium tracking-wide uppercase">
          Logs
        </span>
        <ConnectionDot state={connState} />

        <div className="relative min-w-40 flex-1">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="border-code-border text-code-foreground placeholder:text-code-muted w-full rounded-md border bg-black/20 px-2.5 py-1.5 pr-7 text-[13px] outline-none focus-visible:border-zinc-500"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="text-code-muted hover:text-code-foreground absolute top-1/2 right-1.5 -translate-y-1/2"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>

        <div className="flex gap-1">
          {sources.map((src) => {
            // Subtractive filter: chip ON = source visible (default); OFF =
            // hidden. ON uses a subtle tint of the (data-driven) source color.
            const isVisible = !hiddenSources.has(src.value)
            return (
              <button
                key={src.value}
                onClick={() => toggleSource(src.value)}
                title={isVisible ? `Hide ${src.label}` : `Show ${src.label}`}
                className="rounded-md border px-2 py-0.5 font-mono text-[11px] transition-opacity"
                style={{
                  color: src.color,
                  borderColor: src.color,
                  background: isVisible
                    ? `color-mix(in srgb, ${src.color} 16%, transparent)`
                    : 'transparent',
                  opacity: isVisible ? 1 : 0.4,
                  fontWeight: isVisible ? 600 : 400,
                }}
              >
                {src.label}
              </button>
            )
          })}
        </div>

        <button
          onClick={() => setPaused((p) => !p)}
          className="text-code-muted hover:text-code-foreground text-xs transition-colors"
          title={
            paused ? 'Resume live tail' : 'Pause display (stream keeps running)'
          }
        >
          {paused ? 'Resume' : 'Pause'}
        </button>

        {onClose ? (
          <button
            onClick={onClose}
            className="text-code-muted hover:text-code-foreground text-xs transition-colors"
          >
            Close
          </button>
        ) : null}
      </div>

      {/* Stream */}
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto py-2 font-mono text-xs leading-relaxed"
      >
        {visible.length === 0 && connState === 'open' ? (
          <div className="text-code-muted px-4 py-5 text-center">
            No logs yet. Run a command, write to <code>/var/log/...</code>, or
            wait for system activity.
          </div>
        ) : null}
        {visible.length === 0 && connState === 'error' ? (
          <div className="px-4 py-5 text-center text-rose-400">
            Couldn&apos;t connect to log stream. Logs may not be configured for
            this deployment.
          </div>
        ) : null}
        {visible.map((ev, i) => (
          <Row key={i} ev={ev} />
        ))}
      </div>

      {visible.length >= visibleCap ? (
        <div className="border-code-border text-code-muted border-t px-4 py-1.5 text-[11px]">
          Showing latest {visibleCap} events; older events scrolled off.
        </div>
      ) : null}
    </div>
  )
}

function ConnectionDot({
  state,
}: {
  state: 'connecting' | 'open' | 'error' | 'closed'
}) {
  const color =
    state === 'open' ? '#34d399' : state === 'error' ? '#fb7185' : '#71717a'
  return (
    <span
      title={`Connection: ${state}`}
      className="inline-block size-2 shrink-0 rounded-full"
      style={{ background: color }}
    />
  )
}

function Row({ ev }: { ev: LogEvent }) {
  const sourceMeta = sources.find((s) => s.value === ev.source)
  const sourceColor = sourceMeta?.color || '#71717a'
  const time = formatTime(ev._time)

  // Exec EOF marker: empty line + exit_code present → a synthetic "command X
  // exited N" row.
  if (ev.line === '' && ev.exit_code !== undefined) {
    const ok = ev.exit_code === 0
    return (
      <div
        className="flex gap-2.5 px-4 py-0.5 italic"
        style={{ color: ok ? '#34d399' : '#fb7185' }}
      >
        <span className="text-code-muted not-italic">{time}</span>
        <span>
          {ok ? '✓' : '✗'} {ev.command || 'command'} exited {ev.exit_code}
        </span>
      </div>
    )
  }

  return (
    <div className="flex gap-2.5 px-4 py-px break-words whitespace-pre-wrap">
      <span className="text-code-muted shrink-0">{time}</span>
      <span
        className="w-14 shrink-0 text-[11px]"
        style={{ color: sourceColor }}
      >
        {sourceMeta?.label || ev.source}
      </span>
      <span className="text-code-foreground flex-1">{ev.line}</span>
    </div>
  )
}

// searchCorpus returns the text the search box matches against for a
// given event, lower-cased. For real lines it's just `line`; for EOF
// markers (which have line=='' and a synthesized "X exited N"
// rendering) we include the synthesized text plus the command name +
// argv so users can search for "exit", a command, or its args.
function searchCorpus(ev: LogEvent): string {
  if (ev.line === '' && ev.exit_code !== undefined) {
    const cmd = ev.command || 'command'
    const argv = ev.argv ? ev.argv.join(' ') : ''
    return `${cmd} ${argv} exited ${ev.exit_code}`.toLowerCase()
  }
  return ev.line.toLowerCase()
}

function formatTime(rfc3339: string): string {
  // Display HH:MM:SS.mmm — matches the granularity shippers use.
  const d = new Date(rfc3339)
  if (isNaN(d.getTime())) return ''
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${hh}:${mm}:${ss}.${ms}`
}
