import { useEffect, useRef, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { Boxes, MessagesSquare } from 'lucide-react'
import {
  createAPIKey,
  getAPIKeys,
  getSandboxes,
  getSessions,
  getAgents,
  type Sandbox,
} from '@/api/client'
import type { Session } from '@/api/schemas'
import { usePrefetchSandbox } from '@/hooks/use-prefetch'
import { PageHeader } from '@/components/page-header'
import { Panel, PanelHeader, PanelTitle } from '@/components/panel'
import { MetricCard } from '@/components/metric-card'
import { CopyRow } from '@/components/copy-row'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/empty-state'
import { ResourceTable, type Column } from '@/components/resource-table'

const SKILL_INSTALL_CMD = 'npx skills add diggerhq/opencomputer'

function formatDuration(sandbox: Sandbox): string {
  const start = new Date(sandbox.startedAt).getTime()
  const end = sandbox.stoppedAt
    ? new Date(sandbox.stoppedAt).getTime()
    : Date.now()
  const secs = Math.round((end - start) / 1000)
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.round(secs / 60)}m`
  return `${Math.round((secs / 3600) * 10) / 10}h`
}

// A session is "live" until it reaches a terminal state. Excluding terminal
// states (rather than allow-listing live ones) keeps new/unknown live statuses
// counted as active.
const TERMINAL_SESSION = new Set([
  'archived',
  'failed',
  'completed',
  'complete',
  'canceled',
  'cancelled',
  'error',
  'errored',
  'done',
  'expired',
])
const isLiveSession = (s: Session) =>
  !TERMINAL_SESSION.has(s.status.toLowerCase())

export default function Dashboard() {
  const prefetch = usePrefetchSandbox()

  const { data: runningSandboxesData, isLoading: loadingRunningSandboxes } =
    useQuery({
      queryKey: ['sandboxes', 'running'],
      queryFn: () => getSandboxes('running'),
    })
  const { data: allSandboxesData, isLoading: loadingSandboxes } = useQuery({
    queryKey: ['sandboxes', ''],
    queryFn: () => getSandboxes(),
  })
  const { data: sessionsData, isLoading: loadingSessions } = useQuery({
    queryKey: ['sessions'],
    queryFn: () => getSessions(),
  })
  const { data: agentsData } = useQuery({
    queryKey: ['agents'],
    queryFn: getAgents,
  })

  const activeSandboxes = runningSandboxesData ?? []
  const allSandboxes = allSandboxesData ?? []
  const sessions = sessionsData ?? []
  const agents = agentsData ?? []

  const today = new Date().toISOString().slice(0, 10)
  const isToday = (iso: string) =>
    new Date(iso).toISOString().slice(0, 10) === today

  const sandboxesToday = allSandboxes.filter((s) => isToday(s.startedAt)).length
  const activeSessions = sessions.filter(isLiveSession)
  const sessionsToday = sessions.filter((s) => isToday(s.created_at)).length

  const agentName = (id?: string | null) =>
    agents.find((a) => a.id === id)?.name ?? id ?? '—'

  // First-run only when the org has neither sessions nor sandboxes — an org that
  // already runs agent sessions (but no raw sandboxes) is not a new user.
  const isFirstRun =
    !loadingSandboxes &&
    !loadingSessions &&
    allSandboxes.length === 0 &&
    sessions.length === 0

  const sessionColumns: Column<Session>[] = [
    {
      key: 'id',
      header: 'Session',
      cell: (s) => (
        <Link
          to={`/sessions/${s.id}`}
          className="text-foreground font-mono text-[13px] underline-offset-4 hover:underline"
        >
          {s.id}
        </Link>
      ),
    },
    {
      key: 'agent',
      header: 'Agent',
      cell: (s) => (
        <span className="text-muted-foreground">{agentName(s.agent_id)}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (s) => <StatusBadge status={s.status} />,
    },
    {
      key: 'created',
      header: 'Created',
      cell: (s) => (
        <span className="text-muted-foreground font-mono text-xs">
          {new Date(s.created_at).toLocaleString()}
        </span>
      ),
    },
  ]

  const sandboxColumns: Column<Sandbox>[] = [
    {
      key: 'id',
      header: 'Sandbox ID',
      cell: (s) => (
        <Link
          to={`/sandboxes/${s.sandboxId}`}
          onMouseEnter={() => prefetch(s.sandboxId)}
          onFocus={() => prefetch(s.sandboxId)}
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
            ? 'Get started in two steps'
            : 'Overview of your agent sessions and sandboxes'
        }
      />

      {isFirstRun ? (
        <GettingStarted />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <MetricCard
              label="Active agent sessions"
              value={
                loadingSessions ? '—' : activeSessions.length.toLocaleString()
              }
            />
            <MetricCard
              label="Agent sessions today"
              value={loadingSessions ? '—' : sessionsToday.toLocaleString()}
            />
            <MetricCard
              label="Active sandboxes"
              value={
                loadingRunningSandboxes
                  ? '—'
                  : activeSandboxes.length.toLocaleString()
              }
            />
            <MetricCard
              label="Sandboxes today"
              value={loadingSandboxes ? '—' : sandboxesToday.toLocaleString()}
            />
          </div>

          <Panel className="overflow-hidden">
            <PanelHeader>
              <PanelTitle>Recent agent sessions</PanelTitle>
              <Link
                to="/sessions"
                className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
              >
                View all
              </Link>
            </PanelHeader>
            <ResourceTable
              columns={sessionColumns}
              rows={sessions.slice(0, 10)}
              rowKey={(s) => s.id}
              loading={loadingSessions}
              empty={
                <EmptyState
                  icon={MessagesSquare}
                  title="No sessions yet"
                  description="Start a session from an agent to give it a durable task."
                />
              }
            />
          </Panel>

          <Panel className="overflow-hidden">
            <PanelHeader>
              <PanelTitle>Recent sandboxes</PanelTitle>
              <Link
                to="/sandboxes"
                className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
              >
                View all
              </Link>
            </PanelHeader>
            <ResourceTable
              columns={sandboxColumns}
              rows={allSandboxes.slice(0, 10)}
              rowKey={(s) => s.id}
              loading={loadingSandboxes}
              empty={
                <EmptyState
                  icon={Boxes}
                  title="No sandboxes yet"
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

/* ── First-run onboarding ─────────────────────────────────────────────────── */
function GettingStarted() {
  const queryClient = useQueryClient()
  const {
    data: keys,
    isLoading: loadingKeys,
    isSuccess: keysLoaded,
  } = useQuery({
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
    // Only auto-create after a SUCCESSFUL (empty) keys list — never after the
    // list errored (keys would be undefined → falsely "no keys").
    if (!keysLoaded || autoCreateRef.current) return
    if (!hasKeys && !createdKey && !createMutation.isPending) {
      autoCreateRef.current = true
      createMutation.mutate()
    }
  }, [keysLoaded, hasKeys, createdKey, createMutation])

  return (
    <div className="space-y-4">
      <StepCard
        index={1}
        title="Install the OpenComputer skill"
        description="Adds OpenComputer controls to Claude Code so you can create and manage agents, sessions, and sandboxes from your terminal."
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
