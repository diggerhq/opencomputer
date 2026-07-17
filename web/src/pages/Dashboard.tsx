import { useEffect, useRef, type KeyboardEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import {
  Bot,
  Boxes,
  Check,
  Code2,
  Copy,
  ExternalLink,
  KeyRound,
  MessagesSquare,
} from 'lucide-react'
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
import {
  Panel,
  PanelContent,
  PanelDescription,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { MetricCard } from '@/components/metric-card'
import { CopyRow } from '@/components/copy-row'
import { GithubMark } from '@/components/github-mark'
import { ManualAgentForm } from '@/components/manual-agent-form'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/empty-state'
import { ResourceTable, type Column } from '@/components/resource-table'
import { Button } from '@/components/ui/button'
import { notifyError } from '@/lib/errors'
import { useTransientFlag } from '@/lib/use-transient-flag'
import { cn } from '@/lib/utils'
import { RepositoryImportPanel, RepositoryStarterGuide } from './AgentNew'

const SANDBOX_API_CODE = `const sandbox = await Sandbox.create();
const result =
  await sandbox.commands.run("uname -a");

console.log(result.stdout);
await sandbox.kill();`

const SESSION_API_CODE = `const oc = new OpenComputer({ apiKey });
const session = await oc.sessions.create({
  agent: "agt_...",
  input: "Triage support requests.",
});
console.log(session.id);`

type StartDirection = 'github' | 'prompt' | 'api'

const START_DIRECTIONS = [
  {
    id: 'github',
    title: 'Agent from GitHub',
    description: 'Deploy a Flue repository.',
    icon: GithubMark,
  },
  {
    id: 'prompt',
    title: 'Agent from a prompt',
    description: 'Claude Code, Codex, or Pi.',
    icon: Bot,
  },
  {
    id: 'api',
    title: 'Build with the API',
    description: 'Durable sessions & sandboxes.',
    icon: Code2,
  },
] as const

function startDirection(value: string | null): StartDirection {
  return value === 'prompt' || value === 'api' ? value : 'github'
}

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
  const location = useLocation()
  // Getting started is its own left-nav item (/getting-started). Brand-new orgs
  // also see it inline on first run (at /).
  const onGettingStartedRoute = location.pathname === '/getting-started'

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

  // Genuine first-run auto-shows onboarding; returning users reach it via the
  // left-nav "Getting started" item (/getting-started).
  const showOnboarding = isFirstRun || onGettingStartedRoute

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
      {!showOnboarding && (
        <PageHeader
          title="Dashboard"
          description="Overview of your agent sessions and sandboxes"
        />
      )}

      {showOnboarding ? (
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
export function GettingStarted() {
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedDirection = startDirection(searchParams.get('start'))
  const directionRefs = useRef<Array<HTMLButtonElement | null>>([])
  const keysQuery = useQuery({
    queryKey: ['api-keys'],
    queryFn: getAPIKeys,
  })
  const autoCreateRef = useRef(false)

  const createMutation = useMutation({
    mutationFn: () => createAPIKey('Default'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['api-keys'] }),
  })

  const keys = keysQuery.data
  const hasKeys = (keys?.length ?? 0) > 0
  const createdKey = createMutation.data?.key ?? null

  // New organizations get one usable key without an extra setup step. Existing
  // secrets remain intentionally unrecoverable; those users get the key manager.
  useEffect(() => {
    if (!keysQuery.isSuccess || autoCreateRef.current) return
    if (!hasKeys && !createdKey && !createMutation.isPending) {
      autoCreateRef.current = true
      createMutation.mutate()
    }
  }, [keysQuery.isSuccess, hasKeys, createdKey, createMutation])

  const selectDirection = (direction: StartDirection) => {
    setSearchParams(direction === 'github' ? {} : { start: direction }, {
      replace: true,
    })
  }

  const onDirectionKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let nextIndex: number | null = null
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (index + 1) % START_DIRECTIONS.length
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex =
        (index - 1 + START_DIRECTIONS.length) % START_DIRECTIONS.length
    } else if (event.key === 'Home') {
      nextIndex = 0
    } else if (event.key === 'End') {
      nextIndex = START_DIRECTIONS.length - 1
    }
    if (nextIndex == null) return

    event.preventDefault()
    selectDirection(START_DIRECTIONS[nextIndex].id)
    requestAnimationFrame(() => directionRefs.current[nextIndex]?.focus())
  }

  return (
    <div className="mx-auto max-w-5xl pb-12">
      <div
        className="bg-border grid gap-px overflow-hidden rounded-lg border sm:grid-cols-3"
        role="tablist"
        aria-label="Choose how to start"
      >
        {START_DIRECTIONS.map((direction, index) => {
          const active = selectedDirection === direction.id
          const Icon = direction.icon
          return (
            <button
              key={direction.id}
              ref={(node) => {
                directionRefs.current[index] = node
              }}
              id={`start-tab-${direction.id}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`start-panel-${direction.id}`}
              tabIndex={active ? 0 : -1}
              onClick={() => selectDirection(direction.id)}
              onKeyDown={(event) => onDirectionKeyDown(event, index)}
              className={cn(
                'focus-visible:ring-ring/50 bg-background flex min-h-24 items-start gap-3 p-4 text-left transition-colors outline-none focus-visible:z-10 focus-visible:ring-3 focus-visible:ring-inset',
                active ? 'bg-row-selected' : 'hover:bg-row-hover',
              )}
            >
              <div aria-hidden>
                <Icon
                  className={cn(
                    'mt-0.5 size-4 shrink-0',
                    active ? 'text-foreground' : 'text-muted-foreground',
                  )}
                />
              </div>
              <span className="min-w-0">
                <span className="block text-sm font-semibold">
                  {direction.title}
                </span>
                <span className="text-muted-foreground mt-1 block text-xs leading-5">
                  {direction.description}
                </span>
              </span>
            </button>
          )
        })}
      </div>

      {selectedDirection === 'github' ? (
        <section
          id="start-panel-github"
          role="tabpanel"
          aria-labelledby="start-tab-github"
          className="mt-8"
        >
          <div className="grid items-start gap-6 xl:grid-cols-3">
            <div className="min-w-0 xl:col-span-2">
              <RepositoryImportPanel />
            </div>
            <RepositoryStarterGuide />
          </div>
        </section>
      ) : null}

      {selectedDirection === 'prompt' ? (
        <section
          id="start-panel-prompt"
          role="tabpanel"
          aria-labelledby="start-tab-prompt"
          className="mt-8"
        >
          <Panel>
            <PanelHeader>
              <div>
                <PanelTitle>Define the agent</PanelTitle>
                <PanelDescription className="mt-1">
                  Create a durable agent from its system prompt. You can connect
                  Slack after creation.
                </PanelDescription>
              </div>
            </PanelHeader>
            <PanelContent>
              <ManualAgentForm
                layout="wide"
                onCancel={() => selectDirection('github')}
              />
            </PanelContent>
          </Panel>
        </section>
      ) : null}

      {selectedDirection === 'api' ? (
        <section
          id="start-panel-api"
          role="tabpanel"
          aria-labelledby="start-tab-api"
          className="mt-8"
        >
          <Panel className="p-5">
            <div className="grid gap-4 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-start">
              <div className="flex items-center gap-2">
                <KeyRound
                  className="text-muted-foreground size-4"
                  aria-hidden
                />
                <div>
                  <h2 className="text-sm font-semibold">Your API key</h2>
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    OPENCOMPUTER_API_KEY
                  </p>
                </div>
              </div>

              <div className="min-w-0">
                {keysQuery.isLoading || createMutation.isPending ? (
                  <p className="text-muted-foreground py-2 text-sm">
                    Preparing your API key…
                  </p>
                ) : null}

                {createdKey ? (
                  <div className="space-y-2">
                    <CopyRow value={createdKey} maskable />
                    <p className="text-muted-foreground text-xs">
                      Copy it now. For security, it cannot be shown again.
                    </p>
                  </div>
                ) : null}

                {!createdKey && !createMutation.isPending && hasKeys ? (
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-muted-foreground text-sm">
                      API key ready. Existing secret values cannot be displayed.
                    </p>
                    <Button size="sm" variant="outline" asChild>
                      <Link to="/api-keys">Manage keys</Link>
                    </Button>
                  </div>
                ) : null}

                {keysQuery.isError ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-status-error text-sm">
                      Couldn&apos;t load your API keys.
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void keysQuery.refetch()}
                    >
                      Retry
                    </Button>
                  </div>
                ) : null}

                {createMutation.isError ? (
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-status-error text-sm">
                      Couldn&apos;t create your API key.
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => createMutation.mutate()}
                    >
                      Retry
                    </Button>
                  </div>
                ) : null}
              </div>
            </div>
          </Panel>

          <div className="mt-8 grid gap-10 md:grid-cols-2 md:gap-0 md:divide-x">
            <ApiExample
              icon={MessagesSquare}
              title="Durable agent sessions"
              description="Start and steer a durable agent run."
              code={SESSION_API_CODE}
              docs="https://docs.opencomputer.dev/agent-sessions/quickstart"
              docsLabel="Open sessions quickstart"
              className="md:pr-8"
            />
            <ApiExample
              icon={Boxes}
              title="Sandboxes"
              description="Run commands in an isolated computer."
              code={SANDBOX_API_CODE}
              docs="https://docs.opencomputer.dev/quickstart"
              docsLabel="Open sandbox quickstart"
              className="md:pl-8"
            />
          </div>
        </section>
      ) : null}
    </div>
  )
}

function ApiExample({
  icon: Icon,
  title,
  description,
  code,
  docs,
  docsLabel,
  className,
}: {
  icon: typeof Boxes
  title: string
  description: string
  code: string
  docs: string
  docsLabel: string
  className?: string
}) {
  const [copied, markCopied] = useTransientFlag(1500)

  const copy = () => {
    void navigator.clipboard.writeText(code).then(
      () => markCopied(),
      (error: unknown) => notifyError("Couldn't copy to clipboard.", error),
    )
  }

  return (
    <article className={cn('min-w-0', className)}>
      <div className="flex items-start gap-3">
        <span className="bg-secondary mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md">
          <Icon className="text-muted-foreground size-4" aria-hidden />
        </span>
        <div>
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-muted-foreground mt-1 text-sm leading-6">
            {description}
          </p>
        </div>
      </div>

      <div className="bg-panel-2 relative mt-4 overflow-hidden rounded-lg border">
        <pre className="overflow-x-auto p-4 pr-12 font-mono text-xs leading-5">
          <code>{code}</code>
        </pre>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="bg-panel-2 absolute top-2 right-2"
          onClick={copy}
          aria-label={copied ? 'Copied' : `Copy ${title} example`}
        >
          {copied ? (
            <Check className="size-3.5" />
          ) : (
            <Copy className="size-3.5" />
          )}
        </Button>
      </div>

      <Button variant="outline" size="sm" className="mt-4" asChild>
        <a href={docs} target="_blank" rel="noreferrer">
          {docsLabel}
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      </Button>
    </article>
  )
}
