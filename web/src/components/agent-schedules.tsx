import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  GitBranch,
  Pause,
  Pencil,
  Play,
  PlayCircle,
  Plus,
  Trash2,
} from 'lucide-react'
import { notifyError, notifySuccess } from '@/lib/errors'
import {
  ApiError,
  createSchedule,
  deleteSchedule,
  fireSchedule,
  getDeploymentSource,
  getScheduleRuns,
  getSchedules,
  updateSchedule,
  type Schedule,
  type ScheduleOverlap,
  type ScheduleRun,
} from '@/api/client'
import { Panel, PanelContent } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { Field, Input, Select, Textarea } from '@/components/form'

// ── helpers ────────────────────────────────────────────────────────────────────

// Relative time ("in 3h" / "5m ago") — schedules are minute-resolution, so no dependency needed.
function rel(iso: string | null): string {
  if (!iso) return '—'
  const delta = new Date(iso).getTime() - Date.now()
  const m = Math.max(1, Math.round(Math.abs(delta) / 60000))
  const unit = m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
  return delta >= 0 ? `in ${unit}` : `${unit} ago`
}
// Next-fire label: a due/overdue slot sits briefly in the past (until the tick catches up, < ~60s) —
// read that as "due now", never "1m ago".
function nextFireLabel(iso: string): string {
  return new Date(iso).getTime() <= Date.now() ? 'due now' : rel(iso)
}

// A friendly gloss for the common crons; unknown expressions just show the raw fields.
const CRON_HINTS: Record<string, string> = {
  '0 9 * * 1-5': 'weekdays at 09:00',
  '0 9 * * *': 'every day at 09:00',
  '0 * * * *': 'every hour',
  '*/15 * * * *': 'every 15 minutes',
  '*/30 * * * *': 'every 30 minutes',
  '0 0 * * 0': 'Sundays at midnight',
  '0 0 1 * *': 'first of the month',
  '0 0 * * *': 'every day at midnight',
}
const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: 'Weekdays 9am', cron: '0 9 * * 1-5' },
  { label: 'Daily 9am', cron: '0 9 * * *' },
  { label: 'Hourly', cron: '0 * * * *' },
  { label: 'Every 15m', cron: '*/15 * * * *' },
]

const prettyTz = (z: string) => z.replace(/_/g, ' ')
// UTC-only in the UI for now (shown as a fixed label, no picker). A schedule pointed at another zone
// via the API/CLI still renders correctly — the server's validateTz accepts any IANA zone.
function tzDisplay(tz: string | null): string {
  return !tz || tz === 'UTC' ? 'UTC' : prettyTz(tz)
}

function StateBadge({ s }: { s: Schedule }) {
  const cls =
    s.state === 'active'
      ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
      : s.state === 'auto_paused'
        ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
        : 'bg-muted text-muted-foreground'
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>{s.state.replace('_', ' ')}</span>
}

// A run's outcome in plain language. "enacted" → a session was started (linked); "failed" → it
// didn't start (with the error); "skipped" → the previous run was still going.
function RunStatus({ run }: { run: ScheduleRun }) {
  if (run.outcome === 'enacted') {
    const inner = (
      <>
        <CheckCircle2 className="size-3.5 shrink-0 text-green-600 dark:text-green-500" />
        Session started
      </>
    )
    return run.session_id ? (
      <Link to={`/sessions/${run.session_id}`} className="text-foreground inline-flex items-center gap-1 hover:underline">
        {inner}
      </Link>
    ) : (
      <span className="inline-flex items-center gap-1">{inner}</span>
    )
  }
  if (run.outcome === 'skipped') {
    return <span className="text-muted-foreground">Skipped — previous run still running</span>
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-red-600 dark:text-red-500" title={run.error ?? undefined}>
      <AlertTriangle className="size-3.5 shrink-0" />
      <span className="truncate">Didn’t start{run.error ? ` — ${run.error}` : ''}</span>
    </span>
  )
}

// Recent runs for a schedule — lazily fetched when a row is expanded.
function ScheduleRuns({ agentId, scheduleId }: { agentId: string; scheduleId: string }) {
  const { data: runs, isLoading } = useQuery({
    queryKey: ['schedule-runs', agentId, scheduleId],
    queryFn: () => getScheduleRuns(agentId, scheduleId, 5),
    refetchInterval: 15_000, // schedules fire in the background — keep the runs list live while open
  })
  if (isLoading) return <p className="text-muted-foreground px-3 py-2 text-xs">Loading runs…</p>
  if (!runs || runs.length === 0) return <p className="text-muted-foreground px-3 py-2 text-xs">No runs yet.</p>
  return (
    <ul className="divide-border/60 divide-y text-xs">
      {runs.map((r) => (
        <li key={r.id} className="flex items-center gap-2 px-3 py-1.5">
          <div className="min-w-0 flex-1">
            <RunStatus run={r} />
          </div>
          <span className="text-muted-foreground shrink-0">{rel(r.fired_at)}</span>
        </li>
      ))}
    </ul>
  )
}

type FormState = { id?: string; name: string; cron: string; input: string; overlap: ScheduleOverlap }

// ── the tab ─────────────────────────────────────────────────────────────────────

export function AgentSchedulesTab({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<FormState | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Schedule | null>(null)

  const { data: repoManaged } = useQuery({
    queryKey: ['agent-deploy-source', agentId],
    queryFn: async () => {
      try {
        return (await getDeploymentSource(agentId)).source
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null
        throw e
      }
    },
    select: (src) => !!src,
  })

  const {
    data: schedules,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ['agent-schedules', agentId],
    queryFn: () => getSchedules(agentId),
    refetchInterval: 20_000, // schedules fire in the background — reflect next-fire / last-ran live
  })

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['agent-schedules', agentId] })

  const openCreate = () => setForm({ name: '', cron: '0 9 * * 1-5', input: '', overlap: 'skip' })
  const openEdit = (s: Schedule) =>
    setForm({ id: s.id, name: s.name, cron: s.cron, input: s.input, overlap: s.overlap })

  const save = useMutation({
    mutationFn: () => {
      const f = form!
      const common = { cron: f.cron.trim(), input: f.input.trim(), overlap: f.overlap }
      // Create is UTC-only (tz: null). Edit omits tz entirely so it never clobbers a zone set via the API/CLI.
      return f.id
        ? updateSchedule(agentId, f.id, common)
        : createSchedule(agentId, { name: f.name.trim(), tz: null, ...common })
    },
    onSuccess: () => {
      const editing = !!form?.id
      invalidate()
      setForm(null)
      notifySuccess(editing ? 'Schedule updated.' : 'Schedule created.')
    },
    onError: (e) => notifyError("Couldn't save the schedule.", e),
  })

  const toggle = useMutation({
    mutationFn: (s: Schedule) => updateSchedule(agentId, s.id, { paused: s.state === 'active' }),
    onSuccess: () => invalidate(),
    onError: (e) => notifyError("Couldn't update the schedule.", e),
  })
  const fire = useMutation({
    mutationFn: (s: Schedule) => fireSchedule(agentId, s.id),
    onSuccess: (run, s) => {
      void queryClient.invalidateQueries({ queryKey: ['schedule-runs', agentId, s.id] })
      invalidate()
      if (run.outcome === 'enacted' && run.session_id) notifySuccess(`Fired — session ${run.session_id}`)
      else notifyError(`Fire ${run.outcome}`, new Error(run.error ?? run.outcome))
    },
    onError: (e) => notifyError("Couldn't fire the schedule.", e),
  })
  const remove = useMutation({
    mutationFn: (s: Schedule) => deleteSchedule(agentId, s.id),
    onSuccess: () => {
      invalidate()
      setPendingDelete(null)
      notifySuccess('Schedule deleted.')
    },
    onError: (e) => notifyError("Couldn't delete the schedule.", e),
  })

  const f = form
  const canSave = f && (f.id || f.name.trim()) && f.cron.trim() && f.input.trim()
  const cronGloss = f ? CRON_HINTS[f.cron.trim()] : undefined

  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-medium">Schedules</h2>
          <p className="text-muted-foreground mt-0.5 text-sm">
            Run this agent on a cron — each firing starts a new session with a fixed message.
          </p>
        </div>
        {!repoManaged && !form ? (
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" />
            New schedule
          </Button>
        ) : null}
      </div>

      {repoManaged ? (
        <div className="border-border bg-panel-2 flex items-start gap-2 rounded-md border px-3 py-2.5 text-xs">
          <GitBranch className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
          <p className="text-muted-foreground">
            Managed from the connected repo — edit the <span className="font-mono">[[schedules]]</span> table in{' '}
            <span className="font-mono">agent.toml</span> and push. You can still pause, resume, and test-fire here.
          </p>
        </div>
      ) : null}

      {/* Create / edit form */}
      {form ? (
        <Panel>
          <PanelContent className="space-y-4">
            <Field label="Name" htmlFor="sch-name">
              <Input
                id="sch-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="morning-docs-sweep"
                disabled={!!form.id}
              />
              {form.id ? <p className="text-muted-foreground mt-1 text-xs">Name can’t be changed after creation.</p> : null}
            </Field>

            <Field label="Schedule" htmlFor="sch-cron">
              <div className="flex items-center gap-2">
                <Input
                  id="sch-cron"
                  value={form.cron}
                  onChange={(e) => setForm({ ...form, cron: e.target.value })}
                  placeholder="0 9 * * 1-5"
                  className="font-mono"
                />
                <span
                  className="border-border text-muted-foreground shrink-0 rounded-md border px-2.5 py-1 text-sm"
                  title="Schedules run in UTC"
                >
                  UTC
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {CRON_PRESETS.map((p) => (
                  <button
                    key={p.cron}
                    type="button"
                    onClick={() => setForm({ ...form, cron: p.cron })}
                    className={
                      'rounded-full border px-2 py-0.5 text-xs transition-colors ' +
                      (form.cron.trim() === p.cron
                        ? 'border-foreground text-foreground'
                        : 'border-border text-muted-foreground hover:text-foreground')
                    }
                  >
                    {p.label}
                  </button>
                ))}
                <span className="text-muted-foreground ml-auto text-xs">
                  {cronGloss ? cronGloss : '5-field cron'}
                </span>
              </div>
            </Field>

            <Field label="Message" htmlFor="sch-input">
              <Textarea
                id="sch-input"
                value={form.input}
                onChange={(e) => setForm({ ...form, input: e.target.value })}
                placeholder="Reconcile docs/ against changes since the last run; open a draft PR if anything drifted."
                className="min-h-32"
              />
              <p className="text-muted-foreground mt-1 text-xs">
                Sent as the first message on every run. Write it as a complete instruction — no human is in the loop to
                clarify.
              </p>
            </Field>

            <Field label="If the previous run is still going" htmlFor="sch-overlap">
              <Select
                id="sch-overlap"
                value={form.overlap}
                onValueChange={(v) => setForm({ ...form, overlap: v as ScheduleOverlap })}
                className="max-w-xs"
                options={[
                  { value: 'skip', label: 'Skip this firing (default)' },
                  { value: 'allow', label: 'Run them concurrently' },
                ]}
              />
            </Field>

            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={save.isPending || !canSave} onClick={() => save.mutate()}>
                {save.isPending ? 'Saving…' : form.id ? 'Save changes' : 'Create schedule'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setForm(null)}>
                Cancel
              </Button>
            </div>
          </PanelContent>
        </Panel>
      ) : null}

      {/* List */}
      {isLoading ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : isError ? (
        <div className="space-y-2">
          <p className="text-sm text-red-600 dark:text-red-500">Couldn’t load schedules.</p>
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      ) : schedules && schedules.length > 0 ? (
        <ul className="space-y-3">
          {schedules.map((s) => {
            const gloss = CRON_HINTS[s.cron]
            const open = expanded === s.id
            return (
              <li key={s.id}>
                <Panel>
                  <PanelContent className="space-y-2.5">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{s.name}</span>
                      <StateBadge s={s} />
                      <div className="ml-auto flex items-center gap-0.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          title={s.state === 'active' ? 'Pause' : 'Resume'}
                          disabled={toggle.isPending}
                          onClick={() => toggle.mutate(s)}
                        >
                          {s.state === 'active' ? <Pause className="size-4" /> : <PlayCircle className="size-4" />}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          title="Test-fire now"
                          disabled={fire.isPending}
                          onClick={() => fire.mutate(s)}
                        >
                          <Play className="size-4" />
                        </Button>
                        {!repoManaged ? (
                          <>
                            <Button size="sm" variant="ghost" title="Edit" onClick={() => openEdit(s)}>
                              <Pencil className="size-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-muted-foreground hover:text-red-600"
                              title="Delete"
                              onClick={() => setPendingDelete(s)}
                            >
                              <Trash2 className="size-4" />
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </div>

                    <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                      <code className="text-foreground font-mono">{s.cron}</code>
                      {gloss ? <span>{gloss}</span> : null}
                      <span className="text-border">·</span>
                      <span>{tzDisplay(s.tz)}</span>
                      <span className="text-border">·</span>
                      <span className="inline-flex items-center gap-1">
                        <CalendarClock className="size-3" />
                        next {s.state === 'active' ? nextFireLabel(s.next_fire_at) : '—'}
                      </span>
                      {s.last_fired_at ? <span>· last ran {rel(s.last_fired_at)}</span> : null}
                    </div>

                    {s.state === 'auto_paused' && s.last_error ? (
                      <div className="flex items-start gap-1.5 text-xs text-red-600 dark:text-red-500">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                        <span className="min-w-0">
                          Auto-paused after repeated failures — {s.last_error}. Resume once fixed.
                        </span>
                      </div>
                    ) : null}

                    <button
                      type="button"
                      onClick={() => setExpanded(open ? null : s.id)}
                      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors"
                    >
                      {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                      Recent runs
                    </button>
                    {open ? (
                      <div className="bg-muted/40 -mx-1 rounded-md">
                        <ScheduleRuns agentId={agentId} scheduleId={s.id} />
                      </div>
                    ) : null}
                  </PanelContent>
                </Panel>
              </li>
            )
          })}
        </ul>
      ) : !form ? (
        <div className="border-border rounded-lg border border-dashed py-12 text-center">
          <CalendarClock className="text-muted-foreground mx-auto size-6" />
          <p className="mt-3 text-sm font-medium">No schedules yet</p>
          <p className="text-muted-foreground mx-auto mt-1 max-w-sm text-sm">
            Run this agent automatically — a draft PR every morning, a nightly audit, a periodic sweep.
          </p>
          {!repoManaged ? (
            <Button size="sm" className="mt-4" onClick={openCreate}>
              <Plus className="size-4" />
              Create a schedule
            </Button>
          ) : null}
        </div>
      ) : null}

      <p className="text-muted-foreground text-xs">
        Or from the CLI: <code className="font-mono">oc agent schedule create &lt;name&gt; --cron "0 9 * * 1-5" --input …</code>
      </p>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={`Delete "${pendingDelete?.name ?? ''}"?`}
        description="This schedule stops firing immediately. Run history is kept."
        confirmLabel="Delete"
        destructive
        pending={remove.isPending}
        onConfirm={() => pendingDelete && remove.mutate(pendingDelete)}
      />
    </div>
  )
}

