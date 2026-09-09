import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import ProjectsHome from './Home'
import { INSTALL_CLI_COMMAND } from './ProjectOnboarding'

function renderProjects(projects: unknown[]) {
  const queryClient = new QueryClient()
  queryClient.setQueryData(['managed-projects'], projects)

  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ProjectsHome />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('projects home onboarding', () => {
  it('shows CLI onboarding when the account has no projects', () => {
    const markup = renderProjects([])

    expect(markup).toContain(INSTALL_CLI_COMMAND)
    expect(markup).not.toContain('Create project')
    expect(markup).not.toContain('Start from a template')
  })

  it('sends New project to the same CLI onboarding route', () => {
    const now = new Date().toISOString()
    const markup = renderProjects([
      {
        id: 'project_1',
        slug: 'support',
        name: 'Support',
        environments: [{ name: 'development', updatedAt: now }],
        agents: [{ id: 'agent_1', name: 'Support agent' }],
        createdAt: now,
        updatedAt: now,
      },
    ])

    expect(markup).toContain('New project')
    expect(markup).toContain('href="/new"')
    expect(markup).not.toContain('Start from a template')
  })
})
