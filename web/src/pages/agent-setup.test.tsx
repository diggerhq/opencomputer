import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { AgentDeployment } from '@/api/client'
import AgentSetup from './AgentSetup'

const agentId = 'agt_aaaaaaaaaaaaaaaaaaaaaaaa'
const deploymentId = 'dep_aaaaaaaaaaaaaaaaaaaaaaaa'

const buildingDeployment: AgentDeployment = {
  id: deploymentId,
  state: 'building',
  phase: 'build',
  terminal: false,
  result: null,
  input_type: 'github',
  revision_id: null,
  revision: null,
  source: null,
  source_relation: {
    repo: {
      id: 'repo_aaaaaaaaaaaaaaaaaaaaaaaa',
      full_name: 'example/support-agent',
    },
    path: '',
    production_ref: 'main',
    status: 'active',
    ref: 'main',
    sha: 'a'.repeat(40),
    commit_url: null,
  },
  actor: null,
  ref: 'main',
  sha: 'a'.repeat(40),
  error: null,
  error_class: null,
  build: null,
  configuration: null,
  log_bytes: 0,
  log_truncated: false,
  live_touched: false,
  agent_live: null,
  restore_eligibility: 'none',
  redeploy_of: null,
  allowed_actions: ['open_agent'],
  active: false,
  timing: {
    accepted_at: '2026-07-16T18:00:00Z',
    started_at: '2026-07-16T18:00:01Z',
    finished_at: null,
    cancel_requested_at: null,
    queue_ms: 1_000,
    run_ms: null,
    total_ms: null,
  },
  created_at: '2026-07-16T18:00:00Z',
  updated_at: '2026-07-16T18:00:02Z',
  started_at: '2026-07-16T18:00:01Z',
  finished_at: null,
}

const activeSlack = {
  mode: 'managed',
  status: 'active',
  workspace: { id: 'T1', name: 'Acme' },
  app: { id: 'A1', handle: 'OpenComputer' },
  open_url: 'https://slack.com/app_redirect?app=A1&team=T1',
  connected_at: '2026-07-16T18:00:00Z',
}

function renderSetup(input: {
  deployment?: AgentDeployment
  managed?: Record<string, unknown> | null
  search?: string
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  queryClient.setQueryData(['agent', agentId], {
    id: agentId,
    name: 'Support triage',
  })
  if (input.deployment) {
    queryClient.setQueryData(
      ['agent-deployment', agentId, deploymentId],
      input.deployment,
    )
  }
  if ('managed' in input) {
    queryClient.setQueryData(['slack', 'managed', agentId], input.managed)
  }

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter
        initialEntries={[`/agents/${agentId}/setup${input.search ?? ''}`]}
      >
        <Routes>
          <Route path="/agents/:agentId/setup" element={<AgentSetup />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('agent setup', () => {
  it('keeps the deployment in the background and makes Slack primary', () => {
    const markup = renderSetup({
      deployment: buildingDeployment,
      managed: null,
      search: `?deployment=${deploymentId}`,
    })

    expect(markup).toContain('Connect Slack while we prepare Support triage')
    expect(markup).toContain('>Connect Slack</button>')
    expect(markup).toContain('Preparing your agent')
    expect(markup).toContain('<details')
    expect(markup).not.toContain('<details open=""')
  })

  it('waits visibly after Slack connects and promotes chat when ready', () => {
    const building = renderSetup({
      deployment: buildingDeployment,
      managed: activeSlack,
      search: `?deployment=${deploymentId}`,
    })
    expect(building).toContain('Slack is connected')
    expect(building).toContain('Finishing deployment…')
    expect(building).not.toContain('>Open Slack<')

    const ready = renderSetup({
      deployment: {
        ...buildingDeployment,
        state: 'ready',
        phase: 'verify',
        terminal: true,
        active: true,
        allowed_actions: ['open_agent', 'start_session'],
      },
      managed: activeSlack,
      search: `?deployment=${deploymentId}`,
    })
    expect(ready).toContain('Send your first message')
    expect(ready).toContain('>Open Slack<')
    expect(ready).toContain(
      'href="https://slack.com/app_redirect?app=A1&amp;team=T1"',
    )
  })

  it('uses the same activation flow for a manually created agent', () => {
    const markup = renderSetup({ managed: null })

    expect(markup).toContain('Support triage is ready')
    expect(markup).toContain('Your manually configured agent is ready to use.')
    expect(markup).toContain('>Connect Slack</button>')
  })

  it('does not trust an OAuth success query without active Slack state', () => {
    const unconfirmed = renderSetup({
      deployment: buildingDeployment,
      managed: null,
      search: `?deployment=${deploymentId}&slack=connected`,
    })

    expect(unconfirmed).not.toContain(
      'OpenComputer will send messages in Acme to Support triage.',
    )
  })
})
