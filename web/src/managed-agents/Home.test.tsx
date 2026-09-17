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

  it('offers each project its own delete control, named after the project', () => {
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
      {
        id: 'project_2',
        slug: 'billing',
        name: 'Billing',
        environments: [{ name: 'development', updatedAt: now }],
        agents: [],
        createdAt: now,
        updatedAt: now,
      },
    ])

    // Named per project: the card is a link to the project, so the control
    // that destroys it has to be distinguishable from the one next to it.
    expect(markup).toContain('aria-label="Delete Support"')
    expect(markup).toContain('aria-label="Delete Billing"')
    // The confirm dialog is what actually deletes, so nothing is armed on render.
    expect(markup).not.toContain('Delete project')
  })
})
