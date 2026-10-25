// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const projectsApi = vi.hoisted(() => ({
  getManagedProjects: vi.fn(),
  archiveManagedProject: vi.fn(),
  restoreManagedProject: vi.fn(),
}))
vi.mock('./api', () => projectsApi)

const { default: ProjectsHome } = await import('./Home')

const now = new Date().toISOString()
const project = (id: string, name: string) => ({
  id,
  slug: id,
  name,
  environments: [{ name: 'development', updatedAt: now }],
  agents: [],
  createdAt: now,
  updatedAt: now,
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  projectsApi.getManagedProjects.mockImplementation(
    (options: { archived?: boolean } = {}) =>
      Promise.resolve(
        options.archived
          ? []
          : [
              project('p1', 'Support'),
              project('p2', 'Billing'),
              project('p3', 'Growth'),
            ],
      ),
  )
  projectsApi.archiveManagedProject.mockResolvedValue(project('p1', 'x'))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)))
function button(text: string) {
  const match = [...document.querySelectorAll('button')].find(
    (candidate) =>
      candidate.textContent?.trim() === text ||
      candidate.getAttribute('aria-label') === text,
  )
  if (!match) throw new Error(`No button ${text}`)
  return match
}
const click = (text: string) => act(() => button(text).click())

describe('archiving many projects at once', () => {
  it('archives every selected project after one confirmation', async () => {
    act(() =>
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <MemoryRouter>
            <ProjectsHome list />
          </MemoryRouter>
        </QueryClientProvider>,
      ),
    )
    await settle()

    click('Select')
    click('Select Support')
    click('Select Growth')
    expect(button('Select Support').getAttribute('aria-pressed')).toBe('true')
    expect(document.body.textContent).toContain('2 selected')

    click('Archive 2')
    await settle()
    expect(document.body.textContent).toContain('Archive 2 projects?')

    click('Archive 2 projects')
    await settle()

    expect(
      projectsApi.archiveManagedProject.mock.calls.map(([id]) => id as string),
    ).toEqual(['p1', 'p3'])
  })
})
