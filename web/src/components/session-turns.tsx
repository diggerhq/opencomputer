import { useQuery } from '@tanstack/react-query'
import { getSessionTurns, type Turn } from '@/api/client'
import { Panel } from '@/components/panel'
import { StatusBadge } from '@/components/status-badge'
import { ApiHint } from '@/components/api-hint'
import { formatSpend } from '@/lib/usage'

// A turn's `error` is an opaque object (or a string); pull a one-line message defensively.
function errorMessage(error: unknown): string | null {
  if (error == null) return null
  if (typeof error === 'string') return error
  if (typeof error === 'number' || typeof error === 'boolean') {
    return String(error)
  }
  if (typeof error === 'object') {
    const e = error as Record<string, unknown>
    const msg = e.message ?? e.error ?? e.detail
    const code = typeof e.code === 'string' ? e.code : null
    if (typeof msg === 'string') return code ? `${code}: ${msg}` : msg
    if (code) return code
    try {
      return JSON.stringify(error)
    } catch {
      return 'error'
    }
  }
  return 'error'
}

// Wall-clock duration of a turn: prefer active_seconds (billed compute), else derive
// from started/completed timestamps. Returns a compact label like "4.2s" / "1m 03s".
function duration(turn: Turn): string | null {
  let secs: number | null =
    typeof turn.active_seconds === 'number' ? turn.active_seconds : null
  if (secs == null && turn.started_at && turn.completed_at) {
    const ms = Date.parse(turn.completed_at) - Date.parse(turn.started_at)
    if (Number.isFinite(ms) && ms >= 0) secs = ms / 1000
  }
  if (secs == null) return null
  if (secs < 60) return `${secs.toFixed(1)}s`
  const m = Math.floor(secs / 60)
  const s = Math.round(secs % 60)
  return `${m}m ${String(s).padStart(2, '0')}s`
}

export function SessionTurns({
  sessionId,
  active,
}: {
  sessionId: string
  active: boolean
}) {
  const { data: turns, isLoading } = useQuery({
    queryKey: ['session-turns', sessionId],
    queryFn: () => getSessionTurns(sessionId),
    // Keep the health view current while the session is doing work; idle when settled.
    refetchInterval: active ? 5000 : false,
  })

  if (!isLoading && (turns?.length ?? 0) === 0) return null // nothing to show for a session with no turns yet

  return (
    <Panel className="mt-4 overflow-hidden">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <h2 className="text-sm font-semibold">Submission health</h2>
        <ApiHint
          method="GET"
          path="/v3/sessions/:id/turns"
          sdk="oc.sessions.turns()"
          docs="https://docs.opencomputer.dev/agent-sessions/sessions"
        />
      </div>

      {isLoading ? (
        <div className="text-muted-foreground px-4 py-3 text-xs">Loading…</div>
      ) : (
        <ul className="divide-y">
          {(turns ?? []).map((t) => {
            const err = t.state === 'error' ? errorMessage(t.error) : null
            const dur = duration(t)
            const spend = formatSpend(t.usage)
            return (
              <li key={t.id} className="px-4 py-2.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <StatusBadge
                    status={t.state === 'ok' ? 'success' : t.state}
                    label={t.state === 'ok' ? 'OK' : undefined}
                  />
                  <code className="text-muted-foreground/80 font-mono text-[11px]">
                    {t.id}
                  </code>
                  {t.yield_reason ? (
                    <span className="text-muted-foreground text-xs">
                      {t.yield_reason.replace(/_/g, ' ')}
                    </span>
                  ) : null}
                  <span className="text-muted-foreground/70 ml-auto flex items-center gap-3 font-mono text-[11px] tabular-nums">
                    {dur ? <span title="active compute">{dur}</span> : null}
                    {spend !== '—' ? <span title="turn usage">{spend}</span> : null}
                  </span>
                </div>
                {err ? (
                  <p className="text-status-error mt-1 font-mono text-[11px] break-words">
                    {err}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </Panel>
  )
}
