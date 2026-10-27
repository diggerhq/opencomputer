import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@/api/client'
import { HttpRequestCard, MessageBubble } from './session-conversation'

describe('HttpRequestCard', () => {
  it('renders the attributed payload as structured, escaped JSON', () => {
    const event: SessionEvent = {
      id: 'evt_http',
      seq: 1,
      type: 'http.request',
      level: 'user',
      source: 'http',
      actor: {
        id: 'hk_0123456789abcdef01234567',
        type: 'trigger',
        display: 'grafana-prod',
      },
      body: { payload: { title: '<script>alert(1)</script>', count: 2 } },
    }

    const markup = renderToStaticMarkup(
      <HttpRequestCard event={event} seq={event.seq} />,
    )

    expect(markup).toContain('grafana-prod')
    expect(markup).toContain('HTTP input')
    expect(markup).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(markup).not.toContain('<script>')
    expect(markup).toContain('&quot;count&quot;: 2')
  })
})

describe('MessageBubble', () => {
  it('sends an out-of-credits agent to the plan picker', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <MessageBubble label="Agent" text="Out of credits" outOfCredits />
      </MemoryRouter>,
    )

    expect(markup).toContain('href="/billing#plans"')
    expect(markup).toContain('Choose a plan')
  })
})
