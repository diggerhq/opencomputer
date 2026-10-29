import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import APIKeys from './APIKeys'
import Sandboxes from './Sandboxes'

const pages = [
  {
    Component: APIKeys,
    queryKey: ['api-keys'],
    label: 'API keys',
    empty: 'No API keys yet',
    row: {
      id: 'key_test',
      orgId: 'org_test',
      keyPrefix: 'osb_test',
      name: 'Production integration',
      scopes: [],
      createdAt: '2026-07-17T00:00:00.000Z',
    },
    rowText: 'Production integration',
  },
  {
    Component: Sandboxes,
    queryKey: ['sandboxes', ''],
    label: 'sandboxes',
    empty: 'No sandboxes found',
    row: {
      id: 'session_test',
      sandboxId: 'sandbox_test',
      status: 'running',
      agentId: 'agent_test',
      createdAt: '2026-07-17T00:00:00.000Z',
    },
    rowText: 'sandbox_test',
  },
]

describe.each(pages)('$label list states', (page) => {
  function render(rows: unknown[] | undefined, failed = false) {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, retryOnMount: false, staleTime: Infinity },
      },
    })
    const query = client.getQueryCache().build(client, {
      queryKey: page.queryKey,
    })
    query.setState({
      data: rows,
      status: failed ? 'error' : 'success',
      error: failed ? new Error('Unavailable') : null,
    })
    return renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <page.Component />
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it('distinguishes a failed load from an empty list and offers retry', () => {
    const markup = render(undefined, true)
    expect(markup).toContain('role="alert"')
    expect(markup).toContain(`load ${page.label}`)
    expect(markup).toContain('Try again')
    expect(markup).not.toContain(page.empty)
  })

  it('does not present a cached empty list as authoritative after a failure', () => {
    expect(render([], true)).not.toContain(page.empty)
  })

  it('preserves previous rows and warns when a refresh fails', () => {
    const markup = render([page.row], true)
    expect(markup).toContain(`refresh ${page.label}`)
    expect(markup).toContain('Showing previously loaded results')
    expect(markup).toContain(page.rowText)
  })

  it('keeps the empty state for a successful empty response', () => {
    const markup = render([])
    expect(markup).toContain(page.empty)
    expect(markup).not.toContain('role="alert"')
  })
})
