import { describe, expect, it } from 'vitest'
import { managedAgentsNav } from './app-shell-nav'

describe('managed agents navigation', () => {
  const defaults = {
    durableSessionsEnabled: false,
    infrastructureEnabled: false,
  }

  it('leaves the homepage sidebar empty when advanced areas are disabled', () => {
    expect(managedAgentsNav(defaults)).toEqual([])
  })

  it('shows project navigation only after a project is selected', () => {
    const nav = managedAgentsNav({ ...defaults, projectId: 'project one' })

    expect(nav[0]?.items.map((item) => item.label)).toEqual([
      'Back to all projects',
    ])
    expect(nav[1]?.items.map((item) => item.label)).toEqual([
      'Deployments',
      'Sessions',
      'Channels',
      'Outboxes',
      'Schedules',
      'Webhooks',
      'Secrets',
      'BYOK',
      'Debug playground',
    ])
    expect(nav[1]?.items[nav[1].items.length - 1]?.to).toBe(
      '/projects/project%20one',
    )
  })

  it('reveals each advanced area independently', () => {
    expect(
      managedAgentsNav({
        ...defaults,
        durableSessionsEnabled: true,
      }).map((group) => group.label),
    ).toEqual(['Durable sessions'])

    expect(
      managedAgentsNav({
        ...defaults,
        infrastructureEnabled: true,
      }).map((group) => group.label),
    ).toEqual(['Infrastructure'])
  })

  it('keeps enabled advanced areas below project navigation', () => {
    expect(
      managedAgentsNav({
        projectId: 'project-one',
        durableSessionsEnabled: true,
        infrastructureEnabled: true,
      }).map((group) => group.label),
    ).toEqual([undefined, undefined, 'Durable sessions', 'Infrastructure'])
  })
})
