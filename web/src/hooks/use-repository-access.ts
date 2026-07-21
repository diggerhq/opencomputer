import { useQuery } from '@tanstack/react-query'
import { getRepositoryAccess } from '@/api/client'
import { repositoryAccessQueryKey } from '@/lib/repository-access'

export function useRepositoryAccess(agentId: string, enabled = true) {
  return useQuery({
    queryKey: repositoryAccessQueryKey(agentId),
    queryFn: () => getRepositoryAccess(agentId),
    enabled: enabled && Boolean(agentId),
    staleTime: 15_000,
    refetchOnWindowFocus: 'always',
  })
}
