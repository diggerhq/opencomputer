import { ApiError } from '@/api/client'
import type { ManagedProjectOverview } from './api'

export function isProjectNotFoundError(error: unknown) {
  return (
    error instanceof ApiError &&
    (error.status === 404 || error.type === 'project_not_found')
  )
}

export type ProjectViewState = 'loading' | 'not-found' | 'unavailable' | 'ready'

// A failed background refetch must not replace a project that already
// rendered, and only a 404 means the project is gone: every other failure
// is a transient outage with a retry, not a missing project.
export function projectViewState(query: {
  data: ManagedProjectOverview | undefined
  error: unknown
  isLoading: boolean
}): ProjectViewState {
  if (isProjectNotFoundError(query.error)) return 'not-found'
  if (query.data) return 'ready'
  if (query.isLoading) return 'loading'
  return query.error ? 'unavailable' : 'not-found'
}
