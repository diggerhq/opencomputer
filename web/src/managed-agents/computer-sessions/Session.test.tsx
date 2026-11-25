// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'

const api = vi.hoisted(() => ({
  getSession: vi.fn(),
  getEvents: vi.fn(),
  updateSession: vi.fn(),
}))
vi.mock('../computer-sessions-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../computer-sessions-api')>()),
  getSession: api.getSession,
  getEvents: api.getEvents,
  updateSession: api.updateSession,
}))
vi.mock('./members', () => ({
  useMemberEmails: () => undefined,
  useMyMemberId: () => 'usr_admin',
  useOrgPeople: () => [],
}))
const { default: ComputerSession } = await import('./Session')

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  api.getEvents.mockRejectedValue(new ApiError('Forbidden', 403))
  // Nothing here may reach a network.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('offline'))),
  )
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.resetAllMocks()
  vi.unstubAllGlobals()
})

const session = {
  id: 'cs_1',
  title: 'Fix the build',
  status: 'idle',
  archived: false,
  owner: { id: 'usr_o', name: 'Owen' },
  origin: { type: 'web' },
  settings: { model: null, effort: null, mode: null },
  activeTurnId: null,
  asks: [],
  lastText: 'secret transcript text',
  lastSeq: 3,
  createdAt: '2026-11-25T00:00:00Z',
  lastActiveAt: null,
}

async function render() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/computer/sessions/cs_1']}>
          <Routes>
            <Route
              path="/computer/sessions/:id"
              element={<ComputerSession />}
            />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

it('lets an admin change access and add themselves, without showing content', async () => {
  api.getSession.mockRejectedValue(
    new ApiError('Forbidden', 403, 'session_forbidden', {
      session: {
        ...session,
        access: { mode: 'people', people: ['usr_a'] },
        canManageAccess: true,
      },
    }),
  )
  api.updateSession.mockResolvedValue({
    ...session,
    access: { mode: 'people', people: ['usr_a', 'usr_admin'] },
  })
  await render()
  expect(container.textContent).toContain(
    "You don't have access to this session.",
  )
  expect(container.textContent).toContain('You can change who has access')
  expect(container.textContent).not.toContain('secret transcript text')
  expect(container.querySelector('textarea')).toBeNull()
  const addMe = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Add me',
  )!
  await act(async () => {
    addMe.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(api.updateSession).toHaveBeenCalledWith('cs_1', {
    access: { mode: 'people', people: ['usr_a', 'usr_admin'] },
  })
})

it('tells anyone else to ask the owner', async () => {
  api.getSession.mockRejectedValue(
    new ApiError('Forbidden', 403, 'session_forbidden', {
      session: {
        ...session,
        access: { mode: 'owner', people: [] },
        canManageAccess: false,
      },
    }),
  )
  await render()
  expect(container.textContent).toContain('Ask Owen to share it with you.')
  expect(container.textContent).not.toContain('Add me')
})
