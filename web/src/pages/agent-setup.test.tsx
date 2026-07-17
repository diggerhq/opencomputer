import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type {
  AgentDeployment,
  ManagedSlackWorkspaceConnection,
  Session,
  SessionEvent,
} from '@/api/client'
import { managedSlackConnectionsQueryKey } from '@/lib/managed-slack-connections'
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
  mode: 'managed' as const,
  status: 'active' as const,
  workspace: { id: 'T1', name: 'Acme' },
  app: { id: 'A1', handle: 'OpenComputer' },
  open_url: 'https://slack.com/app_redirect?app=A1&team=T1',
  connected_at: '2026-07-16T18:00:00Z',
}

function renderSetup(input: {
  deployment?: AgentDeployment
  managed?: Record<string, unknown> | null
  search?: string
  agent?: Record<string, unknown>
  sessions?: Session[]
  events?: { sessionId: string; data: SessionEvent[] }
  managedConnections?: ManagedSlackWorkspaceConnection[]
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  queryClient.setQueryData(
    ['agent', agentId],
    input.agent ?? {
      id: agentId,
      name: 'Support triage',
      runtime: 'claude',
      revision: 1,
      active_revision_id: 'rev_aaaaaaaaaaaaaaaaaaaaaaaa',
    },
  )
  if (input.deployment) {
    queryClient.setQueryData(
      ['agent-deployment', agentId, deploymentId],
      input.deployment,
    )
  }
  if ('managed' in input) {
    queryClient.setQueryData(['slack', 'managed', agentId], input.managed)
  }
  queryClient.setQueryData(
    managedSlackConnectionsQueryKey,
    input.managedConnections ?? [],
  )
  if (input.sessions) {
    queryClient.setQueryData(
      [
        'agent-setup',
        'managed-slack-sessions',
        agentId,
        input.managed?.connected_at ?? null,
      ],
      input.sessions,
    )
  }
  if (input.events) {
    queryClient.setQueryData(
      ['session-events', input.events.sessionId],
      input.events.data,
    )
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
    expect(ready).toContain('Waiting for your first Slack message')
    expect(ready).toContain(
      'href="https://slack.com/app_redirect?app=A1&amp;team=T1"',
    )
  })

  it('does not promote chat until the deployment admits sessions', () => {
    const markup = renderSetup({
      deployment: {
        ...buildingDeployment,
        state: 'ready',
        phase: 'verify',
        terminal: true,
        active: true,
        allowed_actions: ['open_agent'],
      },
      managed: activeSlack,
      search: `?deployment=${deploymentId}`,
    })

    expect(markup).toContain('Finishing deployment…')
    expect(markup).not.toContain('>Open Slack<')
    expect(markup).not.toContain('Waiting for your first Slack message')
  })

  it('turns a real managed Slack session into a conversation preview', () => {
    const sessionId = 'ses_aaaaaaaaaaaaaaaaaaaaaaaa'
    const readyDeployment: AgentDeployment = {
      ...buildingDeployment,
      state: 'ready',
      phase: 'verify',
      terminal: true,
      active: true,
      allowed_actions: ['open_agent', 'start_session'],
    }
    const session: Session = {
      id: sessionId,
      status: 'running',
      agent_id: agentId,
      metadata: { slack: { mode: 'managed', team_id: 'T1' } },
      created_at: '2026-07-16T18:00:01Z',
    }
    const events: SessionEvent[] = [
      {
        id: 'evt_input',
        seq: 1,
        type: 'user.message',
        level: 'user',
        body: { text: 'Hello from Slack' },
        source: 'client',
      },
      {
        id: 'evt_reply',
        seq: 2,
        type: 'agent.message',
        level: 'user',
        body: { text: 'Hello! Your agent is ready.' },
        source: 'runtime',
      },
    ]

    const markup = renderSetup({
      deployment: readyDeployment,
      managed: activeSlack,
      sessions: [session],
      events: { sessionId, data: events },
      search: `?deployment=${deploymentId}`,
    })

    expect(markup).toContain('Support triage is live in Slack')
    expect(markup).toContain('Continue in Slack')
    expect(markup).toContain('Hello from Slack')
    expect(markup).toContain('Hello! Your agent is ready.')
    expect(markup).toContain(`href="/sessions/${sessionId}"`)
    expect(markup).toContain(`href="/agents/${agentId}/sessions"`)
    expect(markup).toContain(`href="/agents/${agentId}"`)
    expect(markup).toContain('>View agent<')
  })

  it('shows an existing workspace claim before OAuth', () => {
    const connectedAgentId = 'agt_bbbbbbbbbbbbbbbbbbbbbbbb'
    const markup = renderSetup({
      deployment: buildingDeployment,
      managed: null,
      managedConnections: [
        {
          ...activeSlack,
          agent: { id: connectedAgentId, name: 'Docs writer' },
        },
      ],
      search: `?deployment=${deploymentId}`,
    })

    expect(markup).toContain('Slack workspaces already in use')
    expect(markup).toContain('Sends messages to Docs writer')
    expect(markup).toContain(`href="/agents/${connectedAgentId}"`)
    expect(markup).toContain('>Disconnect</button>')
    expect(markup).toContain('>Connect another workspace</button>')
  })

  it('uses the same activation flow for a manually created agent', () => {
    const markup = renderSetup({ managed: null })

    expect(markup).toContain('Support triage is ready')
    expect(markup).toContain('Your agent is ready to use.')
    expect(markup).toContain('>Connect Slack</button>')
  })

  it('does not invent readiness when setup has no deployment query', () => {
    const markup = renderSetup({
      managed: null,
      agent: {
        id: agentId,
        name: 'Support triage',
        runtime: 'flue',
        revision: 0,
        active_revision_id: null,
        deployment_status: {
          deployment_id: deploymentId,
          state: 'building',
          result: null,
          error_class: null,
          live_touched: false,
          live_status: null,
          updated_at: '2026-07-16T18:00:02Z',
        },
      },
    })

    expect(markup).toContain('Connect Slack while we prepare Support triage')
    expect(markup).toContain(
      'Setup is following the latest deployment in the background.',
    )
    expect(markup).not.toContain('Support triage is ready')
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

  it('stops waiting and explains a terminal OAuth result', () => {
    const markup = renderSetup({
      deployment: buildingDeployment,
      managed: {
        ...activeSlack,
        status: 'error',
        connected_at: null,
      },
      search: `?deployment=${deploymentId}&slack=connected`,
    })

    expect(markup).toContain('Slack couldn&#x27;t finish connecting')
    expect(markup).toContain('Reconnect Slack and try again.')
    expect(markup).toContain('>Reconnect Slack</button>')
  })
})
