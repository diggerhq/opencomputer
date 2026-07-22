import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { AgentSecurityAlert } from './agent-security-alert'
import type { AgentSecurityNotification } from '@/api/client'

const alert: AgentSecurityNotification = {
  id: 'hse_aaaaaaaaaaaaaaaaaaaaaaaa',
  agentId: 'agt_bbbbbbbbbbbbbbbbbbbbbbbb',
  hookId: 'hk_cccccccccccccccccccccccc',
  kind: 'secret_exposure',
  occurredAt: '2026-07-08T00:00:00.000Z',
  acknowledgedAt: null,
  acknowledgedBy: null,
}

function render(
  alerts: AgentSecurityNotification[],
  options: { acknowledging?: boolean; acknowledgeFailed?: boolean } = {},
) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AgentSecurityAlert
        alerts={alerts}
        onAcknowledge={vi.fn()}
        {...options}
      />
    </MemoryRouter>,
  )
}

describe('AgentSecurityAlert', () => {
  it('renders persistent server-owned copy, an Agent link, and a keyboard button', () => {
    const markup = render([alert])

    expect(markup).toContain('role="alert"')
    expect(markup).toContain('An Agent Hook URL was exposed and revoked.')
    expect(markup).toContain(
      `href="/agents/${alert.agentId}/settings?section=hooks"`,
    )
    expect(markup).toContain('>Acknowledge</button>')
    expect(markup).toContain('sm:flex-row')
    expect(markup).not.toContain(alert.hookId)
    expect(markup).not.toContain('GitHub')
  })

  it('keeps the alert visible during acknowledgement and after a failed attempt', () => {
    expect(render([alert], { acknowledging: true })).toContain('Acknowledging…')
    expect(render([alert], { acknowledging: true })).toContain('disabled=""')
    expect(render([alert], { acknowledgeFailed: true })).toContain(
      'Could not acknowledge the alert. Try again.',
    )
  })

  it('summarizes multiple alerts and renders nothing once all are acknowledged', () => {
    expect(
      render([alert, { ...alert, id: 'hse_dddddddddddddddddddddddd' }]),
    ).toContain('2 Agent Hook URLs were exposed and revoked.')
    expect(render([])).toBe('')
  })
})
