import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Plug, Plus, Trash2 } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { PageHeader } from '@/components/page-header'
import { Panel, PanelContent } from '@/components/panel'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  displayManagedAgentName,
  claimManagedAgentChannelIdentity,
  disconnectManagedAgentConnection,
  getManagedAgentConnections,
  getManagedAgents,
  linkManagedAgentConnection,
  refreshManagedAgentConnection,
  type ManagedAgentConnection,
} from './api'

function displayResourceName(value: string) {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

function connectionService(connection: { provider: string; scopes: string[] }) {
  if (
    connection.scopes.some((scope) =>
      scope.toLowerCase().includes('/auth/calendar'),
    )
  ) {
    return 'Google Calendar'
  }
  if (
    connection.scopes.some((scope) =>
      scope.toLowerCase().includes('/auth/gmail.'),
    )
  ) {
    return 'Gmail'
  }
  return displayResourceName(connection.provider)
}

function connectionServiceId(
  connection: ManagedAgentConnection,
): 'gmail' | 'calendar' | 'github' | undefined {
  if (connection.provider === 'github') return 'github'
  if (connection.provider !== 'google') return undefined
  if (
    connection.scopes.some((scope) =>
      scope.toLowerCase().includes('/auth/calendar'),
    )
  ) {
    return 'calendar'
  }
  if (
    connection.scopes.some((scope) =>
      scope.toLowerCase().includes('/auth/gmail.'),
    )
  ) {
    return 'gmail'
  }
  return undefined
}

async function loadManagedAgentConnections() {
  const current = await getManagedAgentConnections()
  const pending = current.filter(
    (connection) => connection.status === 'pending',
  )
  if (!pending.length) return current
  await Promise.allSettled(
    pending.map((connection) => {
      const service = connectionServiceId(connection)
      if (!service) return Promise.resolve()
      return refreshManagedAgentConnection(
        service === 'github' ? 'github' : 'google',
        service,
        connection.id,
      )
    }),
  )
  return getManagedAgentConnections()
}

export default function ManagedAgentConnections() {
  const [searchParams, setSearchParams] = useSearchParams()
  const channelLinkStarted = useRef(false)
  const connectionStarted = useRef(false)
  const [channelLinkState, setChannelLinkState] = useState<
    'idle' | 'linking' | 'linked' | 'failed'
  >('idle')
  const [connectionRequestState, setConnectionRequestState] = useState<
    'idle' | 'connecting' | 'connected' | 'failed'
  >('idle')
  const [newService, setNewService] = useState('gmail')
  const [newAlias, setNewAlias] = useState('gmail')
  const [addConnectionOpen, setAddConnectionOpen] = useState(false)
  const [addConnectionError, setAddConnectionError] = useState<string>()
  const [removeConnectionError, setRemoveConnectionError] = useState<string>()
  const [connectionToRemove, setConnectionToRemove] =
    useState<ManagedAgentConnection>()
  const [removingConnection, setRemovingConnection] = useState(false)
  const requestedService = searchParams.get('service')
  const requestedAlias = searchParams.get('alias') || 'default'
  const connections = useQuery({
    queryKey: ['managed-agent-connections'],
    queryFn: loadManagedAgentConnections,
  })
  const agents = useQuery({
    queryKey: ['managed-agents'],
    queryFn: getManagedAgents,
  })
  const agentNames = new Map(
    (agents.data ?? []).map((agent) => [
      agent.id,
      displayManagedAgentName(agent),
    ]),
  )

  useEffect(() => {
    const token = searchParams.get('channel_link')
    if (!token || channelLinkStarted.current) return
    channelLinkStarted.current = true
    setChannelLinkState('linking')
    void claimManagedAgentChannelIdentity(token)
      .then(() => {
        setChannelLinkState('linked')
        const next = new URLSearchParams(searchParams)
        next.delete('channel_link')
        setSearchParams(next, { replace: true })
      })
      .catch(() => setChannelLinkState('failed'))
  }, [searchParams, setSearchParams])

  useEffect(() => {
    if (
      searchParams.get('connect') !== '1' ||
      !requestedService ||
      connectionStarted.current ||
      channelLinkState === 'linking'
    ) {
      return
    }
    connectionStarted.current = true
    setConnectionRequestState('connecting')
    void linkManagedAgentConnection(requestedService, requestedAlias)
      .then((result) => {
        if (result.authorizationUrl) {
          window.location.assign(result.authorizationUrl)
          return
        }
        setConnectionRequestState('connected')
        void connections.refetch()
      })
      .catch(() => setConnectionRequestState('failed'))
  }, [
    channelLinkState,
    connections,
    requestedAlias,
    requestedService,
    searchParams,
  ])

  return (
    <div>
      <PageHeader
        title="Connections"
        description="Connect accounts and choose the aliases your agents use."
        actions={
          <Button
            onClick={() => {
              setConnectionRequestState('idle')
              setAddConnectionError(undefined)
              setAddConnectionOpen(true)
            }}
          >
            <Plus className="size-4" aria-hidden />
            Add connection
          </Button>
        }
      />

      {channelLinkState !== 'idle' && (
        <Panel className="mb-4">
          <PanelContent className="text-sm">
            {channelLinkState === 'linking' && 'Linking your channel identity…'}
            {channelLinkState === 'linked' &&
              'Channel identity linked. This agent can now use your connections when you message it.'}
            {channelLinkState === 'failed' &&
              'This channel link is invalid or expired. Ask the agent for a new link.'}
          </PanelContent>
        </Panel>
      )}

      {requestedService && (
        <Panel className="mb-4">
          <PanelContent>
            <p className="text-sm font-medium">
              Connect {displayResourceName(requestedService)} as “
              {requestedAlias}”
            </p>
            <p className="text-muted-foreground mt-1 text-sm">
              {connectionRequestState === 'connecting'
                ? 'Opening secure authorization…'
                : connectionRequestState === 'connected'
                  ? 'This connection is ready for your sessions.'
                  : connectionRequestState === 'failed'
                    ? 'The connection could not be started. Reload this link to try again.'
                    : 'Continue to securely authorize this account.'}
            </p>
          </PanelContent>
        </Panel>
      )}

      {connections.isLoading ? (
        <div className="flex min-h-48 items-center justify-center">
          <Loader2 className="text-muted-foreground size-5 animate-spin" />
        </div>
      ) : connections.isError ? (
        <Panel>
          <PanelContent className="flex min-h-40 flex-col items-center justify-center gap-4 text-center">
            <div>
              <p className="text-sm font-medium">
                Connections are temporarily unavailable
              </p>
              <p className="text-muted-foreground mt-1 text-sm">
                Try loading this page again.
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => void connections.refetch()}
            >
              Try again
            </Button>
          </PanelContent>
        </Panel>
      ) : connections.data?.length ? (
        <div className="grid gap-3 md:grid-cols-2">
          {connections.data.map((connection) => {
            const agentName = agentNames.get(connection.agentId)
            return (
              <Panel key={connection.id}>
                <PanelContent className="flex items-center gap-3">
                  <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
                    <Plug className="size-4" aria-hidden />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {displayResourceName(
                        connection.label || connection.provider,
                      )}
                    </p>
                    <p className="text-muted-foreground truncate text-xs">
                      {connectionService(connection)}
                      {connection.displayName
                        ? ` · ${connection.displayName}`
                        : ''}
                      {agentName ? ` · ${agentName}` : ''}
                    </p>
                  </div>
                  <StatusBadge status={connection.status} />
                  {connectionServiceId(connection) ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove ${connection.label} connection`}
                      onClick={() => setConnectionToRemove(connection)}
                    >
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  ) : null}
                </PanelContent>
              </Panel>
            )
          })}
        </div>
      ) : (
        <Panel>
          <PanelContent className="flex min-h-40 flex-col items-center justify-center text-center">
            <div className="bg-muted text-muted-foreground mb-3 flex size-10 items-center justify-center rounded-full">
              <Plug className="size-4" aria-hidden />
            </div>
            <p className="text-sm font-medium">No connections yet</p>
            <p className="text-muted-foreground mt-1 max-w-sm text-sm">
              Add Gmail, Google Calendar, or GitHub to make it available to your
              agents.
            </p>
            <Button
              className="mt-4"
              variant="outline"
              onClick={() => setAddConnectionOpen(true)}
            >
              <Plus className="size-4" aria-hidden />
              Add connection
            </Button>
          </PanelContent>
        </Panel>
      )}

      <Dialog
        open={addConnectionOpen}
        onOpenChange={(open) => {
          if (connectionRequestState === 'connecting') return
          setAddConnectionOpen(open)
          if (!open) setAddConnectionError(undefined)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add connection</DialogTitle>
            <DialogDescription>
              Choose a service and a memorable alias for this account.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              const alias = newAlias.trim()
              if (!alias || connectionRequestState === 'connecting') return
              setAddConnectionError(undefined)
              setConnectionRequestState('connecting')
              void linkManagedAgentConnection(newService, alias)
                .then((result) => {
                  if (result.authorizationUrl) {
                    window.location.assign(result.authorizationUrl)
                    return
                  }
                  setConnectionRequestState('connected')
                  setAddConnectionOpen(false)
                  void connections.refetch()
                })
                .catch((error: unknown) => {
                  setConnectionRequestState('failed')
                  setAddConnectionError(
                    error instanceof Error
                      ? error.message
                      : 'The connection could not be started.',
                  )
                })
            }}
          >
            <div className="grid gap-2">
              <Label htmlFor="connection-service">Service</Label>
              <select
                id="connection-service"
                value={newService}
                onChange={(event) => {
                  const service = event.target.value
                  setNewService(service)
                  setNewAlias(service === 'calendar' ? 'calendar' : service)
                }}
                className="border-input bg-background ring-offset-background focus-visible:ring-ring h-9 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              >
                <option value="gmail">Gmail</option>
                <option value="calendar">Google Calendar</option>
                <option value="github">GitHub</option>
              </select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="connection-alias">Account alias</Label>
              <Input
                id="connection-alias"
                value={newAlias}
                onChange={(event) => setNewAlias(event.target.value)}
                pattern="[A-Za-z0-9._-]+"
                placeholder="work-gmail"
                required
              />
              <p className="text-muted-foreground text-xs">
                Agents use this alias to select the account in callService().
              </p>
            </div>
            {addConnectionError ? (
              <p className="text-destructive text-sm">{addConnectionError}</p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={connectionRequestState === 'connecting'}
                onClick={() => setAddConnectionOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={
                  !newAlias.trim() || connectionRequestState === 'connecting'
                }
              >
                {connectionRequestState === 'connecting' ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : null}
                Continue
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={Boolean(connectionToRemove)}
        onOpenChange={(open) => {
          if (!open) setConnectionToRemove(undefined)
        }}
        title="Remove connection?"
        description={
          connectionToRemove
            ? removeConnectionError
              ? `The connection could not be removed: ${removeConnectionError}`
              : `Agents will no longer be able to use the “${connectionToRemove.label}” account. You can reconnect it later.`
            : undefined
        }
        confirmLabel="Remove connection"
        destructive
        pending={removingConnection}
        onConfirm={() => {
          if (!connectionToRemove) return
          const service = connectionServiceId(connectionToRemove)
          if (!service) return
          setRemovingConnection(true)
          setRemoveConnectionError(undefined)
          void disconnectManagedAgentConnection(
            service === 'github' ? 'github' : 'google',
            service,
            connectionToRemove.id,
          )
            .then(() => connections.refetch())
            .then(() => setConnectionToRemove(undefined))
            .catch((error: unknown) => {
              setRemoveConnectionError(
                error instanceof Error
                  ? error.message
                  : 'The connection could not be removed.',
              )
            })
            .finally(() => setRemovingConnection(false))
        }}
      />
    </div>
  )
}
