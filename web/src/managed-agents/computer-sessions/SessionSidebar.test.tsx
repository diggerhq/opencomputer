// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { NotebookText, SquareTerminal } from 'lucide-react'
import { SessionSidebar } from './SessionSidebar'
import {
  DEFAULT_SIDEBAR_PREFS,
  loadSidebarPrefs,
  sidebarKey,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useSidebarPrefs,
} from './sidebar-prefs'
import {
  SIDEBAR_TABS,
  type SidebarTab,
  type SidebarTabProps,
} from './sidebar-tabs'

let container: HTMLDivElement
let root: Root
let mounts = 0

function FakeTerminal({ sessionId }: SidebarTabProps) {
  useEffect(() => {
    mounts++
  }, [])
  return <p>shell in {sessionId}</p>
}

const TERMINAL: SidebarTab = {
  id: 'terminal',
  label: 'Terminal',
  icon: SquareTerminal,
  hint: 'A shell',
  component: FakeTerminal,
}
const NOTES: SidebarTab = {
  id: 'notes',
  label: 'Notes',
  icon: NotebookText,
  hint: 'Notes',
  component: () => <p>notes</p>,
}

// The session page in miniature: a toggle and the sidebar, sharing saved prefs.
function Page({
  user = 'usr_a',
  tabs = [TERMINAL],
}: {
  user?: string
  tabs?: SidebarTab[]
}) {
  const [prefs, set] = useSidebarPrefs(user)
  return (
    <>
      <button type="button" onClick={() => set({ open: !prefs.open })}>
        toggle
      </button>
      <SessionSidebar
        sessionId="cs_1"
        prefs={prefs}
        onChange={set}
        tabs={tabs}
      />
    </>
  )
}

beforeEach(() => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  localStorage.clear()
  mounts = 0
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = (user?: string, tabs?: SidebarTab[]) => {
  act(() => root.render(<Page user={user} tabs={tabs} />))
}
const remount = (user?: string) => {
  act(() => root.unmount())
  root = createRoot(container)
  render(user)
}
const aside = () => container.querySelector('aside')
const button = (label: string) =>
  [...container.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === label || b.textContent === label,
  )!
const click = (el: Element) => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}
const saved = (user = 'usr_a') =>
  JSON.parse(localStorage.getItem(sidebarKey(user)) ?? 'null') as unknown

it('starts closed and opens on the Terminal, with no tab strip for one tab', () => {
  render()
  expect(aside()).toBeNull()
  click(button('toggle'))
  expect(aside()!.hidden).toBe(false)
  expect(container.textContent).toContain('shell in cs_1')
  expect(container.querySelector('[role=tablist]')).toBeNull()
  expect(container.querySelector('[role=tabpanel]')).toBeNull()
  expect(aside()!.textContent).toContain('Terminal')
})

it('hides on close without ending the shell, and remembers it per user', () => {
  render()
  click(button('toggle'))
  click(button('Close the sidebar'))
  expect(aside()!.hidden).toBe(true)
  click(button('toggle'))
  expect(mounts).toBe(1)
  expect(saved()).toMatchObject({ open: true })

  remount()
  expect(aside()!.hidden).toBe(false)
  remount('usr_b')
  expect(aside()).toBeNull()
})

it('shows a tab strip for several tabs and keeps the shell when switching', () => {
  render(undefined, [TERMINAL, NOTES])
  click(button('toggle'))
  const tabs = [...container.querySelectorAll('[role=tab]')]
  expect(tabs.map((t) => t.textContent)).toEqual(['Terminal', 'Notes'])
  click(tabs[1])
  expect(saved()).toMatchObject({ tab: 'notes' })
  expect(container.textContent).toContain('notes')
  click(tabs[0])
  expect(mounts).toBe(1)
  // The real registry: only the terminal for now.
  expect(SIDEBAR_TABS.map((t) => t.id)).toEqual(['terminal'])
})

it('resizes from its left edge and keeps the width within bounds', () => {
  render()
  click(button('toggle'))
  const edge = button('Resize the sidebar')
  const pointer = (type: string, clientX: number) =>
    act(() => {
      const e = new MouseEvent(type, { bubbles: true, clientX })
      Object.assign(e, { pointerId: 1 })
      edge.dispatchEvent(e)
    })
  pointer('pointerdown', 1000)
  pointer('pointermove', 900)
  expect(aside()!.style.width).toBe(`${DEFAULT_SIDEBAR_PREFS.width + 100}px`)
  pointer('pointerup', 900)
  expect(saved()).toMatchObject({ width: DEFAULT_SIDEBAR_PREFS.width + 100 })

  pointer('pointerdown', 1000)
  pointer('pointermove', -5000)
  pointer('pointerup', -5000)
  expect(saved()).toMatchObject({ width: SIDEBAR_MAX_WIDTH })

  act(() => {
    edge.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    )
  })
  expect(saved()).toMatchObject({ width: SIDEBAR_MAX_WIDTH - 32 })

  remount()
  expect(aside()!.style.width).toBe(`${SIDEBAR_MAX_WIDTH - 32}px`)
})

it('survives a broken or out-of-range saved entry', () => {
  localStorage.setItem(sidebarKey('usr_a'), '{nope')
  expect(loadSidebarPrefs('usr_a')).toEqual(DEFAULT_SIDEBAR_PREFS)
  localStorage.setItem(
    sidebarKey('usr_a'),
    JSON.stringify({ open: true, width: 10, tab: 'desktop' }),
  )
  expect(loadSidebarPrefs('usr_a')).toEqual({
    open: true,
    width: SIDEBAR_MIN_WIDTH,
    tab: 'desktop',
  })
  // A remembered tab that no longer exists falls back to Terminal.
  render()
  expect(container.textContent).toContain('shell in cs_1')
})
