import { useState, type ReactNode } from 'react'
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { getManagedAgentOutboxes, type ManagedAgentOutbox } from './api'
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

function readinessMeta(readiness: ManagedAgentOutbox['readiness']) {
  return readiness === 'ready'
    ? { status: 'ready', label: 'Ready' }
    : readiness === 'channel_not_connected'
      ? { status: 'unavailable', label: 'Connect channel' }
      : { status: 'unavailable', label: 'Map destination' }
}

export type OutboxDelivery = {
  outbox: ManagedAgentOutbox
  item: ManagedAgentOutbox['items'][number]
}

export function flattenOutboxDeliveries(outboxes: ManagedAgentOutbox[]) {
  return outboxes
    .flatMap((outbox) => outbox.items.map((item) => ({ outbox, item })))
    .sort((left, right) =>
      right.item.createdAt.localeCompare(left.item.createdAt),
    )
}

function DetailField({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {label}
      </dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  )
}

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
  const [selectedItemId, setSelectedItemId] = useState<string>()
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

  const routes = outboxes.data.outboxes
  const deliveries = flattenOutboxDeliveries(routes)
  const selected = deliveries.find(({ item }) => item.id === selectedItemId)

  const routeColumns: Column<ManagedAgentOutbox>[] = [
    {
      key: 'outbox',
      header: 'Outbox',
      cell: (outbox) => (
        <span className="text-sm font-medium">{outbox.id}</span>
      ),
    },
    {
      key: 'route',
      header: 'Route',
      cell: (outbox) => (
        <span className="text-muted-foreground text-xs">
          {outbox.channelName} → {outbox.destination}
          {outbox.targetDisplayName ? ` → ${outbox.targetDisplayName}` : ''}
        </span>
      ),
    },
    {
      key: 'readiness',
      header: 'Readiness',
      align: 'right',
      cell: (outbox) => {
        const readiness = readinessMeta(outbox.readiness)
        return <StatusBadge status={readiness.status} label={readiness.label} />
      },
    },
  ]

  const deliveryColumns: Column<OutboxDelivery>[] = [
    {
      key: 'message',
      header: 'Message',
      cell: ({ item }) => (
        <div className="max-w-80">
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
      key: 'route',
      header: 'Route',
      cell: ({ outbox }) => {
        const readiness = readinessMeta(outbox.readiness)
        return (
          <div className="space-y-1">
            <p className="text-xs font-medium">{outbox.id}</p>
            <StatusBadge status={readiness.status} label={readiness.label} />
          </div>
        )
      },
    },
    {
      key: 'session',
      header: 'Session',
      cell: ({ item }) =>
        item.sessionId ? (
          <Link
            className="font-mono text-xs underline underline-offset-2"
            onClick={(event) => event.stopPropagation()}
            to={{
              pathname: `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(item.sessionId)}`,
              search: projectContextSearch('', agentId, environment),
            }}
          >
            {item.sessionId.slice(0, 12)}…
          </Link>
        ) : (
          <span className="text-muted-foreground text-xs">Not recorded</span>
        ),
    },
    {
      key: 'delivery',
      header: 'Delivery',
      cell: ({ item }) => (
        <div className="space-y-1">
          <StatusBadge status={item.status} />
          <p className="text-muted-foreground text-[11px]">
            {item.attemptCount}{' '}
            {item.attemptCount === 1 ? 'attempt' : 'attempts'}
          </p>
        </div>
      ),
    },
    {
      key: 'published',
      header: 'Published',
      align: 'right',
      cell: ({ item }) => (
        <time
          className="text-muted-foreground text-xs"
          dateTime={item.createdAt}
        >
          {formatDate(item.createdAt)}
        </time>
      ),
    },
  ]

  const selectedUrl = safeExternalUrl(selected?.item.contentPreview.url)
  const selectedReadiness = selected
    ? readinessMeta(selected.outbox.readiness)
    : undefined

  return (
    <div className="space-y-4">
      <Panel className="overflow-hidden">
        <PanelHeader className="py-3">
          <div>
            <PanelTitle>Configured routes</PanelTitle>
            <PanelDescription className="mt-1">
              Delivery readiness for this {environment} environment.
            </PanelDescription>
          </div>
        </PanelHeader>
        <ResourceTable
          columns={routeColumns}
          rows={routes}
          rowKey={(outbox) => outbox.id}
        />
      </Panel>

      <Panel className="overflow-hidden">
        <PanelHeader>
          <div>
            <PanelTitle>Publications</PanelTitle>
            <PanelDescription className="mt-1">
              Most recent deliveries across all outboxes in this environment.
            </PanelDescription>
          </div>
        </PanelHeader>
        <ResourceTable
          columns={deliveryColumns}
          rows={deliveries}
          rowKey={({ item }) => item.id}
          onRowClick={({ item }) => setSelectedItemId(item.id)}
          empty={
            <EmptyState
              title="No publications in this environment"
              description="New outbox items will appear here automatically."
              className="py-9"
            />
          }
        />
      </Panel>

      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelectedItemId(undefined)
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          {selected ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {selected.item.contentPreview.title || 'Outbox publication'}
                </DialogTitle>
                <DialogDescription>
                  Delivery and provenance for this publication.
                </DialogDescription>
              </DialogHeader>

              {selected.item.contentPreview.body ? (
                <p className="bg-muted/40 max-h-56 overflow-y-auto rounded-md border p-3 text-sm whitespace-pre-wrap">
                  {selected.item.contentPreview.body}
                </p>
              ) : null}
              {selectedUrl ? (
                <a
                  href={selectedUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm break-all underline underline-offset-2"
                >
                  {selectedUrl}
                </a>
              ) : null}

              <dl className="grid grid-cols-1 gap-x-6 gap-y-4 border-t pt-4 sm:grid-cols-2">
                <DetailField label="Delivery">
                  <span className="inline-flex items-center gap-2">
                    <StatusBadge status={selected.item.status} />
                    <span className="text-muted-foreground text-xs">
                      {selected.item.attemptCount}{' '}
                      {selected.item.attemptCount === 1
                        ? 'attempt'
                        : 'attempts'}
                    </span>
                  </span>
                </DetailField>
                <DetailField label="Route readiness">
                  <StatusBadge
                    status={selectedReadiness!.status}
                    label={selectedReadiness!.label}
                  />
                </DetailField>
                <DetailField label="Outbox">
                  <span className="font-mono text-xs">
                    {selected.outbox.id}
                  </span>
                </DetailField>
                <DetailField label="Event">
                  <span className="font-mono text-xs">
                    {selected.item.eventType}
                  </span>
                </DetailField>
                <DetailField label="Route">
                  <span className="text-xs">
                    {selected.outbox.channelName} ({selected.outbox.channelId})
                    → {selected.outbox.destination}
                    {selected.outbox.targetDisplayName
                      ? ` → ${selected.outbox.targetDisplayName}`
                      : ''}
                  </span>
                </DetailField>
                <DetailField label="Session">
                  {selected.item.sessionId ? (
                    <Link
                      className="font-mono text-xs break-all underline underline-offset-2"
                      to={{
                        pathname: `/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(selected.item.sessionId)}`,
                        search: projectContextSearch('', agentId, environment),
                      }}
                    >
                      {selected.item.sessionId}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground text-xs">
                      Not recorded for this historical item
                    </span>
                  )}
                </DetailField>
                <DetailField label="Published">
                  <time dateTime={selected.item.createdAt}>
                    {formatDate(selected.item.createdAt)}
                  </time>
                </DetailField>
                <DetailField label="Last updated">
                  <time dateTime={selected.item.updatedAt}>
                    {formatDate(selected.item.updatedAt)}
                  </time>
                </DetailField>
                <DetailField label="Publication ID">
                  <span className="font-mono text-xs break-all">
                    {selected.item.id}
                  </span>
                </DetailField>
                {selected.item.error ? (
                  <DetailField label="Failure">
                    <span className="text-status-error text-xs">
                      {selected.item.error}
                    </span>
                  </DetailField>
                ) : null}
              </dl>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
