// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Ask } from '../computer-sessions-api'
const api = vi.hoisted(() => ({ putSessionSecret: vi.fn(), sendTurn: vi.fn() }))
vi.mock('../computer-secrets-api', () => ({
  putSessionSecret: api.putSessionSecret,
}))
vi.mock('../computer-sessions-api', () => ({
  sendTurn: api.sendTurn,
  sessionKeys: { all: ['sessions'] },
}))
const { SecretRequest } = await import('./SecretRequest')
let container: HTMLDivElement
let root: Root
const ask = {
  id: 'ak_test',
  sessionId: 'cs_test',
  kind: 'secret',
  secret: { name: 'TOKEN', purpose: 'Access the service', file: false },
} as Ask
beforeEach(() => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  api.putSessionSecret.mockResolvedValue(undefined)
  api.sendTurn.mockResolvedValue(undefined)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.resetAllMocks()
})
function render(request = ask) {
  act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <SecretRequest ask={request} />
      </QueryClientProvider>,
    ),
  )
}
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
function enter(value: string) {
  const input = container.querySelector('input')!
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function submit() {
  act(() => {
    container
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
  await flush()
}
it('masks the value, stores it privately, clears it and resumes using metadata only', async () => {
  render()
  expect(container.querySelector('input')!.type).toBe('password')
  enter('private-test-value')
  await submit()
  expect(api.putSessionSecret).toHaveBeenCalledWith(
    'cs_test',
    'TOKEN',
    'private-test-value',
    false,
  )
  expect(api.sendTurn).toHaveBeenCalledWith(
    'cs_test',
    expect.stringContaining('$TOKEN is set'),
    'queue',
  )
  expect(JSON.stringify(api.sendTurn.mock.calls)).not.toContain(
    'private-test-value',
  )
  expect(container.querySelector('input')!.value).toBe('')
})
it('does not resume on a failed save or render the raw error', async () => {
  api.putSessionSecret.mockRejectedValue(new Error('private-test-value'))
  render()
  enter('private-test-value')
  await submit()
  expect(api.sendTurn).not.toHaveBeenCalled()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain(
    'Could not save',
  )
  expect(container.textContent).not.toContain('private-test-value')
})
it('retries continuation without submitting the value again', async () => {
  api.sendTurn.mockRejectedValueOnce(new Error('offline'))
  render()
  enter('private-test-value')
  await submit()
  expect(container.textContent).toContain('Secret saved. Retry')
  await submit()
  expect(api.putSessionSecret).toHaveBeenCalledTimes(1)
  expect(api.sendTurn).toHaveBeenCalledTimes(2)
})
it('accepts a credentials file and preserves its contents', async () => {
  render({ ...ask, secret: { ...ask.secret!, file: true } })
  const input = container.querySelector('input')!
  expect(input.type).toBe('file')
  Object.defineProperty(input, 'files', {
    value: [{ size: 10, text: () => Promise.resolve('{"key":"test"}\n') }],
  })
  act(() => {
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await flush()
  await submit()
  expect(api.putSessionSecret).toHaveBeenCalledWith(
    'cs_test',
    'TOKEN',
    '{"key":"test"}\n',
    true,
  )
})
