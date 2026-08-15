import { useQuery } from '@tanstack/react-query'
import { Send } from 'lucide-react'
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

function formatDate(value: string) {
  return new Date(value).toLocaleString()
}

const itemColumns: Column<ManagedAgentOutboxItem>[] = [
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
    header: 'Updated',
    align: 'right',
    cell: (item) => (
      <div className="text-right">
        <time className="text-muted-foreground text-xs" dateTime={item.updatedAt}>
          {formatDate(item.updatedAt)}
        </time>
        {item.error ? (
          <p className="text-status-error mt-1 text-xs">{item.error}</p>
        ) : null}
      </div>
    ),
  },
]

export function ManagedAgentOutboxes({
  agentId,
  environment,
}: {
  agentId: string
  environment: 'development' | 'production'
}) {
  const outboxes = useQuery({
    queryKey: ['managed-agent-outboxes', agentId, environment],
    queryFn: () => getManagedAgentOutboxes(agentId, environment),
    refetchInterval: 3_000,
  })

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
              columns={itemColumns}
              rows={outbox.items}
              rowKey={(item) => item.id}
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
