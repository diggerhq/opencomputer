import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useLocation } from 'react-router-dom'
import { Boxes, Check, Copy, ExternalLink, KeyRound } from 'lucide-react'
import {
  createAPIKey,
  getAPIKeys,
  getSandboxes,
  type Sandbox,
} from '@/api/client'
import { usePrefetchSandbox } from '@/hooks/use-prefetch'
import { PageHeader } from '@/components/page-header'
import { Panel, PanelHeader, PanelTitle } from '@/components/panel'
import { MetricCard } from '@/components/metric-card'
import { CopyRow } from '@/components/copy-row'
import { StatusBadge } from '@/components/status-badge'
import { EmptyState } from '@/components/empty-state'
import { ResourceTable, type Column } from '@/components/resource-table'
import { Button } from '@/components/ui/button'
import { notifyError } from '@/lib/errors'
import { useTransientFlag } from '@/lib/use-transient-flag'
import { cn } from '@/lib/utils'

const SANDBOX_API_CODE = `const sandbox = await Sandbox.create();
const result =
  await sandbox.commands.run("uname -a");

console.log(result.stdout);
await sandbox.kill();`

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

  const activeSandboxes = runningSandboxesData ?? []
  const allSandboxes = allSandboxesData ?? []

  const today = new Date().toISOString().slice(0, 10)
  const isToday = (iso: string) =>
    new Date(iso).toISOString().slice(0, 10) === today

  const sandboxesToday = allSandboxes.filter((s) => isToday(s.startedAt)).length

  // First-run only when the org has no sandboxes yet.
  const isFirstRun = !loadingSandboxes && allSandboxes.length === 0

  // Genuine first-run auto-shows onboarding; returning users reach it via the
  // left-nav "Getting started" item (/getting-started).
  const showOnboarding = isFirstRun || onGettingStartedRoute

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
          description="Overview of your sandboxes"
        />
      )}

      {showOnboarding ? (
        <GettingStarted />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
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

  return (
    <div className="mx-auto max-w-5xl pb-12">
      <Panel className="p-5">
        <div className="grid gap-4 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-start">
          <div className="flex items-center gap-2">
            <KeyRound className="text-muted-foreground size-4" aria-hidden />
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

      <div className="mt-8">
        <ApiExample
          icon={Boxes}
          title="Sandboxes"
          description="Run commands in an isolated computer."
          code={SANDBOX_API_CODE}
          docs="https://docs.opencomputer.dev/quickstart"
          docsLabel="Open sandbox quickstart"
        />
      </div>
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
