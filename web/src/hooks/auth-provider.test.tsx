import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/client'
import { AuthProvider } from './auth-provider'
import { useAuth } from './useAuth'

const me = {
  id: 'user_1',
  email: 'devin-verify@mo-oc-dev.com',
  orgId: 'org_1',
  durableSessionsEnabled: false,
  infrastructureEnabled: false,
}

function WhoAmI() {
  const { user, loading, error } = useAuth()
  return (
    <span>
      {loading ? 'loading' : user ? `user:${user.email}` : 'anonymous'}
      {error ? `;error:${error}` : ''}
    </span>
  )
}

function renderAuth(input: { data?: unknown; error?: Error }) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryOnMount: false, staleTime: Infinity },
    },
  })
  const query = queryClient
    .getQueryCache()
    .build(queryClient, { queryKey: ['me'] })
  if (input.data !== undefined) query.setData(input.data)
  if (input.error) {
    query.setState({
      status: 'error',
      error: input.error,
      fetchStatus: 'idle',
      errorUpdateCount: 1,
    })
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <WhoAmI />
      </AuthProvider>
    </QueryClientProvider>,
  )
}

describe('auth provider', () => {
  it('exposes the signed-in user from /me', () => {
    expect(renderAuth({ data: me })).toBe(
      '<span>user:devin-verify@mo-oc-dev.com</span>',
    )
  })

  it('drops the cached user once /me answers 401', () => {
    expect(
      renderAuth({ data: me, error: new ApiError('Unauthorized', 401) }),
    ).toBe('<span>anonymous</span>')
  })

  it('keeps the cached user and surfaces other refetch failures', () => {
    expect(
      renderAuth({ data: me, error: new TypeError('Failed to fetch') }),
    ).toBe('<span>user:devin-verify@mo-oc-dev.com;error:Failed to fetch</span>')
  })
})
