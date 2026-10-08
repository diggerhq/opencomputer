import { describe, expect, it } from 'vitest'
import {
  projectContextSearch,
  projectEnvironmentMode,
  projectEnvironmentSearch,
  projectEnvironments,
  requestedProjectAgentId,
  resolveProjectEnvironment,
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

  it('only reports an agent the URL explicitly names', () => {
    expect(requestedProjectAgentId('?agent=support', agents)).toBe('support')
    expect(requestedProjectAgentId('', agents)).toBeUndefined()
    expect(requestedProjectAgentId('?agent=gone', agents)).toBeUndefined()
  })

  it('drops the agent from the URL when none is chosen', () => {
    expect(
      projectContextSearch('?agent=support', undefined, 'development'),
    ).toBe('')
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

  it('reads a project without a stored mode as legacy', () => {
    expect(projectEnvironmentMode(undefined)).toBe('legacy')
    expect(projectEnvironmentMode({})).toBe('legacy')
    expect(projectEnvironmentMode({ environmentMode: 'single' })).toBe('single')
    expect(projectEnvironments('legacy')).toEqual(['development', 'production'])
    expect(projectEnvironments('single')).toEqual(['default'])
  })

  it('resolves legacy environments from the query', () => {
    expect(resolveProjectEnvironment('legacy', '')).toEqual({
      ok: true,
      environment: 'development',
    })
    expect(
      resolveProjectEnvironment('legacy', '?environment=production'),
    ).toEqual({ ok: true, environment: 'production' })
  })

  it('redirects an older development bookmark on a single-mode project', () => {
    expect(resolveProjectEnvironment('single', '?agent=support')).toEqual({
      ok: true,
      environment: 'default',
    })
    expect(
      resolveProjectEnvironment(
        'single',
        '?agent=support&environment=development',
      ),
    ).toEqual({
      ok: true,
      environment: 'default',
      canonicalSearch: '?agent=support',
    })
  })

  it('reports production as incompatible with a single-mode project', () => {
    expect(
      resolveProjectEnvironment('single', '?environment=production'),
    ).toEqual({ ok: false, requested: 'production' })
  })

  it('keeps single-mode URLs environmentless', () => {
    expect(
      projectContextSearch('?environment=production', 'a', 'default'),
    ).toBe('?agent=a')
    expect(
      projectEnvironmentSearch('?environment=development', 'default'),
    ).toBe('')
  })
})
