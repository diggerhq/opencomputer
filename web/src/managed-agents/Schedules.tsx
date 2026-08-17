import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, Loader2, Play } from 'lucide-react'
import { Link } from 'react-router-dom'
import { EmptyState } from '@/components/empty-state'
import {
  Panel,
  PanelContent,
  PanelDescription,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { ResourceTable, type Column } from '@/components/resource-table'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { notifyError } from '@/lib/errors'
import {
  getManagedAgentScheduleRuns,
  getManagedAgentSchedules,
  runManagedAgentSchedule,
  type ManagedAgentSchedule,
} from './api'
import { projectContextSearch } from './project-context'

function formatDate(value?: string) {
  return value ? new Date(value).toLocaleString() : 'Never'
}

export function ManagedAgentSchedules({
  projectId,
  agentId,
  environment,
  deployed,
}: {
  projectId: string
  agentId: string
  environment: 'development' | 'production'
  deployed: boolean
}) {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<ManagedAgentSchedule>()
  const schedules = useQuery({
    queryKey: ['managed-agent-schedules', projectId, agentId, environment],
    queryFn: () => getManagedAgentSchedules(projectId, agentId, environment),
    enabled: deployed,
    refetchInterval: 10_000,
  })
  const runs = useQuery({
    queryKey: ['managed-agent-schedule-runs', projectId, agentId, environment],
    queryFn: () => getManagedAgentScheduleRuns(projectId, agentId, environment),
    enabled: deployed,
    refetchInterval: 5_000,
  })
  const runNow = useMutation({
    mutationFn: (scheduleId: string) =>
      runManagedAgentSchedule(projectId, agentId, environment, scheduleId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: [
            'managed-agent-schedule-runs',
            projectId,
            agentId,
            environment,
          ],
        }),
        queryClient.invalidateQueries({
          queryKey: ['managed-agent-sessions', agentId],
        }),
      ])
    },
    onError: (error) => notifyError("Couldn't run that schedule.", error),
  })

  if (!deployed) {
    return (
      <Panel>
        <EmptyState
          icon={CalendarClock}
          title={`No active ${environment} deployment`}
          description="Deploy this project to activate its schedules in this environment."
        />
      </Panel>
    )
  }
  if (schedules.isError || runs.isError) {
    return (
      <Panel>
        <EmptyState
          icon={CalendarClock}
          title="Schedules are temporarily unavailable"
          description="Try loading this environment again."
        />
      </Panel>
    )
  }

  const columns: Column<ManagedAgentSchedule>[] = [
    {
      key: 'schedule',
      header: 'Schedule',
      cell: (schedule) => (
        <div>
          <p className="text-sm font-medium">{schedule.id}</p>
          <p className="text-muted-foreground mt-1 font-mono text-xs">
            {schedule.cron} · {schedule.timezone}
          </p>
        </div>
      ),
    },
    {
      key: 'next',
      header: 'Next run',
      cell: (schedule) => (
        <span className="text-muted-foreground text-xs">
          {formatDate(schedule.nextRunAt)}
        </span>
      ),
    },
    {
      key: 'last',
      header: 'Last run',
      cell: (schedule) => (
        <span className="text-muted-foreground text-xs">
          {formatDate(schedule.lastRunAt)}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (schedule) => <StatusBadge status={schedule.status} />,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (schedule) => (
        <Button
          size="sm"
          variant="outline"
          disabled={runNow.isPending}
          onClick={(event) => {
            event.stopPropagation()
            runNow.mutate(schedule.id)
          }}
        >
          {runNow.isPending && runNow.variables === schedule.id ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Play />
          )}
          Run now
        </Button>
      ),
    },
  ]
  const selectedRuns = (runs.data ?? []).filter(
    (run) => run.scheduleId === selected?.id,
  )

  return (
    <>
      <Panel>
        <PanelHeader>
          <div>
            <PanelTitle>Schedules</PanelTitle>
            <PanelDescription>
              {environment === 'development'
                ? 'Development schedules run only when you choose Run now.'
                : 'Production schedules run automatically. Each run starts a fresh session.'}
            </PanelDescription>
          </div>
        </PanelHeader>
        <PanelContent className="p-0">
          <ResourceTable
            columns={columns}
            rows={schedules.data ?? []}
            rowKey={(schedule) => schedule.id}
            loading={schedules.isLoading}
            onRowClick={setSelected}
            empty={
              <EmptyState
                icon={CalendarClock}
                title={`No ${environment} schedules`}
                description="Add a schedule under this agent's schedules folder and deploy it."
              />
            }
          />
        </PanelContent>
      </Panel>

      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => !open && setSelected(undefined)}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{selected?.id}</DialogTitle>
            <DialogDescription>
              {selected?.cron} · {selected?.timezone} · overlap{' '}
              {selected?.overlap}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[26rem] overflow-y-auto rounded-md border">
            {selectedRuns.length ? (
              <div className="divide-y">
                {selectedRuns.map((run) => (
                  <div
                    key={run.id}
                    className="flex items-center justify-between gap-4 p-3"
                  >
                    <div>
                      <p className="text-sm">{formatDate(run.scheduledAt)}</p>
                      <p className="text-muted-foreground mt-1 text-xs">
                        {run.manual ? 'Manual run' : 'Scheduled run'} · attempt{' '}
                        {run.attempt}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <StatusBadge status={run.outcome} />
                      {run.sessionId ? (
                        <Link
                          className="font-mono text-xs underline underline-offset-2"
                          to={{
                            pathname: `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(run.sessionId)}`,
                            search: projectContextSearch(
                              '',
                              agentId,
                              environment,
                            ),
                          }}
                        >
                          Session
                        </Link>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground p-6 text-sm">
                No runs recorded yet.
              </p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
