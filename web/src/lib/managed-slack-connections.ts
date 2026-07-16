import { useQuery } from '@tanstack/react-query'
import {
  getManagedSlackConnections,
  type ManagedSlackWorkspaceConnection,
} from '@/api/client'

export const managedSlackConnectionsQueryKey = [
  'slack',
  'managed',
  'connections',
] as const

export function useManagedSlackConnections(enabled = true) {
  return useQuery({
    queryKey: managedSlackConnectionsQueryKey,
    queryFn: getManagedSlackConnections,
    enabled,
    refetchOnWindowFocus: 'always',
  })
}

export function managedSlackDisconnectCopy(
  connection: ManagedSlackWorkspaceConnection,
  nextAgentName: string,
) {
  const workspace = connection.workspace?.name || connection.workspace?.id
  const workspaceLabel = workspace || 'this Slack workspace'
  return {
    title: `Disconnect ${workspaceLabel} from ${connection.agent.name}?`,
    description: `New Slack messages from ${workspaceLabel} will stop going to ${connection.agent.name}. The agent and its existing sessions stay available, and the OpenComputer app stays installed. After disconnecting, connect Slack again and select this workspace for ${nextAgentName}.`,
  }
}
