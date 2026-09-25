import { describe, expect, it } from 'vitest'
import { BrainCircuit, Database, KeySquare, Plug } from 'lucide-react'
import { managedAgentsNav } from './app-shell-nav'

describe('managed agents navigation', () => {
  const defaults = {
    durableSessionsEnabled: false,
    infrastructureEnabled: false,
  }

  it('lists the project list on the homepage even without advanced areas', () => {
    expect(
      managedAgentsNav(defaults).map((group) =>
        group.items.map((item) => item.label),
      ),
    ).toEqual([['Projects'], ['Connections']])
    expect(managedAgentsNav(defaults)[0]?.items[0]?.end).toBe(true)
    expect(managedAgentsNav(defaults)[1]?.items[0]).toMatchObject({
      to: '/managed-agents/connections',
      label: 'Connections',
      icon: Plug,
    })
  })

  it('shows project navigation only after a project is selected', () => {
    const nav = managedAgentsNav({ ...defaults, projectId: 'project one' })

    expect(nav[0]?.items.map((item) => item.label)).toEqual([
      'Back to all projects',
    ])
    expect(nav[1]?.items.map((item) => item.label)).toEqual([
      'Deployments',
      'Sessions',
      'Schedules',
      'Webhooks',
      'Memory',
      'Database',
      'Secrets',
      'Connections',
      'BYOK',
      'Debug playground',
    ])
    expect(nav[1]?.items[nav[1].items.length - 1]?.to).toBe(
      '/projects/project%20one',
    )
    expect(nav[1]?.items.find((item) => item.label === 'Secrets')?.icon).toBe(
      KeySquare,
    )
    expect(nav[1]?.items.find((item) => item.label === 'Database')?.icon).toBe(
      Database,
    )
    expect(nav[1]?.items.find((item) => item.label === 'Connections')?.to).toBe(
      '/projects/project%20one/connections',
    )
    expect(nav[1]?.items.find((item) => item.label === 'BYOK')?.icon).toBe(
      BrainCircuit,
    )
  })

  it('reveals each advanced area independently', () => {
    expect(
      managedAgentsNav({
        ...defaults,
        durableSessionsEnabled: true,
      }).map((group) => group.label),
    ).toEqual([undefined, 'Account', 'Durable sessions'])

    expect(
      managedAgentsNav({
        ...defaults,
        infrastructureEnabled: true,
      }).map((group) => group.label),
    ).toEqual([undefined, 'Account', 'Infrastructure'])
  })

  it('shows only project-scoped navigation inside a project', () => {
    expect(
      managedAgentsNav({
        projectId: 'project-one',
        durableSessionsEnabled: true,
        infrastructureEnabled: true,
      }).map((group) => group.label),
    ).toEqual([undefined, undefined])
  })
})
