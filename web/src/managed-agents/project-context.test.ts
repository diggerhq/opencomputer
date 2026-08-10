import { describe, expect, it } from 'vitest'
import {
  projectContextSearch,
  projectEnvironmentSearch,
  selectedProjectAgentId,
} from './project-context'

const agents = [{ id: 'hello-world' }, { id: 'support' }]

describe('managed project context', () => {
  it('uses the selected agent across project tabs', () => {
    expect(
      selectedProjectAgentId(
        '/projects/prj_1/deployments',
        '?agent=support',
        agents,
      ),
    ).toBe('support')
  })

  it('continues to understand existing playground agent URLs', () => {
    expect(
      selectedProjectAgentId('/projects/prj_1/playground/support', '', agents),
    ).toBe('support')
  })

  it('stores agent and environment in one navigation state', () => {
    expect(projectContextSearch('?tab=value', 'support', 'production')).toBe(
      '?tab=value&agent=support&environment=production',
    )
    expect(
      projectContextSearch(
        '?environment=production',
        'hello-world',
        'development',
      ),
    ).toBe('?agent=hello-world')
  })

  it('switches environment without changing the playground agent', () => {
    expect(projectEnvironmentSearch('?agent=support', 'production')).toBe(
      '?agent=support&environment=production',
    )
    expect(
      projectEnvironmentSearch(
        '?agent=support&environment=production',
        'development',
      ),
    ).toBe('?agent=support')
  })
})
