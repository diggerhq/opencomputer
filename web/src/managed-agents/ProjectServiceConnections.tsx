import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Plug, Unplug } from 'lucide-react'
import { Link } from 'react-router-dom'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { GithubMark } from '@/components/github-mark'
import {
  Panel,
  PanelContent,
  PanelDescription,
  PanelHeader,
  PanelTitle,
} from '@/components/panel'
import { ServiceLogo } from '@/components/service-logo'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import {
  attachManagedProjectServiceConnection,
  detachManagedProjectServiceConnection,
  getManagedAgentConnections,
  listManagedProjectServiceConnections,
  type ManagedAgentConnection,
  type ManagedProjectServiceAttachment,
} from './api'

const GOOGLE_SERVICES = [
  { id: 'calendar', name: 'Google Calendar', scope: '/auth/calendar' },
  { id: 'sheets', name: 'Google Sheets', scope: '/auth/spreadsheets' },
  { id: 'drive', name: 'Google Drive', scope: '/auth/drive' },
  { id: 'gmail', name: 'Gmail', scope: '/auth/gmail.' },
] as const

type ServiceId = 'gmail' | 'calendar' | 'drive' | 'sheets' | 'github' | 'linear'

function supportedService(value: string): ServiceId | undefined {
  switch (value) {
    case 'gmail':
    case 'calendar':
    case 'drive':
    case 'sheets':
    case 'github':
    case 'linear':
      return value
    default:
      return undefined
  }
}

function googleService(connection: ManagedAgentConnection) {
  return GOOGLE_SERVICES.find((service) =>
    connection.scopes.some((scope) =>
      scope.toLowerCase().includes(service.scope),
    ),
  )
}

function serviceId(connection: ManagedAgentConnection): ServiceId | undefined {
  if (connection.provider === 'linear') return 'linear'
  if (connection.provider === 'github') return 'github'
  return googleService(connection)?.id
}

function serviceName(connection: ManagedAgentConnection) {
  if (connection.provider === 'linear') return 'Linear'
  if (connection.provider === 'github') return 'GitHub'
  return googleService(connection)?.name ?? connection.provider
}

function rowsForConnections(
  connections: readonly ManagedAgentConnection[],
  attachments: readonly ManagedProjectServiceAttachment[],
) {
  const byId = new Map<string, ManagedAgentConnection>()
  for (const connection of connections) {
    if (connection.status === 'connected') byId.set(connection.id, connection)
  }
  for (const attachment of attachments) {
    byId.set(attachment.connectionId, attachment.connection)
  }
  return [...byId.values()].sort((left, right) =>
    `${serviceName(left)}:${left.label}`.localeCompare(
      `${serviceName(right)}:${right.label}`,
    ),
  )
}

type PendingAction =
  | {
      kind: 'detach'
      connection: ManagedAgentConnection
      attachment: ManagedProjectServiceAttachment
    }
  | {
      kind: 'replace'
      connection: ManagedAgentConnection
      attachment: ManagedProjectServiceAttachment
    }

export function ManagedProjectServiceConnections({
  projectId,
}: {
  projectId: string
}) {
  const queryClient = useQueryClient()
  const [pendingAction, setPendingAction] = useState<PendingAction>()
  const connections = useQuery({
    queryKey: ['managed-agent-connections'],
    queryFn: getManagedAgentConnections,
  })
  const attachments = useQuery({
    queryKey: ['managed-project-service-connections', projectId],
    queryFn: () => listManagedProjectServiceConnections(projectId),
  })
  const mutation = useMutation({
    mutationFn: async (action: {
      kind: 'attach' | 'detach'
      connectionId: string
    }) => {
      if (action.kind === 'attach') {
        return attachManagedProjectServiceConnection({
          projectId,
          connectionId: action.connectionId,
        })
      }
      return detachManagedProjectServiceConnection({
        projectId,
        connectionId: action.connectionId,
      })
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ['managed-project-service-connections', projectId],
      })
      setPendingAction(undefined)
    },
  })

  const attached = attachments.data ?? []
  const rows = rowsForConnections(connections.data ?? [], attached)
  const isLoading = connections.isLoading || attachments.isLoading
  const isError = connections.isError || attachments.isError

  return (
    <Panel className="overflow-hidden">
      <PanelHeader>
        <div>
          <PanelTitle>Shared service connections</PanelTitle>
          <PanelDescription className="mt-1 max-w-2xl">
            Attach an OAuth account to this project. Every environment and
            preview inherits the attachment; only agents that declare the
            matching useService() capability can use it.
          </PanelDescription>
        </div>
        <Button asChild variant="outline">
          <Link to="/connections">Manage connected accounts</Link>
        </Button>
      </PanelHeader>
      {isLoading ? (
        <PanelContent className="text-muted-foreground flex min-h-20 items-center justify-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Loading
          service connections…
        </PanelContent>
      ) : isError ? (
        <PanelContent className="flex min-h-20 items-center justify-between gap-4">
          <p className="text-muted-foreground text-sm">
            Shared service connections are temporarily unavailable.
          </p>
          <Button
            variant="outline"
            onClick={() => {
              void connections.refetch()
              void attachments.refetch()
            }}
          >
            Try again
          </Button>
        </PanelContent>
      ) : rows.length ? (
        <div className="divide-y border-t">
          {rows.map((connection) => {
            const attachment = attached.find(
              (candidate) => candidate.connectionId === connection.id,
            )
            const service =
              supportedService(attachment?.service ?? '') ??
              serviceId(connection)
            const conflict = attached.find(
              (candidate) =>
                candidate.service === service &&
                candidate.label === connection.label &&
                candidate.connectionId !== connection.id,
            )
            const pending =
              mutation.isPending &&
              mutation.variables?.connectionId === connection.id
            return (
              <div
                key={connection.id}
                className="flex items-center gap-3 px-5 py-4"
              >
                <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
                  {service === 'github' ? (
                    <GithubMark className="size-4" />
                  ) : service ? (
                    <ServiceLogo service={service} className="size-4" />
                  ) : (
                    <Plug className="size-4" aria-hidden />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {connection.label}
                  </p>
                  <p className="text-muted-foreground truncate text-xs">
                    {serviceName(connection)}
                    {connection.displayName
                      ? ` · ${connection.displayName}`
                      : ''}
                  </p>
                </div>
                <StatusBadge status={connection.status} />
                {attachment ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={mutation.isPending}
                    onClick={() =>
                      setPendingAction({
                        kind: 'detach',
                        connection,
                        attachment,
                      })
                    }
                  >
                    {pending ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : (
                      <Unplug className="size-4" aria-hidden />
                    )}
                    Detach
                  </Button>
                ) : conflict ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={mutation.isPending}
                    onClick={() =>
                      setPendingAction({
                        kind: 'replace',
                        connection,
                        attachment: conflict,
                      })
                    }
                  >
                    Replace
                  </Button>
                ) : (
                  <Button
                    type="button"
                    disabled={mutation.isPending}
                    onClick={() =>
                      mutation.mutate({
                        kind: 'attach',
                        connectionId: connection.id,
                      })
                    }
                  >
                    {pending ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : (
                      <Plug className="size-4" aria-hidden />
                    )}
                    Attach
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <PanelContent className="flex min-h-28 flex-col items-center justify-center text-center">
          <p className="text-sm font-medium">No connected accounts</p>
          <p className="text-muted-foreground mt-1 max-w-lg text-sm">
            Connect Linear, Gmail, Calendar, Drive, or Sheets first, then return
            here to attach the account to this project.
          </p>
          <Button asChild className="mt-4" variant="outline">
            <Link to="/connections">Add account connection</Link>
          </Button>
        </PanelContent>
      )}
      {mutation.isError ? (
        <div className="border-t px-5 py-3">
          <p className="text-destructive text-sm">
            {mutation.error instanceof Error
              ? mutation.error.message
              : 'The project connection could not be updated.'}
          </p>
        </div>
      ) : null}

      <ConfirmDialog
        open={Boolean(pendingAction)}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setPendingAction(undefined)
        }}
        title={
          pendingAction?.kind === 'replace'
            ? 'Replace project connection?'
            : 'Detach project connection?'
        }
        description={
          pendingAction?.kind === 'replace'
            ? `This replaces the project’s “${pendingAction.attachment.label}” ${pendingAction.attachment.service} connection with “${pendingAction.connection.label}”. The underlying OAuth accounts stay connected.`
            : pendingAction
              ? `Agents in this project will stop using “${pendingAction.connection.label}” as a shared ${pendingAction.attachment.service} connection. The underlying OAuth account stays connected.`
              : undefined
        }
        confirmLabel={
          pendingAction?.kind === 'replace'
            ? 'Replace connection'
            : 'Detach connection'
        }
        destructive={pendingAction?.kind === 'detach'}
        pending={mutation.isPending}
        onConfirm={() => {
          if (!pendingAction) return
          mutation.mutate({
            kind: pendingAction.kind === 'detach' ? 'detach' : 'attach',
            connectionId: pendingAction.connection.id,
          })
        }}
      />
    </Panel>
  )
}
