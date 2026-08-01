import { useQuery } from '@tanstack/react-query'
import { Loader2, Radio } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { Panel, PanelContent } from '@/components/panel'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import {
  displayManagedAgentName,
  getManagedAgentChannels,
  getManagedAgents,
} from './api'

function displayResourceName(value: string) {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase())
}

export default function ManagedAgentChannels() {
  const channels = useQuery({
    queryKey: ['managed-agent-channels'],
    queryFn: getManagedAgentChannels,
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

  return (
    <div>
      <PageHeader
        title="Channels"
        description="Places where projects can receive and send messages."
      />

      {channels.isLoading ? (
        <div className="flex min-h-48 items-center justify-center">
          <Loader2 className="text-muted-foreground size-5 animate-spin" />
        </div>
      ) : channels.isError ? (
        <Panel>
          <PanelContent className="flex min-h-40 flex-col items-center justify-center gap-4 text-center">
            <div>
              <p className="text-sm font-medium">
                Channels are temporarily unavailable
              </p>
              <p className="text-muted-foreground mt-1 text-sm">
                Try loading this page again.
              </p>
            </div>
            <Button variant="outline" onClick={() => void channels.refetch()}>
              Try again
            </Button>
          </PanelContent>
        </Panel>
      ) : channels.data?.length ? (
        <div className="grid gap-3 md:grid-cols-2">
          {channels.data.map((channel) => {
            const agentName = agentNames.get(channel.agentId)
            return (
              <Panel key={channel.id}>
                <PanelContent className="flex items-center gap-3">
                  <div className="bg-muted text-muted-foreground flex size-9 shrink-0 items-center justify-center rounded-md">
                    <Radio className="size-4" aria-hidden />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {channel.teamName ||
                        `${displayResourceName(channel.channel)} workspace`}
                    </p>
                    <p className="text-muted-foreground truncate text-xs">
                      {displayResourceName(channel.channel)}
                      {agentName ? ` · ${agentName}` : ''}
                    </p>
                  </div>
                  <StatusBadge status={channel.status} />
                </PanelContent>
              </Panel>
            )
          })}
        </div>
      ) : (
        <Panel>
          <PanelContent className="flex min-h-40 flex-col items-center justify-center text-center">
            <div className="bg-muted text-muted-foreground mb-3 flex size-10 items-center justify-center rounded-full">
              <Radio className="size-4" aria-hidden />
            </div>
            <p className="text-sm font-medium">No channels yet</p>
            <p className="text-muted-foreground mt-1 max-w-sm text-sm">
              Add a channel with the OpenComputer CLI and it will appear here.
            </p>
          </PanelContent>
        </Panel>
      )}
    </div>
  )
}
