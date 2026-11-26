// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AccessInput } from '../computer-sessions-api'

vi.mock('./members', () => ({
  useOrgPeople: () => [
    {
      id: 'usr_o',
      ids: ['usr_o'],
      email: 'o@x.dev',
      name: 'Owen',
      admin: false,
    },
    {
      id: 'usr_a',
      ids: ['usr_a', 'usr_xa'],
      email: 'a@x.dev',
      name: 'Ana',
      admin: false,
    },
  ],
}))
const { AccessPicker } = await import('./AccessPicker')

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
})

function render(value: AccessInput, onSave: (next: AccessInput) => unknown) {
  act(() =>
    root.render(
      <AccessPicker
        value={value}
        onSave={onSave}
        isOwner
        ownerIds={['usr_o']}
      />,
    ),
  )
}
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}
function click(el: Element | null | undefined) {
  if (!el) throw new Error('missing element')
  act(() => (el as HTMLElement).click())
}
const byText = (selector: string, text: string) =>
  [...document.querySelectorAll(selector)].find((el) =>
    el.textContent?.includes(text),
  )
const open = () =>
  click(document.querySelector('[aria-label="Who can access this session"]'))

it('confirms with the secrets warning before sharing with the org', async () => {
  const onSave = vi.fn()
  render({ mode: 'owner' }, onSave)
  expect(container.textContent).toContain('Only me')
  open()
  click(byText('[role="radio"]', 'Whole organization'))
  click(byText('button', 'Save'))
  expect(onSave).not.toHaveBeenCalled()
  const dialog = document.querySelector('[role="alertdialog"]')
  expect(dialog?.textContent).toContain('Share with the whole organization?')
  expect(dialog?.textContent).toContain('your secrets')
  expect(dialog?.textContent).toContain('model subscription')
  click(byText('[role="alertdialog"] button', 'Share'))
  await flush()
  expect(onSave).toHaveBeenCalledWith({ mode: 'org' })
})

it('lists members but not the owner, and sends the chosen ids', async () => {
  const onSave = vi.fn()
  render({ mode: 'owner' }, onSave)
  open()
  click(byText('[role="radio"]', 'Specific people'))
  const labels = [...document.querySelectorAll('label')].map(
    (l) => l.textContent,
  )
  expect(labels.some((t) => t?.includes('Ana'))).toBe(true)
  expect(labels.some((t) => t?.includes('Owen'))).toBe(false)
  click(byText('label', 'Ana')?.querySelector('button'))
  click(byText('button', 'Save'))
  click(byText('[role="alertdialog"] button', 'Share'))
  await flush()
  expect(onSave).toHaveBeenCalledWith({ mode: 'people', people: ['usr_a'] })
})

it('narrows without asking', async () => {
  const onSave = vi.fn()
  render({ mode: 'org' }, onSave)
  open()
  click(byText('[role="radio"]', 'Only me'))
  click(byText('button', 'Save'))
  await flush()
  expect(document.querySelector('[role="alertdialog"]')).toBeNull()
  expect(onSave).toHaveBeenCalledWith({ mode: 'owner' })
})

it('shows a listed person under any of their ids', () => {
  render({ mode: 'people', people: ['usr_xa'] }, vi.fn())
  expect(container.textContent).toContain('Shared with Ana')
})
