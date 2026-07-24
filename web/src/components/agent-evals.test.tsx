import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { AgentEvals } from './agent-evals'

const agentId = 'agt_0123456789abcdef01234567'

function render() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  qc.setQueryData(['eval-datasets', agentId], [
    {
      id: 'evd_1',
      agent_id: agentId,
      name: 'smoke suite',
      examples: [{ id: 'ex1', input: 'What is 2+2?', expect: { contains: ['4'] } }],
      created_at: 1,
      updated_at: 1,
    },
  ])
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AgentEvals agentId={agentId} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('AgentEvals', () => {
  it('renders the datasets for an agent', () => {
    const markup = render()
    expect(markup).toContain('smoke suite')
    expect(markup).toContain('Evals')
    expect(markup).toContain('New dataset')
  })
})
