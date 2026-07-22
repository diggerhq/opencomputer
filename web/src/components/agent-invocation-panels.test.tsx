import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { AgentHooksPanel } from './agent-hooks-panel'

const agentId = 'agt_0123456789abcdef01234567'

function renderPanels() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  queryClient.setQueryData(['agent-hooks', agentId], {
    pages: [
      {
        data: [
          {
            id: 'hk_0123456789abcdef01234567',
            agent_id: agentId,
            name: 'grafana-prod',
            status: 'revoked',
            secret_last4: 'xYz0',
            revoked_reason: 'secret_exposure',
            expires_at: null,
            created_at: '2026-07-22T00:00:00.000Z',
          },
        ],
        next_cursor: null,
      },
    ],
    pageParams: [undefined],
  })

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AgentHooksPanel agentId={agentId} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Agent Hook settings', () => {
  it('renders Hook audit metadata without recovering its secret', () => {
    const markup = renderPanels()

    expect(markup).toContain('grafana-prod')
    expect(markup).toContain('Secret exposure detected')
    expect(markup).toContain('ends in xYz0')
    expect(markup).not.toContain('/hooks/secret')
  })
})
