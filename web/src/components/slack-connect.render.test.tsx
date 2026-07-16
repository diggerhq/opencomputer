import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { SlackConnect } from './slack-connect'
import { managedSlackConnectionsQueryKey } from '@/lib/managed-slack-connections'

const agentId = 'agt_aaaaaaaaaaaaaaaaaaaaaaaa'
const connectedAgentId = 'agt_bbbbbbbbbbbbbbbbbbbbbbbb'

function renderSlackConnect(
  managed: Record<string, unknown> | null | undefined,
  url = `/agents/${agentId}`,
  connectedAgentName?: string,
  managedConnections: Array<Record<string, unknown>> = [],
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  if (managed !== undefined) {
    queryClient.setQueryData(['slack', 'managed', agentId], managed)
  }
  queryClient.setQueryData(['slack', 'byo', agentId], null)
  queryClient.setQueryData(managedSlackConnectionsQueryKey, managedConnections)
  if (connectedAgentName) {
    queryClient.setQueryData(['agent', connectedAgentId], {
      id: connectedAgentId,
      name: connectedAgentName,
    })
  }

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[url]}>
        <SlackConnect agentId={agentId} agentName="Support triage" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('SlackConnect managed states', () => {
  it('waits for authoritative connection state before showing OAuth success', () => {
    const loadingMarkup = renderSlackConnect(
      undefined,
      `/agents/${agentId}?slack=connected`,
    )
    expect(loadingMarkup).not.toContain('Slack connected')

    const connectedMarkup = renderSlackConnect(
      {
        mode: 'managed',
        status: 'active',
        workspace: { id: 'T1', name: 'Acme' },
        app: { id: 'A1', handle: 'OpenComputer' },
        connected_at: '2026-07-16T18:00:00Z',
      },
      `/agents/${agentId}?slack=connected`,
    )
    expect(connectedMarkup).toContain('Slack connected')
    expect(connectedMarkup).toContain(
      'OpenComputer will send messages in Acme to Support triage.',
    )
  })

  it('preserves disconnected lifecycle truth and offers reconnection', () => {
    const markup = renderSlackConnect({
      mode: 'managed',
      status: 'disconnected',
      workspace: { id: 'T1', name: 'Acme' },
      app: { id: 'A1', handle: 'OpenComputer' },
      connected_at: '2026-07-16T18:00:00Z',
    })

    expect(markup).toContain('no longer receives messages')
    expect(markup).toContain('Connect Slack again')
  })

  it('names and links a same-owner workspace conflict', () => {
    const markup = renderSlackConnect(
      null,
      `/agents/${agentId}?slack=workspace_already_connected&connected_agent=${connectedAgentId}`,
      'Docs writer',
    )

    expect(markup).toContain('This workspace sends messages to Docs writer.')
    expect(markup).toContain(`href="/agents/${connectedAgentId}"`)
    expect(markup).toContain('Open connected agent')
  })

  it('keeps a cross-owner workspace conflict anonymous', () => {
    const markup = renderSlackConnect(
      null,
      `/agents/${agentId}?slack=workspace_already_connected`,
    )

    expect(markup).toContain(
      'Connect a different workspace or use your own Slack app for this agent.',
    )
    expect(markup).not.toContain('Open connected agent')
  })

  it('shows and links an existing workspace claim before OAuth', () => {
    const markup = renderSlackConnect(null, `/agents/${agentId}`, undefined, [
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
    expect(markup).toContain(`href="/agents/${connectedAgentId}"`)
    expect(markup).toContain('Connect another workspace')
  })
})
