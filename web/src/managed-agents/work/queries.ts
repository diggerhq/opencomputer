import { useQuery } from '@tanstack/react-query'
import { ApiError } from '@/api/errors'
import {
  getRepositories,
  getRepository,
  useOrg,
  workKeys,
  workRetryDelay,
} from './api'

// The queries more than one screen reads, so they share one cache entry.

/** Retry twice, except a 404: the routes are not there. */
export const notThereYet = (count: number, error: Error) =>
  !(error instanceof ApiError && error.status === 404) && count < 2

/** The chosen repository, with its problem when it cannot be read. */
export function useRepository() {
  return useQuery({
    queryKey: workKeys.repository(useOrg()),
    queryFn: getRepository,
    retry: notThereYet,
    retryDelay: workRetryDelay,
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
    retryDelay: workRetryDelay,
    enabled,
  })
}
