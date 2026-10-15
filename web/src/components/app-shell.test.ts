import { describe, expect, it } from 'vitest'
import { BrainCircuit, Database, KeySquare, Plug } from 'lucide-react'
import { managedAgentsNav } from './app-shell-nav'

describe('managed agents navigation', () => {
  const defaults = {
    durableSessionsEnabled: false,
    infrastructureEnabled: false,
  }

  it('lists the project list on the homepage even without advanced areas', () => {
    const nav = managedAgentsNav({
      ...defaults,
      computerEnabled: true,
      hasProjects: true,
    })
    expect(nav.map((group) => group.items.map((item) => item.label))).toEqual([
      ['Computer', 'Automations'],
      ['Connections'],
    ])
    expect(nav[0]?.items[0]).toMatchObject({
      to: '/computer',
      label: 'Computer',
    })
    expect(nav[0]?.items[1]?.end).toBe(true)
    expect(nav[1]?.items[0]).toMatchObject({
      to: '/managed-agents/connections',
      label: 'Connections',
      icon: Plug,
    })
  })

  it('keeps Automations out of the sidebar until the organization has one', () => {
    // A new organization's flow is its computer; projects are a side door.
    expect(
      managedAgentsNav({ ...defaults, computerEnabled: true }).map((group) =>
        group.items.map((item) => item.label),
      ),
    ).toEqual([['Computer'], ['Connections']])
  })

  it('hides the computer from organizations without it (rollout flag)', () => {
    expect(
      managedAgentsNav(defaults)[0]?.items.map((item) => item.label),
    ).toEqual(['Automations'])
  })

  it('shows project navigation only after a project is selected', () => {
    const nav = managedAgentsNav({ ...defaults, projectId: 'project one' })

    expect(nav[0]?.items.map((item) => item.label)).toEqual([
      'Back to all automations',
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
      'Settings',
    ])
    expect(
      nav[1]?.items.find((item) => item.label === 'Debug playground')?.to,
    ).toBe('/projects/project%20one')
    expect(nav[1]?.items[nav[1].items.length - 1]?.to).toBe(
      '/projects/project%20one/settings',
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
