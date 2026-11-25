// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TerminalCallbacks } from './terminal-wire'

const h = vi.hoisted(() => ({
  opens: [] as { cb: TerminalCallbacks; close: () => void }[],
  fits: 0,
  resumeSession: vi.fn(),
  observers: [] as (() => void)[],
}))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    loadAddon() {}
    open() {}
    focus() {}
    write() {}
    dispose() {}
    onData() {
      return { dispose() {} }
    }
    onResize() {
      return { dispose() {} }
    }
  },
}))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {
      h.fits++
    }
  },
}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('../computer-sessions-api', () => ({
  mintTerminalTicket: vi.fn(),
  resumeSession: h.resumeSession,
}))
vi.mock('./terminal-wire', () => ({
  openTerminal: (_o: unknown, cb: TerminalCallbacks) => {
    const conn = { cb, close: vi.fn(), send: vi.fn(), resize: vi.fn() }
    h.opens.push(conn)
    cb.onState({ kind: 'connecting' })
    return conn
  },
}))
const { SessionTerminal } = await import('./SessionTerminal')

let container: HTMLDivElement
let root: Root
let size = 0

beforeEach(async () => {
  ;(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  h.opens.length = 0
  h.observers.length = 0
  h.fits = 0
  size = 0
  h.resumeSession.mockResolvedValue(undefined)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private cb: () => void) {}
      observe() {
        h.observers.push(this.cb)
      }
      disconnect() {}
    },
  )
  for (const p of ['clientWidth', 'clientHeight'])
    Object.defineProperty(HTMLElement.prototype, p, {
      configurable: true,
      get: () => size,
    })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(<SessionTerminal sessionId="cs_1" />))
  // The terminal opens once the web font has loaded.
  await act(async () => {
    await Promise.resolve()
  })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const state = (s: Parameters<TerminalCallbacks['onState']>[0]) =>
  act(() => last().cb.onState(s))
const last = () => h.opens[h.opens.length - 1]
const button = (text: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === text)
const click = async (text: string) =>
  act(async () => {
    button(text)!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })

it('fits the shell only once its box has a size, and on every resize', () => {
  expect(h.fits).toBe(0)
  size = 400
  h.observers.forEach((o) => o())
  expect(h.fits).toBe(1)
})

it('offers Wake for a stopped session, then dials again', async () => {
  vi.useFakeTimers()
  state({ kind: 'not-running' })
  expect(container.textContent).toContain('The session is not running.')
  await click('Wake it')
  expect(h.resumeSession).toHaveBeenCalledWith('cs_1')
  expect(container.textContent).toContain('Waking the session…')
  await act(() => vi.advanceTimersByTimeAsync(3_000))
  expect(h.opens).toHaveLength(2)
})

it('says the computer is waking', () => {
  state({ kind: 'waking-computer' })
  expect(container.textContent).toContain('Waking the computer…')
})

it('explains an idle, lost or refused terminal and reconnects', async () => {
  for (const message of [
    'Closed after 15 minutes without activity.',
    'Closed: you may no longer drive this session.',
    'Only people who may drive this session can open a terminal in it.',
  ]) {
    state({ kind: message.startsWith('Only') ? 'error' : 'ended', message })
    expect(container.textContent).toContain(message)
    const before = h.opens.length
    await click('Reconnect')
    expect(h.opens).toHaveLength(before + 1)
  }
})
