import { useQuery } from '@tanstack/react-query'
import { Send } from 'lucide-react'
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
import {
  getManagedAgentOutboxes,
  type ManagedAgentOutboxItem,
} from './api'
import { projectContextSearch } from './project-context'

function formatDate(value: string) {
  return new Date(value).toLocaleString()
}

function safeExternalUrl(value?: string) {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.toString()
      : undefined
  } catch {
    return undefined
  }
}

const itemColumns: Column<ManagedAgentOutboxItem>[] = [
  {
    key: 'message',
    header: 'Message',
    cell: (item) => (
      <div className="max-w-72">
        <p className="truncate text-sm font-medium">
          {item.contentPreview.title || item.contentPreview.body || 'Message'}
        </p>
        {item.contentPreview.title && item.contentPreview.body ? (
          <p className="text-muted-foreground mt-1 truncate text-xs">
            {item.contentPreview.body}
          </p>
        ) : null}
      </div>
    ),
  },
  {
    key: 'session',
    header: 'Session',
    cell: () => null,
  },
  {
    key: 'event',
    header: 'Event',
    cell: (item) => <span className="font-mono text-xs">{item.eventType}</span>,
  },
  {
    key: 'status',
    header: 'Status',
    cell: (item) => <StatusBadge status={item.status} />,
  },
  {
    key: 'attempts',
    header: 'Attempts',
    cell: (item) => (
      <span className="text-muted-foreground text-xs">{item.attemptCount}</span>
    ),
  },
  {
    key: 'updated',
    header: 'Published',
    align: 'right',
    cell: (item) => (
      <div className="text-right">
        <time className="text-muted-foreground text-xs" dateTime={item.createdAt}>
          {formatDate(item.createdAt)}
        </time>
        {item.updatedAt !== item.createdAt ? (
          <p className="text-muted-foreground mt-1 text-[11px]">
            Updated {formatDate(item.updatedAt)}
          </p>
        ) : null}
        {item.error ? (
          <p className="text-status-error mt-1 text-xs">{item.error}</p>
        ) : null}
      </div>
    ),
  },
]

export function ManagedAgentOutboxes({
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
  const outboxes = useQuery({
    queryKey: ['managed-agent-outboxes', agentId, environment],
    queryFn: () => getManagedAgentOutboxes(agentId, environment),
    enabled: deployed,
    refetchInterval: 3_000,
  })

  if (!deployed) {
    return (
      <Panel>
        <EmptyState
          icon={Send}
          title={`No active ${environment} deployment`}
          description="Deploy this project to the environment before publishing outbox items."
        />
      </Panel>
    )
  }

  if (outboxes.isError) {
    return (
      <Panel>
        <EmptyState
          icon={Send}
          title="Outboxes are temporarily unavailable"
          description="Try loading this environment again."
        />
      </Panel>
    )
  }

  if (outboxes.isLoading) {
    return (
      <Panel>
        <PanelContent className="text-muted-foreground py-8 text-sm">
          Loading outboxes…
        </PanelContent>
      </Panel>
    )
  }

  if (!outboxes.data?.outboxes.length) {
    return (
      <Panel>
        <EmptyState
          icon={Send}
          title={`No ${environment} outboxes`}
          description="Register an outbox for this agent and deploy it to this environment."
        />
      </Panel>
    )
  }

  return (
    <div className="space-y-4">
      {outboxes.data.outboxes.map((outbox) => {
        const readiness =
          outbox.readiness === 'ready'
            ? { status: 'ready', label: 'Ready' }
            : outbox.readiness === 'channel_not_connected'
              ? { status: 'unavailable', label: 'Connect channel' }
              : { status: 'unavailable', label: 'Map destination' }
        const columns = itemColumns.map((column) =>
          column.key === 'session'
            ? {
                ...column,
                cell: (item: ManagedAgentOutboxItem) =>
                  item.sessionId ? (
                    <Link
                      className="font-mono text-xs underline underline-offset-2"
                      to={{
                        pathname: `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(item.sessionId)}`,
                        search: projectContextSearch('', agentId, environment),
                      }}
                    >
                      {item.sessionId.slice(0, 12)}…
                    </Link>
                  ) : (
                    <span className="text-muted-foreground text-xs">
                      Not recorded
                    </span>
                  ),
              }
            : column,
        )
        return (
          <Panel key={outbox.id} className="overflow-hidden">
            <PanelHeader>
              <div className="min-w-0">
                <PanelTitle>{outbox.id}</PanelTitle>
                <PanelDescription className="mt-1">
                  {outbox.channelName} ({outbox.channelId}) → {outbox.destination}
                  {outbox.targetDisplayName
                    ? ` → ${outbox.targetDisplayName}`
                    : ''}
                </PanelDescription>
              </div>
              <StatusBadge status={readiness.status} label={readiness.label} />
            </PanelHeader>
            <ResourceTable
              columns={columns}
              rows={outbox.items}
              rowKey={(item) => item.id}
              renderSubRow={(item) => {
                const url = safeExternalUrl(item.contentPreview.url)
                if (
                  !item.contentPreview.title &&
                  !item.contentPreview.body &&
                  !url
                ) {
                  return null
                }
                return (
                  <div className="bg-muted/30 space-y-2 px-4 py-3 text-sm">
                    {item.contentPreview.title ? (
                      <p className="font-medium">{item.contentPreview.title}</p>
                    ) : null}
                    {item.contentPreview.body ? (
                      <p className="text-muted-foreground whitespace-pre-wrap">
                        {item.contentPreview.body}
                      </p>
                    ) : null}
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="break-all text-xs underline underline-offset-2"
                      >
                        {url}
                      </a>
                    ) : null}
                  </div>
                )
              }}
              empty={
                <EmptyState
                  title="No publications in this environment"
                  description="New outbox items will appear here automatically."
                  className="py-9"
                />
              }
            />
          </Panel>
        )
      })}
    </div>
  )
}
