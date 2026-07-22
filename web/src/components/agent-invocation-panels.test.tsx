import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { Agent } from '@/api/client'
import { AgentHooksPanel } from './agent-hooks-panel'
import { AgentUrlPanel } from './agent-url-panel'

const agent: Agent = {
  id: 'agt_0123456789abcdef01234567',
  name: 'Reviewer',
  invoke_url: 'https://agt-0123456789abcdef01234567.agents.opencomputer.dev',
  model: 'anthropic/claude-opus-4-8',
  runtime: 'claude',
  credential_id: 'managed',
  revision: 1,
  created_at: '2026-07-22T00:00:00.000Z',
}

function renderPanels() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  queryClient.setQueryData(['agent-hooks', agent.id], {
    pages: [
      {
        data: [
          {
            id: 'hk_0123456789abcdef01234567',
            agent_id: agent.id,
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
        <AgentUrlPanel agent={agent} />
        <AgentHooksPanel agentId={agent.id} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('Agent invocation panels', () => {
  it('keeps root invocation server-only and renders Hook audit metadata', () => {
    const markup = renderPanels()

    expect(markup).toContain(agent.invoke_url)
    expect(markup).toContain('Server-side only')
    expect(markup).toContain('Run test')
    expect(markup).toContain('View sessions')
    expect(markup).toContain(`/agents/${agent.id}/sessions`)
    expect(markup).toContain('grafana-prod')
    expect(markup).toContain('Secret exposure detected')
    expect(markup).toContain('ends in xYz0')
    expect(markup).not.toContain('/hooks/secret')
  })
})
