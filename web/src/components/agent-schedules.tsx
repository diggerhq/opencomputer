import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pause, Play, PlayCircle, Plus, Trash2 } from 'lucide-react'
import { notifyError, notifySuccess } from '@/lib/errors'
import {
  ApiError,
  createSchedule,
  deleteSchedule,
  fireSchedule,
  getDeploymentSource,
  getSchedules,
  updateSchedule,
  type Schedule,
} from '@/api/client'
import { Panel, PanelContent } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/form'

// Relative time ("in 3h" / "5m ago") — no dependency; schedules are minute-resolution.
function rel(iso: string | null): string {
  if (!iso) return '—'
  const delta = new Date(iso).getTime() - Date.now()
  const m = Math.max(1, Math.round(Math.abs(delta) / 60000))
  const unit = m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
  return delta >= 0 ? `in ${unit}` : `${unit} ago`
}

function StatePill({ s }: { s: Schedule }) {
  const cls =
    s.state === 'active'
      ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
      : s.state === 'auto_paused'
        ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
        : 'bg-muted text-muted-foreground'
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`}
      title={s.state === 'auto_paused' && s.last_error ? s.last_error : undefined}
    >
      {s.state.replace('_', ' ')}
    </span>
  )
}

/**
 * Schedules card (Overview right rail) — cron for agents (design 015). Lists the agent's schedules
 * with their next fire + state, a pause/resume toggle, a test-fire, and delete; a compact create
 * form for name/cron/tz/input. Read-only (except pause/resume) when the agent is repo-driven — the
 * agent.toml owns the schedules then, matching the deploy-source convention.
 */
export function AgentSchedules({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [cron, setCron] = useState('0 9 * * 1-5')
  const [tz, setTz] = useState('')
  const [input, setInput] = useState('')

  // Repo-driven agents manage schedules via agent.toml → the API rejects edits other than
  // pause/resume (409). Share the deploy-source card's query cache so the two stay consistent.
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
  })

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['agent-schedules', agentId] })

  const create = useMutation({
    mutationFn: () =>
      createSchedule(agentId, {
        name: name.trim(),
        cron: cron.trim(),
        tz: tz.trim() || null,
        input: input.trim(),
      }),
    onSuccess: () => {
      invalidate()
      setShowForm(false)
      setName('')
      setInput('')
      notifySuccess('Schedule created.')
    },
    onError: (e) => notifyError("Couldn't create the schedule.", e),
  })

  const toggle = useMutation({
    mutationFn: (s: Schedule) => updateSchedule(agentId, s.id, { paused: s.state === 'active' }),
    onSuccess: () => invalidate(),
    onError: (e) => notifyError("Couldn't update the schedule.", e),
  })

  const fire = useMutation({
    mutationFn: (s: Schedule) => fireSchedule(agentId, s.id),
    onSuccess: (run) => {
      invalidate()
      if (run.outcome === 'enacted' && run.session_id) {
        notifySuccess(`Fired — session ${run.session_id}`)
      } else {
        notifyError(`Fire ${run.outcome}`, new Error(run.error ?? run.outcome))
      }
    },
    onError: (e) => notifyError("Couldn't fire the schedule.", e),
  })

  const remove = useMutation({
    mutationFn: (s: Schedule) => deleteSchedule(agentId, s.id),
    onSuccess: () => {
      invalidate()
      notifySuccess('Schedule deleted.')
    },
    onError: (e) => notifyError("Couldn't delete the schedule.", e),
  })

  const canCreate = name.trim() && cron.trim() && input.trim()

  return (
    <Panel className="overflow-hidden">
      <PanelContent className="space-y-3">
        <div>
          <h3 className="text-sm font-medium">Schedules</h3>
          <p className="text-muted-foreground text-xs">Run this agent on a cron — each firing starts a session.</p>
        </div>

        {isLoading ? (
          <p className="text-muted-foreground text-xs">Loading…</p>
        ) : isError ? (
          <div className="space-y-2">
            <p className="text-xs text-red-600 dark:text-red-500">Couldn’t load schedules.</p>
            <Button size="sm" variant="outline" onClick={() => void refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            {repoManaged ? (
              <p className="text-muted-foreground text-xs">
                Managed by the linked repository — edit <code className="font-mono">agent.toml</code> to change. You can
                still pause/resume here.
              </p>
            ) : null}

            {schedules && schedules.length > 0 ? (
              <ul className="space-y-2">
                {schedules.map((s) => (
                  <li key={s.id} className="bg-muted/40 space-y-1 rounded-md p-2 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium">{s.name}</span>
                      <StatePill s={s} />
                    </div>
                    <div className="text-muted-foreground flex flex-wrap items-center gap-x-2">
                      <code className="font-mono">{s.cron}</code>
                      {s.tz ? <span>{s.tz}</span> : null}
                      <span>· next {s.state === 'active' ? rel(s.next_fire_at) : '—'}</span>
                      {s.last_fired_at ? <span>· last {rel(s.last_fired_at)}</span> : null}
                    </div>
                    <div className="flex items-center gap-1 pt-0.5">
                      <Button
                        size="sm"
                        variant="ghost"
                        title={s.state === 'active' ? 'Pause' : 'Resume'}
                        disabled={toggle.isPending}
                        onClick={() => toggle.mutate(s)}
                      >
                        {s.state === 'active' ? <Pause className="size-3.5" /> : <PlayCircle className="size-3.5" />}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Test-fire now"
                        disabled={fire.isPending}
                        onClick={() => fire.mutate(s)}
                      >
                        <Play className="size-3.5" />
                      </Button>
                      {!repoManaged ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-muted-foreground hover:text-red-600"
                          title="Delete"
                          disabled={remove.isPending}
                          onClick={() => remove.mutate(s)}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted-foreground text-xs">No schedules yet.</p>
            )}

            {!repoManaged ? (
              showForm ? (
                <div className="bg-muted/40 space-y-2 rounded-md p-2">
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="name (e.g. morning-sweep)" />
                  <div className="flex gap-2">
                    <Input
                      value={cron}
                      onChange={(e) => setCron(e.target.value)}
                      placeholder="0 9 * * 1-5"
                      className="font-mono"
                    />
                    <Input
                      value={tz}
                      onChange={(e) => setTz(e.target.value)}
                      placeholder="UTC"
                      className="max-w-32"
                    />
                  </div>
                  <Input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder="first message of every run"
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={create.isPending || !canCreate}
                      onClick={() => create.mutate()}
                    >
                      {create.isPending ? 'Creating…' : 'Create'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setShowForm(false)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <Button size="sm" variant="outline" onClick={() => setShowForm(true)}>
                  <Plus className="size-4" />
                  New schedule
                </Button>
              )
            ) : null}

            <p className="text-muted-foreground text-xs">
              Or use the CLI: <code className="font-mono">oc agent schedule create</code>
            </p>
          </>
        )}
      </PanelContent>
    </Panel>
  )
}

