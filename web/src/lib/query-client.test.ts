import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'
import { ME_QUERY_KEY, createQueryClient, isUnauthorized } from './query-client'

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('createQueryClient', () => {
  it('re-checks /me when another query answers 401', async () => {
    const queryClient = createQueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    await queryClient.fetchQuery({
      queryKey: ME_QUERY_KEY,
      queryFn: () => Promise.resolve({ id: 'user_1' }),
    })

    await queryClient
      .fetchQuery({
        queryKey: ['managed-project', 'project_1'],
        queryFn: () => Promise.reject(new ApiError('Unauthorized', 401)),
        retry: false,
      })
      .catch(() => undefined)
    await settle()

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ME_QUERY_KEY })
  })

  it('leaves /me alone for other failures', async () => {
    const queryClient = createQueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    await queryClient.fetchQuery({
      queryKey: ME_QUERY_KEY,
      queryFn: () => Promise.resolve({ id: 'user_1' }),
    })

    await queryClient
      .fetchQuery({
        queryKey: ['managed-project', 'project_1'],
        queryFn: () => Promise.reject(new ApiError('Not found', 404)),
        retry: false,
      })
      .catch(() => undefined)
    await settle()

    expect(invalidate).not.toHaveBeenCalled()
  })

  it('does not re-check /me because of its own 401', async () => {
    const queryClient = createQueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    await queryClient
      .fetchQuery({
        queryKey: ME_QUERY_KEY,
        queryFn: () => Promise.reject(new ApiError('Unauthorized', 401)),
        retry: false,
      })
      .catch(() => undefined)
    await settle()

    expect(invalidate).not.toHaveBeenCalled()
  })
})

describe('isUnauthorized', () => {
  it('matches only a 401 ApiError', () => {
    expect(isUnauthorized(new ApiError('Unauthorized', 401))).toBe(true)
    expect(isUnauthorized(new ApiError('Not found', 404))).toBe(false)
    expect(isUnauthorized(new Error('Unauthorized'))).toBe(false)
  })
})
