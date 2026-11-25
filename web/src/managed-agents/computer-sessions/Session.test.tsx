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
const members = vi.hoisted(() => ({ admin: true }))
vi.mock('./members', () => ({
  useMemberEmails: () => undefined,
  useMyMemberId: () => 'usr_admin',
  useOrgPeople: () => [
    {
      id: 'usr_admin',
      ids: ['usr_admin'],
      email: 'admin@x.dev',
      name: 'Ada',
      admin: members.admin,
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
  members.admin = true
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
const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error('missing element')
  await act(async () => {
    ;(el as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
const byText = (selector: string, text: string) =>
  [...document.querySelectorAll(selector)].find((el) =>
    el.textContent?.includes(text),
  )

it('lets an admin change access by id without seeing it, then add themselves', async () => {
  api.getSession.mockRejectedValue(notFound())
  api.updateSessionAccess.mockResolvedValueOnce({
    session: null,
    access: { mode: 'people', people: ['usr_a'] },
    canManageAccess: true,
  })
  await render()
  expect(container.textContent).toContain(
    'This session does not exist or is not shared with you.',
  )
  expect(container.textContent).toContain('As an admin you can change')
  expect(container.querySelector('textarea')).toBeNull()
  // The current access is hidden: the control says so, and there's no "Add me" yet.
  expect(container.textContent).toContain('Change who has access')
  expect(container.textContent).not.toContain('Add me')

  await click(
    document.querySelector('[aria-label="Who can access this session"]'),
  )
  await click(byText('[role="radio"]', 'Only the owner'))
  await click(byText('[data-slot="popover-content"] button', 'Save'))
  expect(api.updateSessionAccess).toHaveBeenCalledWith('cs_1', {
    mode: 'owner',
  })

  // The answer tells what access is now; adding themselves lets them in.
  api.updateSessionAccess.mockResolvedValueOnce({
    session: {
      ...session,
      access: { mode: 'people', people: ['usr_a', 'usr_admin'] },
    },
  })
  api.getSession.mockResolvedValue({
    ...session,
    access: { mode: 'people', people: ['usr_a', 'usr_admin'] },
    canManageAccess: true,
  })
  // A long-poll that waits.
  api.getEvents.mockReturnValue(new Promise(() => {}))
  await click(byText('button', 'Add me'))
  expect(api.updateSessionAccess).toHaveBeenLastCalledWith('cs_1', {
    mode: 'people',
    people: ['usr_a', 'usr_admin'],
  })
  expect(container.textContent).not.toContain('does not exist')
})

it('shows anyone else only that it is not there', async () => {
  members.admin = false
  api.getSession.mockRejectedValue(notFound())
  await render()
  expect(container.textContent).toContain(
    'This session does not exist or is not shared with you.',
  )
  expect(container.textContent).not.toContain('Change who has access')
})
