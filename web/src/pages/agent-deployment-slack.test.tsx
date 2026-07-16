import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { AgentDeployment as AgentDeploymentRecord } from '@/api/client'
import AgentDeployment from './AgentDeployment'
import { managedSlackConnectionsQueryKey } from '@/lib/managed-slack-connections'

const agentId = 'agt_aaaaaaaaaaaaaaaaaaaaaaaa'
const deploymentId = 'dep_aaaaaaaaaaaaaaaaaaaaaaaa'
const connectedAgentId = 'agt_bbbbbbbbbbbbbbbbbbbbbbbb'

const deployment: AgentDeploymentRecord = {
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

function renderDeployment(
  managed: Record<string, unknown> | null | undefined,
  search = '',
  connectedAgentName?: string,
  managedConnections: Array<Record<string, unknown>> = [],
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  queryClient.setQueryData(
    ['agent-deployment', agentId, deploymentId],
    deployment,
  )
  queryClient.setQueryData(['agent', agentId], {
    id: agentId,
    name: 'Support triage',
  })
  queryClient.setQueryData(['agent-deployment-logs', agentId, deploymentId], {
    data: [],
    cursor: null,
  })
  if (managed !== undefined) {
    queryClient.setQueryData(['slack', 'managed', agentId], managed)
  }
  queryClient.setQueryData(managedSlackConnectionsQueryKey, managedConnections)
  if (connectedAgentName) {
    queryClient.setQueryData(['agent', connectedAgentId], {
      id: connectedAgentId,
      name: connectedAgentName,
    })
  }

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter
        initialEntries={[
          `/agents/${agentId}/deployments/${deploymentId}${search}`,
        ]}
      >
        <Routes>
          <Route
            path="/agents/:agentId/deployments/:deploymentId"
            element={<AgentDeployment />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('deployment managed Slack composition', () => {
  it('waits for authoritative active state before showing OAuth success', () => {
    expect(renderDeployment(undefined, '?slack=connected')).not.toContain(
      'Slack connected',
    )
    expect(renderDeployment(null, '?slack=connected')).not.toContain(
      'Slack connected',
    )

    const connected = renderDeployment(
      {
        mode: 'managed',
        status: 'active',
        workspace: { id: 'T1', name: 'Acme' },
        app: { id: 'A1', handle: 'OpenComputer' },
        open_url: 'https://slack.com/app_redirect?app=A1&team=T1',
        connected_at: '2026-07-16T18:00:00Z',
      },
      '?slack=connected',
    )
    expect(connected).toContain('Slack connected')
    expect(connected).toContain(
      'OpenComputer will send messages in Acme to Support triage.',
    )
  })

  it('names and links only an authoritative same-owner conflict', () => {
    const connected = renderDeployment(
      null,
      `?slack=workspace_already_connected&connected_agent=${connectedAgentId}`,
      'Docs writer',
    )
    expect(connected).toContain('This workspace sends messages to Docs writer.')
    expect(connected).toContain(`href="/agents/${connectedAgentId}"`)

    const malformed = renderDeployment(
      null,
      '?slack=workspace_already_connected&connected_agent=agt_not-an-id',
    )
    expect(malformed).toContain(
      'Connect a different workspace or use your own Slack app for this agent.',
    )
    expect(malformed).not.toContain('Open connected agent')
  })

  it('surfaces a known workspace claim before starting OAuth', () => {
    const markup = renderDeployment(null, '', undefined, [
      {
        mode: 'managed',
        status: 'active',
        workspace: { id: 'T1', name: 'Acme' },
        app: { id: 'A1', handle: 'OpenComputer' },
        connected_at: '2026-07-16T18:00:00Z',
        agent: { id: connectedAgentId, name: 'Docs writer' },
      },
    ])

    expect(markup).toContain('Slack workspaces already in use')
    expect(markup).toContain('Sends messages to Docs writer')
    expect(markup).toContain('Connect another workspace')
  })
})
