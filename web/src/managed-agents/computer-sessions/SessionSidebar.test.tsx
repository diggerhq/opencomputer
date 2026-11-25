// @vitest-environment happy-dom
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Globe, SquareTerminal } from 'lucide-react'
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

const TABS: SidebarTab[] = [
  {
    id: 'terminal',
    label: 'Terminal',
    icon: SquareTerminal,
    available: true,
    hint: 'A shell',
    component: FakeTerminal,
  },
  {
    id: 'browser',
    label: 'Browser',
    icon: Globe,
    available: false,
    hint: 'Coming soon',
  },
]

// The session page in miniature: a toggle and the sidebar, sharing saved prefs.
function Page({ user = 'usr_a' }: { user?: string }) {
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
        tabs={TABS}
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

const render = (user?: string) => {
  act(() => root.render(<Page user={user} />))
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

it('starts closed and opens on the Terminal tab', () => {
  render()
  expect(aside()).toBeNull()
  click(button('toggle'))
  expect(aside()!.hidden).toBe(false)
  expect(container.textContent).toContain('shell in cs_1')
  expect(
    container.querySelector('[role=tab][aria-selected=true]')!.textContent,
  ).toBe('Terminal')
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

it('shows placeholder tabs it cannot switch to', () => {
  render()
  click(button('toggle'))
  const browser = [...container.querySelectorAll('[role=tab]')].find((t) =>
    t.textContent?.startsWith('Browser'),
  ) as HTMLButtonElement
  expect(browser.disabled).toBe(true)
  expect(browser.textContent).toContain('Soon')
  click(browser)
  expect(saved()).toMatchObject({ tab: 'terminal' })
  // The real registry: Terminal works, Browser and Desktop are to come.
  expect(SIDEBAR_TABS.map((t) => [t.id, t.available])).toEqual([
    ['terminal', true],
    ['browser', false],
    ['desktop', false],
  ])
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
  // A remembered tab that is not available yet falls back to Terminal.
  render()
  expect(
    container.querySelector('[role=tab][aria-selected=true]')!.textContent,
  ).toBe('Terminal')
})
