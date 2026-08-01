import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Plug } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { PageHeader } from '@/components/page-header'
import { Panel, PanelContent } from '@/components/panel'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import {
  displayManagedAgentName,
  claimManagedAgentChannelIdentity,
  getManagedAgentConnections,
  getManagedAgents,
} from './api'

function displayResourceName(value: string) {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

export default function ManagedAgentConnections() {
  const [searchParams, setSearchParams] = useSearchParams()
  const channelLinkStarted = useRef(false)
  const [channelLinkState, setChannelLinkState] = useState<
    'idle' | 'linking' | 'linked' | 'failed'
  >('idle')
  const requestedService = searchParams.get('service')
  const requestedAlias = searchParams.get('alias') || 'default'
  const connections = useQuery({
    queryKey: ['managed-agent-connections'],
    queryFn: getManagedAgentConnections,
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

  return (
    <div>
      <PageHeader
        title="Connections"
        description="Connected accounts available to your projects."
      />

      {channelLinkState !== 'idle' && (
        <Panel className="mb-4">
          <PanelContent className="text-sm">
            {channelLinkState === 'linking' && 'Linking your channel identity…'}
            {channelLinkState === 'linked' &&
              'Channel identity linked. This project can now use your connections when you message it.'}
            {channelLinkState === 'failed' &&
              'This channel link is invalid or expired. Ask the project for a new link.'}
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
              Run{' '}
              <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                opencomputer connection add {requestedService} --alias{' '}
                {requestedAlias}
              </code>
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
                      {connection.displayName ||
                        displayResourceName(
                          connection.label || connection.provider,
                        )}
                    </p>
                    <p className="text-muted-foreground truncate text-xs">
                      {displayResourceName(connection.provider)}
                      {agentName ? ` · ${agentName}` : ''}
                    </p>
                  </div>
                  <StatusBadge status={connection.status} />
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
              Connect an account with the OpenComputer CLI and it will appear
              here.
            </p>
          </PanelContent>
        </Panel>
      )}
    </div>
  )
}
