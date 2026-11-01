// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'

const secretsApi = vi.hoisted(() => ({
  getOrgSecrets: vi.fn(),
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
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
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
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
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
    secretsApi.getOrgSecrets.mockResolvedValue([row])
    await render()
    expect(container.textContent).toContain('EXECUTOR_API_KEY')
    expect(container.textContent).not.toContain('Ayush')
    expect(container.textContent).not.toContain('Overridden')
  })

  it('offers to add the first secret when there are none', async () => {
    secretsApi.getOrgSecrets.mockResolvedValue([])
    await render()
    expect(container.textContent).toContain('No secrets yet')
    expect(button('Add secret')).toBeTruthy()
  })

  it('adds a secret and shows a refused name next to the field', async () => {
    secretsApi.getOrgSecrets.mockResolvedValue([])
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
    secretsApi.getOrgSecrets.mockResolvedValue([row])
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
    secretsApi.getOrgSecrets.mockResolvedValue([row])
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
})
