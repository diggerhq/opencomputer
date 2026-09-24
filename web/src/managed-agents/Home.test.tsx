import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import ProjectsHome from './Home'
import { INSTALL_CLI_COMMAND } from './ProjectOnboarding'

function renderProjects(projects: unknown[], archived: unknown[] = []) {
  const queryClient = new QueryClient()
  queryClient.setQueryData(['managed-projects'], projects)
  queryClient.setQueryData(['managed-projects', 'archived'], archived)

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

  it('offers each project its own archive control, named after the project', () => {
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

    expect(markup).toContain('aria-label="Archive Support"')
    expect(markup).toContain('aria-label="Archive Billing"')
    expect(markup).not.toContain('Archive project')
  })

  it('hides archived projects behind a collapsed restore section', () => {
    const now = new Date().toISOString()
    const markup = renderProjects(
      [],
      [
        {
          id: 'project_1',
          slug: 'support',
          name: 'Support',
          environments: [],
          agents: [{ id: 'agent_1', name: 'Support agent' }],
          archivedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ],
    )

    expect(markup).toContain('<details class="group space-y-3">')
    expect(markup).not.toContain('<details open=""')
    expect(markup).toContain('Archived (1)')
    expect(markup).toContain('Support')
    expect(markup).toContain('Restore')
  })
})
