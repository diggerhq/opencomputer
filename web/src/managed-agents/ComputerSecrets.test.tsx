// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'

const secretsApi = vi.hoisted(() => ({
  getOrgSecrets: vi.fn(),
  getOrgSecretEvents: vi.fn(),
  putOrgSecret: vi.fn(),
  deleteOrgSecret: vi.fn(),
}))
vi.mock('./computer-secrets-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./computer-secrets-api')>()),
  ...secretsApi,
}))

const { ComputerSecrets } = await import('./ComputerSecrets')

const row = {
  name: 'EXECUTOR_API_KEY',
  layer: 'organization' as const,
  kind: 'secret' as const,
  file: false,
  createdAt: '2026-10-30T10:00:00.000Z',
  createdBy: { member: 'usr_1', name: 'Ayush' },
  updatedAt: '2026-10-30T10:00:00.000Z',
  updatedBy: { member: 'usr_1', name: 'Ayush' },
  lastUsedAt: null,
  overriddenIn: { threads: 1, people: 0 },
  canChange: true,
}
/** Someone else's: the viewer is neither its creator nor an admin. */
const others = { ...row, name: 'SHARED_TOKEN', canChange: false }

const list = (secrets: (typeof row)[]) => ({ secrets })

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  secretsApi.getOrgSecretEvents.mockResolvedValue([])
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

async function render() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <ComputerSecrets />
      </QueryClientProvider>,
    )
  })
  // Until the list's query settles, however slow the run.
  for (let i = 0; i < 50 && container.querySelector('[role="status"]'); i++) {
    await flush()
  }
}

// The last match: a dialog's button comes after the page's of the same name.
function button(label: string) {
  const found = [...document.querySelectorAll('button')]
    .reverse()
    .find(
      (el) =>
        el.textContent?.trim() === label ||
        el.getAttribute('aria-label') === label,
    )
  if (!found) throw new Error(`no button ${label}`)
  return found
}

function type(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('computer secrets page', () => {
  it('lists organization secrets by name only', async () => {
    secretsApi.getOrgSecrets.mockResolvedValue(list([row]))
    await render()
    expect(container.textContent).toContain('EXECUTOR_API_KEY')
    expect(container.textContent).not.toContain('Ayush')
    expect(container.textContent).toContain('These are organization-wide.')
  })

  it('offers to add the first secret when there are none', async () => {
    secretsApi.getOrgSecrets.mockResolvedValue(list([]))
    await render()
    expect(container.textContent).toContain('No secrets yet')
    expect(button('Add secret')).toBeTruthy()
  })

  it('adds a secret and shows a refused name next to the field', async () => {
    secretsApi.getOrgSecrets.mockResolvedValue(list([]))
    secretsApi.putOrgSecret.mockRejectedValueOnce(
      new ApiError(
        "Can't use this name: PATH is reserved.",
        400,
        'invalid_name',
      ),
    )
    await render()
    act(() => button('Add secret').click())
    const name = document.getElementById('secret-name') as HTMLInputElement
    const value = document.getElementById('secret-value') as HTMLInputElement
    act(() => {
      type(name, 'path')
      type(value, 'x')
    })
    expect(value.type).toBe('password')
    act(() => button('Add secret').click())
    await flush()
    expect(secretsApi.putOrgSecret.mock.calls[0]?.[0]).toEqual({
      name: 'PATH',
      value: 'x',
      file: false,
      variable: false,
    })
    expect(document.getElementById('secret-name-error')?.textContent).toBe(
      "Can't use this name: PATH is reserved.",
    )
  })

  it('replaces without showing or prefilling the old value', async () => {
    secretsApi.getOrgSecrets.mockResolvedValue(list([row]))
    secretsApi.putOrgSecret.mockResolvedValue(row)
    await render()
    act(() => button('Replace').click())
    expect(document.getElementById('secret-name')).toBeNull()
    const value = document.getElementById('secret-value') as HTMLInputElement
    expect(value.value).toBe('')
    act(() => type(value, 'new'))
    act(() => button('Replace').click())
    await flush()
    expect(secretsApi.putOrgSecret.mock.calls[0]?.[0]).toEqual({
      name: 'EXECUTOR_API_KEY',
      value: 'new',
      file: false,
      variable: false,
    })
  })

  it('deletes after a confirm that names the organization layer', async () => {
    secretsApi.getOrgSecrets.mockResolvedValue(list([row]))
    secretsApi.deleteOrgSecret.mockResolvedValue(undefined)
    await render()
    act(() => button('Delete').click())
    expect(document.body.textContent).toContain(
      'Delete EXECUTOR_API_KEY for the organization?',
    )
    const confirm = [
      ...document.querySelectorAll('[role="alertdialog"] button'),
    ].find((el) => el.textContent?.trim() === 'Delete') as HTMLButtonElement
    act(() => confirm.click())
    await flush()
    expect(secretsApi.deleteOrgSecret.mock.calls[0]?.[0]).toBe(
      'EXECUTOR_API_KEY',
    )
  })

  it('offers Replace and Delete only on the rows the viewer may change', async () => {
    secretsApi.getOrgSecrets.mockResolvedValue(list([row, others]))
    await render()
    expect(container.textContent).toContain('SHARED_TOKEN')
    expect(container.textContent).toContain(
      'only whoever added it or an admin can replace or delete it',
    )
    const rows = [...container.querySelectorAll('tbody tr')]
    const labels = (el: Element) =>
      [...el.querySelectorAll('button')].map((b) => b.textContent?.trim())
    expect(labels(rows[0])).toEqual(['Replace', 'Delete'])
    expect(labels(rows[1])).toEqual([])
    expect(button('Add secret')).toBeTruthy()
  })

  it('lets a member who may change none still add one', async () => {
    secretsApi.getOrgSecrets.mockResolvedValue(list([others]))
    await render()
    const labels = [...document.querySelectorAll('button')].map((el) =>
      el.textContent?.trim(),
    )
    expect(labels).toContain('Add secret')
    expect(labels).not.toContain('Replace')
    expect(labels).not.toContain('Delete')
  })

  it('lists recent changes to organization secrets, without values', async () => {
    secretsApi.getOrgSecrets.mockResolvedValue(list([others]))
    secretsApi.getOrgSecretEvents.mockResolvedValue([
      {
        at: '2026-11-26T10:00:00.000Z',
        name: 'OLD_TOKEN',
        action: 'delete',
        kind: 'secret',
        actor: { member: 'usr_1', name: 'Ayush' },
        via: 'dashboard',
      },
      {
        at: '2026-11-25T10:00:00.000Z',
        name: 'EXECUTOR_API_KEY',
        action: 'replace',
        kind: 'secret',
        actor: { slackUserId: 'U07ABCDE' },
        via: 'slack',
      },
    ])
    await render()
    for (
      let i = 0;
      i < 20 && !container.textContent?.includes('Recent changes');
      i++
    ) {
      await flush()
    }
    expect(container.textContent).toContain('Recent changes')
    expect(container.textContent).toContain(
      'OLD_TOKEN deleted by Ayush via dashboard',
    )
    expect(container.textContent).toContain(
      'EXECUTOR_API_KEY replaced by someone in Slack via slack',
    )
  })
})
