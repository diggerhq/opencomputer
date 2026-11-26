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
  updateSessionAccess: vi.fn(),
}))
vi.mock('../computer-sessions-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../computer-sessions-api')>()),
  getSession: api.getSession,
  getEvents: api.getEvents,
  updateSession: api.updateSession,
  updateSessionAccess: api.updateSessionAccess,
}))
vi.mock('./members', () => ({
  useMemberEmails: () => undefined,
  useMyMemberId: () => 'usr_admin',
  useOrgPeople: () => [
    {
      id: 'usr_admin',
      ids: ['usr_admin'],
      email: 'admin@x.dev',
      name: 'Ada',
      admin: true,
    },
  ],
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
  api.getEvents.mockRejectedValue(new ApiError('Not found', 404))
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

const notFound = () =>
  new ApiError('No such session.', 404, 'session_not_found')
// Lets the session query settle.
async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
}
const byText = (selector: string, text: string) =>
  [...document.querySelectorAll(selector)].find((el) =>
    el.textContent?.includes(text),
  )

it('gives an admin no way into a session not shared with them (owner first)', async () => {
  // Even when the server still says the admin may manage it.
  api.getSession.mockRejectedValue(
    new ApiError('No such session.', 404, 'session_not_found', {
      access: { mode: 'people', people: ['usr_a'] },
      canManageAccess: true,
    }),
  )
  await render()
  expect(container.textContent).toContain(
    'This session does not exist or is not shared with you.',
  )
  expect(container.textContent).toContain('ask its owner to share it')
  expect(container.textContent).not.toContain('As an admin')
  expect(container.textContent).not.toContain('Shared with')
  expect(byText('button', 'Add me')).toBeUndefined()
  expect(
    container.querySelector('[aria-label="Who can access this session"]'),
  ).toBeNull()
  expect(container.textContent).not.toContain('secret transcript text')
  expect(api.updateSessionAccess).not.toHaveBeenCalled()
})

it('shows anyone else only that it is not there', async () => {
  api.getSession.mockRejectedValue(notFound())
  await render()
  expect(container.textContent).toContain(
    'This session does not exist or is not shared with you.',
  )
  expect(container.textContent).not.toContain('Add me')
})

it('gives someone it is shared with no access controls and no archive, even if the server allows them', async () => {
  api.getSession.mockResolvedValue({
    ...session,
    access: { mode: 'people', people: ['usr_admin'] },
    canManageAccess: true,
  })
  api.getEvents.mockReturnValue(new Promise(() => {}))
  await render()
  await settle()
  expect(container.textContent).toContain('Shared with Ada')
  expect(
    container.querySelector('[aria-label="Who can access this session"]'),
  ).toBeNull()
  expect(container.querySelector('[aria-label="Archive"]')).toBeNull()
})

it('gives the owner the access picker and archive', async () => {
  api.getSession.mockResolvedValue({
    ...session,
    owner: { id: 'usr_admin', name: 'Ada' },
    access: { mode: 'owner', people: [] },
    canManageAccess: true,
  })
  api.getEvents.mockReturnValue(new Promise(() => {}))
  await render()
  await settle()
  expect(
    container.querySelector('[aria-label="Who can access this session"]'),
  ).not.toBeNull()
  expect(container.querySelector('[aria-label="Archive"]')).not.toBeNull()
})
