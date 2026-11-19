import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError } from '@/api/errors'
import {
  getOpenItems,
  getRepositories,
  getRepository,
  keepOpenItems,
  useOrg,
  workKeys,
  type OpenItemsPoll,
} from './api'
import { OPEN_POLL_MS } from './board'

// The queries more than one screen reads, so they share one cache entry.

const notThereYet = (count: number, error: Error) =>
  !(error instanceof ApiError && error.status === 404) && count < 2

/**
 * The open items, polled with the last ETag: the board's data, and on the
 * settings page how fresh the index is (`asOf`, `head`, `building`).
 */
export function useOpenItems() {
  const qc = useQueryClient()
  const key = workKeys.open(useOrg())
  return useQuery({
    queryKey: key,
    queryFn: async () => {
      const prev = qc.getQueryData<OpenItemsPoll>(key)
      const next = await getOpenItems(prev?.etag ?? null)
      if (prev) return keepOpenItems(prev, next)
      if (!('notModified' in next)) return next
      // A 304 with nothing cached cannot happen (no ETag was sent); ask again.
      return (await getOpenItems(null)) as OpenItemsPoll
    },
    refetchInterval: OPEN_POLL_MS,
    retry: notThereYet,
  })
}

/** The chosen repository, with its problem when it cannot be read. */
export function useRepository() {
  return useQuery({
    queryKey: workKeys.repository(useOrg()),
    queryFn: getRepository,
    retry: notThereYet,
  })
}

/**
 * The installations and what they grant. Read again whenever the window
 * regains focus (past the default 30 s staleTime), so coming back from GitHub
 * shows a repository just granted.
 */
export function useGrantingInstallations(enabled = true) {
  return useQuery({
    queryKey: workKeys.repositories(useOrg()),
    queryFn: getRepositories,
    refetchOnWindowFocus: 'always',
    enabled,
  })
}
