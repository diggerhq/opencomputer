import { useInfiniteQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { GitBranch, History } from 'lucide-react'
import { getAgentDeployments, type AgentDeployment } from '@/api/client'
import { EmptyState } from '@/components/empty-state'
import {
  Panel,
  PanelContent,
  PanelDescription,
  PanelFooter,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { ResourceTable, type Column } from '@/components/resource-table'
import { StatusBadge } from '@/components/status-badge'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

function titleCase(value: string): string {
  const words = value.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function deploymentResult(deployment: AgentDeployment): string {
  if (deployment.error?.class) return titleCase(deployment.error.class)
  if (deployment.revision?.number != null) {
    return `Revision #${deployment.revision.number}${deployment.active ? ' · Active' : ''}`
  }
  if (deployment.state === 'skipped') return 'No change'
  if (deployment.result) return titleCase(deployment.result)
  return titleCase(deployment.phase)
}

function DeploymentSource({ deployment }: { deployment: AgentDeployment }) {
  const relation = deployment.source_relation
  const repo = relation?.repo?.full_name
  const ref = relation?.ref ?? relation?.production_ref ?? deployment.ref
  const sha = relation?.sha ?? deployment.sha

  if (!repo && !ref && !sha) {
    return (
      <span className="text-muted-foreground text-xs capitalize">
        {deployment.input_type}
      </span>
    )
  }

  return (
    <span className="block min-w-0">
      <span className="text-foreground flex items-center gap-1 text-xs">
        <GitBranch className="size-3 shrink-0" aria-hidden />
        <span className="max-w-52 truncate" title={repo ?? undefined}>
          {repo ?? 'Repository'}
        </span>
      </span>
      <span className="text-muted-foreground mt-0.5 block font-mono text-xs">
        {[ref, sha?.slice(0, 7)].filter(Boolean).join(' · ')}
      </span>
    </span>
  )
}

export function AgentDeployments({ agentId }: { agentId: string }) {
  const deploymentsQuery = useInfiniteQuery({
    queryKey: ['agent-deployments', agentId],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      getAgentDeployments(agentId, {
        before: pageParam ?? undefined,
        limit: 25,
      }),
    getNextPageParam: (lastPage) => lastPage.next_cursor,
    refetchInterval: (query) =>
      query.state.data?.pages.some((page) =>
        page.data.some((deployment) => !deployment.terminal),
      )
        ? 2500
        : false,
  })

  const deployments = Array.from(
    new Map(
      (deploymentsQuery.data?.pages.flatMap((page) => page.data) ?? []).map(
        (deployment) => [deployment.id, deployment],
      ),
    ).values(),
  )

  const columns: Column<AgentDeployment>[] = [
    {
      key: 'deployment',
      header: 'Deployment',
      cell: (deployment) => (
        <Link
          to={`/agents/${agentId}/deployments/${deployment.id}`}
          className="text-foreground font-mono text-xs underline-offset-4 hover:underline"
        >
          {deployment.id}
        </Link>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (deployment) => <StatusBadge status={deployment.state} />,
    },
    {
      key: 'source',
      header: 'Source',
      cell: (deployment) => <DeploymentSource deployment={deployment} />,
    },
    {
      key: 'result',
      header: 'Result',
      cell: (deployment) => (
        <span
          className="text-muted-foreground block max-w-48 truncate text-xs"
          title={deploymentResult(deployment)}
        >
          {deploymentResult(deployment)}
        </span>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      align: 'right',
      cell: (deployment) => (
        <time
          dateTime={deployment.created_at}
          className="text-muted-foreground font-mono text-xs whitespace-nowrap"
        >
          {new Date(deployment.created_at).toLocaleString()}
        </time>
      ),
    },
  ]

  const initialError = deploymentsQuery.isError && deployments.length === 0

  return (
    <Panel className="overflow-hidden">
      <PanelHeader>
        <div>
          <PanelTitle>Deployments</PanelTitle>
          <PanelDescription className="mt-1">
            Each build attempt keeps its source, outcome, and persisted log.
          </PanelDescription>
        </div>
      </PanelHeader>

      {initialError ? (
        <PanelContent>
          <Alert variant="destructive">
            <AlertTitle>Deployment history could not be loaded</AlertTitle>
            <AlertDescription>
              Retry this read. Existing deployments and logs are unchanged.
            </AlertDescription>
            <div className="mt-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void deploymentsQuery.refetch()}
              >
                Retry history
              </Button>
            </div>
          </Alert>
        </PanelContent>
      ) : (
        <ResourceTable
          columns={columns}
          rows={deployments}
          rowKey={(deployment) => deployment.id}
          loading={deploymentsQuery.isLoading}
          empty={
            <EmptyState
              icon={History}
              title="No deployments yet"
              description="Repository imports and deploys will appear here with their build logs."
            />
          }
        />
      )}

      {!initialError &&
      (deploymentsQuery.hasNextPage || deploymentsQuery.error) ? (
        <PanelFooter className="justify-between">
          <span className="text-muted-foreground text-xs">
            {deploymentsQuery.error
              ? 'History could not be refreshed.'
              : 'Newest deployments first.'}
          </span>
          {deploymentsQuery.hasNextPage ? (
            <Button
              size="sm"
              variant="outline"
              disabled={deploymentsQuery.isFetchingNextPage}
              onClick={() => void deploymentsQuery.fetchNextPage()}
            >
              {deploymentsQuery.isFetchingNextPage
                ? 'Loading…'
                : 'Load older deployments'}
            </Button>
          ) : deploymentsQuery.error ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void deploymentsQuery.refetch()}
            >
              Retry history
            </Button>
          ) : null}
        </PanelFooter>
      ) : null}
    </Panel>
  )
}
