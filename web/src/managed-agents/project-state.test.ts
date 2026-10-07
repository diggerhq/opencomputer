import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/client'
import { isProjectNotFoundError, projectViewState } from './project-state'
import type { ManagedProjectOverview } from './api'

const now = new Date().toISOString()
const overview = {
  project: {
    id: 'prj_1',
    slug: 'support',
    name: 'Support',
    environments: [],
    agents: [{ id: 'agent_1', name: 'Support agent' }],
    createdAt: now,
    updatedAt: now,
  },
  sessions: [],
  deployments: [],
  connections: [],
  channels: [],
  schedules: [],
  schema: {},
} as unknown as ManagedProjectOverview

describe('isProjectNotFoundError', () => {
  it('recognizes a 404 and the typed project_not_found code', () => {
    expect(isProjectNotFoundError(new ApiError('Not found', 404))).toBe(true)
    expect(
      isProjectNotFoundError(new ApiError('Gone', 410, 'project_not_found')),
    ).toBe(true)
  })

  it('leaves outages and other failures visible as errors', () => {
    expect(isProjectNotFoundError(new ApiError('Upstream', 502))).toBe(false)
    expect(isProjectNotFoundError(new TypeError('Failed to fetch'))).toBe(false)
    expect(isProjectNotFoundError(undefined)).toBe(false)
  })
})

describe('projectViewState', () => {
  it('is loading before the first response', () => {
    expect(
      projectViewState({ data: undefined, error: null, isLoading: true }),
    ).toBe('loading')
  })

  it('reports not found only for a 404', () => {
    expect(
      projectViewState({
        data: undefined,
        error: new ApiError('Not found', 404),
        isLoading: false,
      }),
    ).toBe('not-found')
  })

  it('reports an outage instead of not found for other failures', () => {
    expect(
      projectViewState({
        data: undefined,
        error: new ApiError('Bad gateway', 502),
        isLoading: false,
      }),
    ).toBe('unavailable')
    expect(
      projectViewState({
        data: undefined,
        error: new TypeError('Failed to fetch'),
        isLoading: false,
      }),
    ).toBe('unavailable')
  })

  it('keeps a loaded project on screen through a failed background refetch', () => {
    expect(
      projectViewState({
        data: overview,
        error: new ApiError('Bad gateway', 502),
        isLoading: false,
      }),
    ).toBe('ready')
  })

  it('drops to not found when a loaded project is deleted', () => {
    expect(
      projectViewState({
        data: overview,
        error: new ApiError('Not found', 404),
        isLoading: false,
      }),
    ).toBe('not-found')
  })
})
