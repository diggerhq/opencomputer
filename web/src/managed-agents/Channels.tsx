import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { ArrowUpRight, Loader2, Radio } from 'lucide-react'
import { PageHeader } from '@/components/page-header'
import { Panel, PanelContent } from '@/components/panel'
import { StatusBadge } from '@/components/status-badge'
import { Button } from '@/components/ui/button'
import {
  displayManagedAgentName,
  getManagedAgentChannels,
  getManagedAgents,
  getManagedProjects,
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
  const projects = useQuery({
    queryKey: ['managed-projects'],
    queryFn: getManagedProjects,
  })
  const agentNames = new Map(
    (agents.data ?? []).map((agent) => [
      agent.id,
      displayManagedAgentName(agent),
    ]),
  )
  // Setup and connection details live on the project's Connections tab.
  const projectByAgent = new Map(
    (projects.data ?? []).flatMap((project) =>
      project.agents.map((agent) => [agent.id, project.id] as const),
    ),
  )

  return (
    <div>
      <PageHeader
        title="Channels"
        description="Places where agents can receive and send messages."
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
            const consumers = (
              channel.agents.length ? channel.agents : [channel.agentId]
            ).map((agentId) => agentNames.get(agentId) ?? agentId)
            const projectId = projectByAgent.get(channel.agentId)
            // Slack apps are set up on Connections; Twilio has no section
            // there, its wizard lives on the project's Channels tab.
            const tab =
              channel.channel === 'twilio' ? 'channels' : 'connections'
            const tabLabel = tab === 'channels' ? 'Channels' : 'Connections'
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
                      {' · '}
                      {channel.alias}
                      {' · '}
                      {consumers.join(', ')}
                    </p>
                  </div>
                  <StatusBadge status={channel.status} />
                  {projectId ? (
                    <Button asChild variant="ghost" size="sm">
                      <Link
                        to={`/projects/${encodeURIComponent(projectId)}/${tab}?environment=${channel.alias}`}
                        aria-label={`Open in project ${tabLabel}`}
                      >
                        {tabLabel} <ArrowUpRight />
                      </Link>
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
              <Radio className="size-4" aria-hidden />
            </div>
            <p className="text-sm font-medium">No channels yet</p>
            <p className="text-muted-foreground mt-1 max-w-sm text-sm">
              Deploy an agent, then connect Slack from its project’s Connections
              tab.
            </p>
          </PanelContent>
        </Panel>
      )}
    </div>
  )
}
