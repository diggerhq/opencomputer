import { describe, expect, it } from 'vitest'
import {
  missingTemplateConnection,
  templateConnectionConnected,
  templateConnectionLinkable,
  templateConnectionName,
} from './template-connections'

describe('template connections', () => {
  it('links single-grant providers from the template page', () => {
    expect(templateConnectionLinkable('notion')).toBe(true)
    expect(templateConnectionLinkable('searchconsole')).toBe(true)
    expect(templateConnectionLinkable('github')).toBe(true)
    expect(templateConnectionLinkable('google')).toBe(false)
    expect(templateConnectionName('searchconsole')).toBe(
      'Google Search Console',
    )
    expect(templateConnectionName('google')).toBe('Google')
  })

  it('counts only connected grants of the same provider', () => {
    const connections = [
      { provider: 'notion', status: 'connected' },
      { provider: 'github', status: 'pending' },
    ]
    expect(
      templateConnectionConnected({ provider: 'notion' }, connections),
    ).toBe(true)
    expect(
      templateConnectionConnected({ provider: 'github' }, connections),
    ).toBe(false)
  })

  it('blocks deploy only on missing required connections', () => {
    const connections = [{ provider: 'notion', status: 'connected' }]
    expect(
      missingTemplateConnection(
        [
          { provider: 'notion', required: true },
          { provider: 'searchconsole', required: false },
        ],
        connections,
      ),
    ).toBe(false)
    expect(
      missingTemplateConnection(
        [{ provider: 'searchconsole', required: true }],
        connections,
      ),
    ).toBe(true)
  })
})
