import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Boxes } from 'lucide-react'
import { notifyError } from '@/lib/errors'
import { deleteSession, getSessions, type Session } from '@/api/client'
import { PageHeader } from '@/components/page-header'
import { Panel } from '@/components/panel'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/empty-state'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { ResourceTable, type Column } from '@/components/resource-table'
import { cn } from '@/lib/utils'

const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'hibernated', label: 'Hibernated' },
  { value: 'error', label: 'Error' },
] as const

function canDeleteSession(session: Session) {
  return session.status === 'running' || session.status === 'hibernated'
}

export default function Sessions() {
  const queryClient = useQueryClient()
  const [status, setStatus] = useState<string>('')
  const [toDelete, setToDelete] = useState<Session | null>(null)

  const { data: sessions, isLoading } = useQuery({
    queryKey: ['sessions', status],
    queryFn: () => getSessions(status || undefined),
  })

  // Always fetch all sessions for the activity chart.
  const { data: allSessions, isLoading: loadingAll } = useQuery({
    queryKey: ['sessions', ''],
    queryFn: () => getSessions(),
  })

  const deleteMutation = useMutation({
    mutationFn: (sandboxId: string) => deleteSession(sandboxId),
    onMutate: async (sandboxId) => {
      await queryClient.cancelQueries({ queryKey: ['sessions'] })
      const stoppedAt = new Date().toISOString()
      queryClient.setQueriesData<Session[]>({ queryKey: ['sessions'] }, (old) =>
        old?.map((session) =>
          session.sandboxId === sandboxId
            ? { ...session, status: 'stopped', stoppedAt }
            : session,
        ),
      )
    },
    onError: (error) => notifyError("Couldn't delete the sandbox.", error),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['sessions'] })
    },
  })

  const confirmDelete = () => {
    if (!toDelete) return
    deleteMutation.mutate(toDelete.sandboxId, {
      onSuccess: () => setToDelete(null),
    })
  }

  const columns: Column<Session>[] = [
    {
      key: 'id',
      header: 'Sandbox ID',
      cell: (s) => (
        <Link
          to={`/sandboxes/${s.sandboxId}`}
          className="text-foreground font-mono text-[13px] underline-offset-4 hover:underline"
        >
          {s.sandboxId}
        </Link>
      ),
    },
    {
      key: 'template',
      header: 'Template',
      cell: (s) => (
        <span className="text-muted-foreground">{s.template || 'base'}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (s) => <StatusBadge status={s.status} />,
    },
    {
      key: 'started',
      header: 'Started',
      cell: (s) => (
        <span className="text-muted-foreground font-mono text-xs">
          {new Date(s.startedAt).toLocaleString()}
        </span>
      ),
    },
    {
      key: 'stopped',
      header: 'Stopped',
      cell: (s) => (
        <span className="text-muted-foreground font-mono text-xs">
          {s.stoppedAt ? new Date(s.stoppedAt).toLocaleString() : '—'}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (s) =>
        canDeleteSession(s) ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-status-error hover:bg-status-error-bg hover:text-status-error"
            onClick={() => setToDelete(s)}
          >
            Delete
          </Button>
        ) : null,
    },
  ]

  return (
    <div>
      <PageHeader title="Sandboxes" description="Active and recent sandboxes" />

      <ActivityChart sessions={allSessions ?? []} loading={loadingAll} />

      <div className="mb-4 flex flex-wrap gap-1.5">
        {STATUS_FILTERS.map((f) => (
          <Button
            key={f.value}
            size="sm"
            variant={status === f.value ? 'default' : 'ghost'}
            onClick={() => setStatus(f.value)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      <Panel className="overflow-hidden">
        <ResourceTable
          columns={columns}
          rows={sessions ?? []}
          rowKey={(s) => s.id}
          loading={isLoading}
          empty={
            <EmptyState
              icon={Boxes}
              title="No sandboxes found"
              description={
                status
                  ? 'No sandboxes match this filter.'
                  : 'Sandboxes you start will show up here.'
              }
            />
          }
        />
      </Panel>

      <ConfirmDialog
        open={toDelete !== null}
        onOpenChange={(open) => !open && setToDelete(null)}
        title={`Delete sandbox ${toDelete?.sandboxId ?? ''}?`}
        description="The sandbox will be stopped and its preview URLs removed."
        confirmLabel="Delete sandbox"
        destructive
        pending={deleteMutation.isPending}
        onConfirm={confirmDelete}
      />
    </div>
  )
}

/* ── Activity chart (last 14 days) ──────────────────────────────────────────
   Hand-built positioned divs (not recharts) — kept as a data-driven inline
   geometry per the migration contract; only the chrome + colors are reskinned.
   A recharts rebuild is a follow-up. */
function ActivityChart({
  sessions,
  loading,
}: {
  sessions: Session[]
  loading: boolean
}) {
  const { days, maxCount } = useMemo(() => {
    const now = new Date()
    const dayBuckets: {
      label: string
      date: string
      count: number
      hibernated: number
      errored: number
    }[] = []

    for (let i = 13; i >= 0; i--) {
      const d = new Date(now)
      d.setDate(d.getDate() - i)
      const dateStr = d.toISOString().slice(0, 10)
      dayBuckets.push({
        label: d.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
        }),
        date: dateStr,
        count: 0,
        hibernated: 0,
        errored: 0,
      })
    }

    for (const s of sessions) {
      const dateStr = new Date(s.startedAt).toISOString().slice(0, 10)
      const bucket = dayBuckets.find((b) => b.date === dateStr)
      if (bucket) {
        bucket.count++
        if (s.status === 'hibernated') bucket.hibernated++
        else if (s.status === 'error') bucket.errored++
      }
    }

    const maxCount = Math.max(1, ...dayBuckets.map((b) => b.count))
    return { days: dayBuckets, maxCount }
  }, [sessions])

  const total = days.reduce((n, d) => n + d.count, 0)

  return (
    <Panel className="mb-6 px-6 py-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Activity</h2>
        <span className="text-muted-foreground font-mono text-xs">
          Last 14 days
        </span>
      </div>

      {loading ? (
        <Skeleton className="h-[150px] w-full" />
      ) : (
        <div className="relative">
          {/* Accessible summary (chart is decorative; this conveys the data). */}
          <p className="sr-only">
            {total} sandboxes started in the last 14 days.
          </p>

          {/* Y-axis */}
          <div className="absolute top-0 bottom-6 left-0 flex w-8 flex-col justify-between">
            <span className="text-muted-foreground font-mono text-[10px]">
              {maxCount}
            </span>
            <span className="text-muted-foreground font-mono text-[10px]">
              0
            </span>
          </div>

          {/* Bars */}
          <div className="ml-9 flex h-[120px] items-end gap-1" aria-hidden>
            {days.map((day) => {
              const barHeight =
                maxCount > 0 ? Math.round((day.count / maxCount) * 110) : 0
              return (
                <div
                  key={day.date}
                  title={`${day.label}: ${day.count} sandboxes${
                    day.hibernated ? ` (${day.hibernated} hibernated)` : ''
                  }${day.errored ? ` (${day.errored} errors)` : ''}`}
                  className={cn(
                    'bg-foreground/70 relative flex-1 rounded-t-sm transition-[height] duration-300',
                    day.count > 0 ? '' : 'bg-transparent',
                  )}
                  style={{ height: day.count > 0 ? Math.max(barHeight, 4) : 0 }}
                >
                  {day.count > 0 && (
                    <span className="text-muted-foreground absolute -top-4 left-1/2 -translate-x-1/2 font-mono text-[9px] whitespace-nowrap">
                      {day.count}
                    </span>
                  )}
                </div>
              )
            })}
          </div>

          {/* X-axis */}
          <div className="mt-1.5 ml-9 flex gap-1" aria-hidden>
            {days.map((day, i) => (
              <div
                key={day.date}
                className="text-muted-foreground flex-1 text-center font-mono text-[9px]"
              >
                {i % 2 === 0 ? day.label : ''}
              </div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  )
}
