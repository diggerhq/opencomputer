import { describe, expect, it } from 'vitest'
import { managedAgentsNav } from './app-shell'

describe('managed agents navigation', () => {
  it('shows only unlabeled agents and connections by default', () => {
    const nav = managedAgentsNav({
      durableSessionsEnabled: false,
      infrastructureEnabled: false,
    })

    expect(nav.map((group) => group.label)).toEqual([undefined])
    expect(nav[0]?.collapsible).toBeUndefined()
    expect(nav[0]?.items.map((item) => item.label)).toEqual([
      'Agents',
      'Connections',
    ])
  })

  it('reveals each advanced group independently', () => {
    expect(
      managedAgentsNav({
        durableSessionsEnabled: true,
        infrastructureEnabled: false,
      }).map((group) => group.label),
    ).toContain('Durable sessions')

    expect(
      managedAgentsNav({
        durableSessionsEnabled: false,
        infrastructureEnabled: true,
      }).map((group) => group.label),
    ).toContain('Infrastructure')
  })
})
