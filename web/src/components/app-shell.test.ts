import { describe, expect, it } from 'vitest'
import { productNav } from './app-shell'

describe('product navigation', () => {
  it('shows only infrastructure for new-user preferences', () => {
    const nav = productNav({
      durableSessionsEnabled: false,
      infrastructureEnabled: true,
    })

    expect(nav.map((group) => group.label)).toEqual(['Infrastructure'])
    expect(nav[0]?.collapsible).toBe(true)
    expect(nav[0]?.items[0]?.label).toBe('Sandboxes')
  })

  it('reveals each advanced group independently', () => {
    expect(
      productNav({
        durableSessionsEnabled: true,
        infrastructureEnabled: false,
      }).map((group) => group.label),
    ).toContain('Durable sessions')

    expect(
      productNav({
        durableSessionsEnabled: false,
        infrastructureEnabled: true,
      }).map((group) => group.label),
    ).toContain('Infrastructure')
  })
})
