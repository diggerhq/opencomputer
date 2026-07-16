import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getAgentDeploymentLogs, type AgentDeploymentLog } from '@/api/client'

export function useAgentDeploymentLogs(input: {
  agentId: string
  deploymentId: string
  enabled: boolean
  terminal: boolean
}) {
  const queryClient = useQueryClient()
  const queryKey = [
    'agent-deployment-logs',
    input.agentId,
    input.deploymentId,
  ] as const
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const previous = queryClient.getQueryData<{
        data: AgentDeploymentLog[]
        cursor: string | null
      }>(queryKey)
      const data = previous?.data ? [...previous.data] : []
      const seen = new Set(data.map((entry) => entry.cursor))
      let cursor = previous?.cursor ?? null
      let hasMore = false
      do {
        const page = await getAgentDeploymentLogs(
          input.agentId,
          input.deploymentId,
          { after: cursor ?? undefined, limit: 500 },
        )
        for (const entry of page.data) {
          if (!seen.has(entry.cursor)) {
            seen.add(entry.cursor)
            data.push(entry)
          }
        }
        const nextCursor = page.next_cursor
        hasMore = page.has_more && !!nextCursor && nextCursor !== cursor
        if (nextCursor) cursor = nextCursor
      } while (hasMore)
      return { data, cursor }
    },
    enabled: input.enabled && !!input.agentId && !!input.deploymentId,
    refetchInterval: input.terminal ? false : 1500,
  })

  const refetch = query.refetch
  useEffect(() => {
    if (input.enabled && input.terminal) void refetch()
    // One final durable read when an open log terminalizes.
  }, [input.enabled, input.terminal, refetch])

  return query
}
