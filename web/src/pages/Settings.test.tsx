// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@/hooks/useAuth'

const client = vi.hoisted(() => ({
  getOrg: vi.fn(),
  getBilling: vi.fn(),
  getAutumnBilling: vi.fn(),
  getOrgMembers: vi.fn(),
  getInvitations: vi.fn(),
  updateOrg: vi.fn(),
  removeMember: vi.fn(),
  revokeInvitation: vi.fn(),
  sendInvitation: vi.fn(),
}))
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  ...client,
}))
vi.mock('@/managed-agents/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/managed-agents/api')>()),
  getManagedRuntimeProfile: vi.fn().mockResolvedValue({
    displayName: null,
    customized: false,
  }),
}))
vi.mock('@/managed-agents/work/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/managed-agents/work/api')>()),
  getRepository: vi.fn().mockResolvedValue(null),
  getRepositories: vi.fn().mockResolvedValue([]),
}))

const { default: Settings } = await import('./Settings')

const org = {
  id: 'org_1',
  name: 'Digger',
  slug: 'digger',
  plan: 'trial',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  isPersonal: false,
  creditBalanceCents: 0,
}
const members = [
  {
    membershipId: 'mem_1',
    id: 'usr_1',
    email: 'igor@digger.dev',
    name: 'Igor',
    role: 'admin',
  },
  {
    membershipId: 'mem_2',
    id: 'usr_2',
    email: 'alex@digger.dev',
    name: 'Alex Rivera',
    role: 'member',
  },
]
const invitations = [
  {
    id: 'inv_1',
    email: 'sam@acme.dev',
    state: 'pending',
    role: 'member',
    expiresAt: '2026-12-01T00:00:00Z',
    createdAt: '2026-11-01T00:00:00Z',
  },
]

const auth = (manageMembers = true): AuthContextValue => ({
  user: {
    id: 'usr_1',
    email: 'igor@digger.dev',
    orgId: 'org_1',
    capabilities: {
      signOut: true,
      manageMembers,
      switchOrganizations: true,
    },
  },
  loading: false,
  error: null,
  switchOrg: async () => {},
  refreshUser: async () => {},
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  client.getOrg.mockResolvedValue(org)
  client.getBilling.mockResolvedValue({ plan: 'trial' })
  client.getOrgMembers.mockResolvedValue(members)
  client.getInvitations.mockResolvedValue(invitations)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

async function render(manageMembers = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  act(() => {
    root.render(
      <AuthContext.Provider value={auth(manageMembers)}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/settings']}>
            <Settings />
          </MemoryRouter>
        </QueryClientProvider>
      </AuthContext.Provider>,
    )
  })
  for (let i = 0; i < 20; i++) await flush()
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

const titles = () =>
  [...container.querySelectorAll('section h2')].map((h) => h.textContent)
const button = (text: string) =>
  [...document.body.querySelectorAll('button')].find(
    (b) => b.textContent === text,
  )

function type(el: HTMLInputElement, value: string) {
  act(() => {
    Reflect.set(HTMLInputElement.prototype, 'value', value, el)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('settings', () => {
  it('has its sections in order, under the organization name', async () => {
    await render()
    expect(container.querySelector('h1')?.textContent).toBe('Settings')
    expect(container.textContent).toContain('Digger')
    expect(titles()).toEqual([
      'Organization',
      'Knowledge repository',
      'Members',
      'Agent environment',
    ])
    expect(container.querySelector('section#work-repository')).not.toBeNull()
    expect(container.querySelector('a[href="/billing"]')?.textContent).toBe(
      'Manage billing',
    )
  })

  it('offers Save only once the name changes, and Enter saves', async () => {
    client.updateOrg.mockResolvedValue({ ...org, name: 'Digger Inc' })
    await render()
    expect(button('Save')).toBeUndefined()
    const name = container.querySelector<HTMLInputElement>('#org-name')!
    type(name, 'Digger Inc')
    expect(button('Save')).toBeTruthy()
    act(() => {
      name.form!.requestSubmit()
    })
    await flush()
    expect(client.updateOrg).toHaveBeenCalledWith({ name: 'Digger Inc' })
  })

  it('lists members and invitations, with a menu on all but my own row', async () => {
    await render()
    expect(container.textContent).toContain('Alex Rivera')
    expect(container.textContent).toContain('You')
    expect(container.textContent).toContain('sam@acme.dev')
    expect(container.textContent).toContain('Invited')
    expect(
      container.querySelector('[aria-label="Actions for igor@digger.dev"]'),
    ).toBeNull()
    expect(
      container.querySelector('[aria-label="Actions for alex@digger.dev"]'),
    ).not.toBeNull()
    expect(
      container.querySelector(
        '[aria-label="Actions for the invitation to sam@acme.dev"]',
      ),
    ).not.toBeNull()
  })

  it('removes a member through the menu, after a confirmation', async () => {
    client.removeMember.mockResolvedValue(undefined)
    await render()
    const menu = container.querySelector(
      '[aria-label="Actions for alex@digger.dev"]',
    )!
    act(() => {
      menu.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
    })
    await flush()
    const item = [...document.body.querySelectorAll('[role="menuitem"]')].find(
      (el) => el.textContent === 'Remove from organization',
    )!
    act(() => {
      item.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    const dialog = document.body.querySelector('[role="alertdialog"]')!
    expect(dialog.textContent).toContain('Remove alex@digger.dev?')
    expect(client.removeMember).not.toHaveBeenCalled()
    act(() => {
      button('Remove member')!.click()
    })
    await flush()
    expect(client.removeMember).toHaveBeenCalledWith('mem_2')
  })

  it('opens an invite row from the title', async () => {
    client.sendInvitation.mockResolvedValue({})
    await render()
    act(() => {
      button('Invite')!.click()
    })
    const email = container.querySelector<HTMLInputElement>('#invite-email')!
    expect(document.activeElement).toBe(email)
    type(email, 'new@acme.dev')
    act(() => {
      email.form!.requestSubmit()
    })
    await flush()
    expect(client.sendInvitation).toHaveBeenCalledWith('new@acme.dev')
  })

  it('leaves out Members when the account cannot manage them', async () => {
    await render(false)
    expect(titles()).toEqual([
      'Organization',
      'Knowledge repository',
      'Agent environment',
    ])
  })
})
