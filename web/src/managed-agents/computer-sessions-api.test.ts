import { afterEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'
import { getSession } from './computer-sessions-api'

afterEach(() => vi.unstubAllGlobals())

it("reads an admin's access-only answer as a 404 that carries the access", async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        Response.json({
          session: null,
          access: { mode: 'owner', people: [] },
          canManageAccess: true,
          seq: 4,
        }),
      ),
    ),
  )
  const error = await getSession('cs_1').catch((e: unknown) => e)
  expect(error).toBeInstanceOf(ApiError)
  expect((error as ApiError).status).toBe(404)
  expect((error as ApiError).details).toEqual({
    access: { mode: 'owner', people: [] },
    canManageAccess: true,
  })
})
