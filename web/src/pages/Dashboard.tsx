import { useEffect, useRef, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Boxes } from 'lucide-react'
import {
  createAPIKey,
  getAPIKeys,
  getSessions,
  type Session,
} from '@/api/client'
import { PageHeader } from '@/components/page-header'
import {
  Panel,
  PanelContent,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { MetricCard } from '@/components/metric-card'
import { CopyRow } from '@/components/copy-row'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/empty-state'
import { ResourceTable, type Column } from '@/components/resource-table'
import { Skeleton } from '@/components/ui/skeleton'

const SKILL_INSTALL_CMD = 'npx skills add diggerhq/opencomputer'

function formatDuration(session: Session): string {
  const start = new Date(session.startedAt).getTime()
  const end = session.stoppedAt
    ? new Date(session.stoppedAt).getTime()
    : Date.now()
  const secs = Math.round((end - start) / 1000)
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.round(secs / 60)}m`
  return `${Math.round((secs / 3600) * 10) / 10}h`
}

function elapsedMinutes(session: Session): number {
  return Math.round(
    (Date.now() - new Date(session.startedAt).getTime()) / 1000 / 60,
  )
}

export default function Dashboard() {
  const { data: runningSessions, isLoading: loadingRunning } = useQuery({
    queryKey: ['sessions', 'running'],
    queryFn: () => getSessions('running'),
  })
  const { data: allSessions, isLoading: loadingAll } = useQuery({
    queryKey: ['sessions', ''],
    queryFn: () => getSessions(),
  })

  const active = runningSessions ?? []
  const all = allSessions ?? []
  const today = new Date().toISOString().slice(0, 10)
  const sessionsToday = all.filter(
    (s) => new Date(s.startedAt).toISOString().slice(0, 10) === today,
  ).length
  const isFirstRun = !loadingAll && all.length === 0

  const recentColumns: Column<Session>[] = [
    {
      key: 'id',
      header: 'Sandbox ID',
      cell: (s) => (
        <Link
          to={`/sessions/${s.sandboxId}`}
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
      key: 'duration',
      header: 'Duration',
      cell: (s) => (
        <span className="text-muted-foreground font-mono text-xs">
          {formatDuration(s)}
        </span>
      ),
    },
  ]

  return (
    <div>
      <PageHeader
        title={isFirstRun ? 'Welcome to OpenComputer' : 'Dashboard'}
        description={
          isFirstRun
            ? 'Get your first sandbox running in two steps'
            : 'Overview of your sandbox infrastructure'
        }
      />

      {isFirstRun ? (
        <GettingStarted />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <MetricCard
              label="Active sandboxes"
              value={loadingRunning ? '—' : active.length.toLocaleString()}
            />
            <MetricCard
              label="Sessions today"
              value={loadingAll ? '—' : sessionsToday.toLocaleString()}
            />
          </div>

          <Panel>
            <PanelHeader>
              <PanelTitle>Live sandboxes</PanelTitle>
              {active.length > 0 ? (
                <span className="text-status-running flex items-center gap-1.5 font-mono text-xs">
                  <span className="bg-status-running size-1.5 animate-pulse rounded-full" />
                  {active.length} active
                </span>
              ) : null}
            </PanelHeader>
            <PanelContent>
              {loadingRunning ? (
                <div className="space-y-2">
                  <Skeleton className="h-12 w-full" />
                  <Skeleton className="h-12 w-full" />
                </div>
              ) : active.length === 0 ? (
                <p className="text-muted-foreground py-6 text-center text-sm">
                  No sandboxes running
                </p>
              ) : (
                <div className="flex max-h-[320px] flex-col gap-1.5 overflow-y-auto">
                  {active.map((s) => (
                    <SandboxRow key={s.id} session={s} />
                  ))}
                </div>
              )}
            </PanelContent>
          </Panel>

          <Panel className="overflow-hidden">
            <PanelHeader>
              <PanelTitle>Recent sessions</PanelTitle>
            </PanelHeader>
            <ResourceTable
              columns={recentColumns}
              rows={all.slice(0, 20)}
              rowKey={(s) => s.id}
              loading={loadingAll}
              empty={
                <EmptyState
                  icon={Boxes}
                  title="No sessions yet"
                  description="Sandboxes you start will show up here."
                />
              }
            />
          </Panel>
        </div>
      )}
    </div>
  )
}

function SandboxRow({ session }: { session: Session }) {
  const elapsed = elapsedMinutes(session)
  return (
    <Link
      to={`/sessions/${session.sandboxId}`}
      className="hover:bg-row-hover flex items-center justify-between rounded-md border px-3 py-2.5 transition-colors"
    >
      <div className="flex items-center gap-2.5">
        <span className="bg-status-running size-1.5 shrink-0 animate-pulse rounded-full" />
        <div>
          <code className="text-foreground font-mono text-xs">
            {session.sandboxId}
          </code>
          <div className="text-muted-foreground text-[11px]">
            {session.template || 'base'}
          </div>
        </div>
      </div>
      <span className="text-muted-foreground font-mono text-xs">
        {elapsed}m
      </span>
    </Link>
  )
}

/* ── First-run onboarding ─────────────────────────────────────────────────── */
function GettingStarted() {
  const queryClient = useQueryClient()
  const { data: keys, isLoading: loadingKeys } = useQuery({
    queryKey: ['api-keys'],
    queryFn: getAPIKeys,
  })
  const autoCreateRef = useRef(false)

  const createMutation = useMutation({
    mutationFn: () => createAPIKey('Default'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['api-keys'] }),
  })

  const hasKeys = (keys?.length ?? 0) > 0
  const createdKey = createMutation.data?.key ?? null

  // On first signup (no keys), auto-create a Default key so the user sees it
  // immediately without clicking anything.
  useEffect(() => {
    if (loadingKeys || autoCreateRef.current) return
    if (!hasKeys && !createdKey && !createMutation.isPending) {
      autoCreateRef.current = true
      createMutation.mutate()
    }
  }, [loadingKeys, hasKeys, createdKey, createMutation])

  return (
    <div className="space-y-4">
      <StepCard
        index={1}
        title="Install the OpenComputer skill"
        description="Adds OpenComputer sandbox controls to Claude Code so you can create, inspect, and manage sandboxes from your terminal."
      >
        <CopyRow value={SKILL_INSTALL_CMD} />
      </StepCard>

      <StepCard
        index={2}
        title="Your API key"
        description="The skill uses this key to authenticate with OpenComputer. We've created a Default key for you — copy it now, you won't be able to see it again."
      >
        {loadingKeys || createMutation.isPending ? (
          <p className="text-muted-foreground text-sm">
            Preparing your API key…
          </p>
        ) : null}

        {createdKey ? (
          <div className="space-y-2.5">
            <CopyRow value={createdKey} maskable />
            <p className="text-muted-foreground text-xs">
              Then run this in your terminal to configure the CLI:
            </p>
            <CopyRow
              value={createdKey}
              maskable
              transform={(s) => `oc config set api-key ${s}`}
            />
          </div>
        ) : null}

        {!createdKey && !createMutation.isPending && hasKeys ? (
          <p className="text-muted-foreground text-sm">
            You already have {keys!.length} API key
            {keys!.length === 1 ? '' : 's'} from a previous session. For
            security, existing key values can&apos;t be re-displayed.{' '}
            <Link
              to="/api-keys"
              className="text-foreground font-medium underline underline-offset-4"
            >
              Manage keys
            </Link>{' '}
            to rotate.
          </p>
        ) : null}

        {createMutation.isError ? (
          <div className="flex items-center gap-3">
            <span className="text-status-error text-sm">
              Failed to create your API key.
            </span>
            <button
              className="text-foreground text-sm font-medium underline underline-offset-4"
              onClick={() => createMutation.mutate()}
            >
              Retry
            </button>
          </div>
        ) : null}
      </StepCard>
    </div>
  )
}

function StepCard({
  index,
  title,
  description,
  children,
}: {
  index: number
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <Panel className="p-5">
      <div className="flex items-start gap-4">
        <span className="bg-secondary flex size-7 shrink-0 items-center justify-center rounded-full font-mono text-sm font-semibold">
          {index}
        </span>
        <div className="flex-1 space-y-3">
          <div className="space-y-1">
            <h3 className="text-foreground text-sm font-semibold">{title}</h3>
            <p className="text-muted-foreground text-sm">{description}</p>
          </div>
          {children}
        </div>
      </div>
    </Panel>
  )
}
