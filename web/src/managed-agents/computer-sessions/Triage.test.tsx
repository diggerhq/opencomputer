// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  Ask,
  ListSessionsQuery,
  Session,
  SessionEvent,
} from '../computer-sessions-api'

const api = vi.hoisted(() => ({
  listSessions: vi.fn(),
  getEvents: vi.fn(),
  getCapabilities: vi.fn(),
  sendTurn: vi.fn(),
  setAside: vi.fn(),
  bringBack: vi.fn(),
  answerAsk: vi.fn(),
  dismissAsk: vi.fn(),
}))
vi.mock('../computer-sessions-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../computer-sessions-api')>()),
  ...api,
}))
vi.mock('@/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client')>()),
  getOrgMembers: vi.fn(() => Promise.resolve([])),
}))

const { default: Triage } = await import('./Triage')

const ask = (id: string, sessionId: string, min: number): Ask => ({
  id,
  sessionId,
  turnId: `tn_${sessionId}`,
  kind: 'other',
  status: 'open',
  createdAt: new Date(Date.now() - min * 60_000).toISOString(),
})
const session = (id: string, asks: Ask[], status = 'waiting'): Session => ({
  id,
  title: `Thread ${id}`,
  status,
  archived: false,
  aside: false,
  owner: null,
  origin: { type: 'dashboard' },
  settings: { model: null, effort: null, mode: null },
  activeTurnId: null,
  asks,
  lastText: 'checking the logs',
  lastSeq: 1,
  createdAt: new Date().toISOString(),
  lastActiveAt: new Date().toISOString(),
})

// The server's view: waiting sessions with their asks and what is set aside.
let waiting: Session[] = []
let working: Session[] = []
const asideRefs = new Map<string, string>()
const shown = () =>
  waiting.map((s) => ({ ...s, aside: asideRefs.get(s.id) === s.asks[0]?.id }))

let seq = 0
const ev = (
  turnId: string,
  type: string,
  data: Record<string, unknown>,
): SessionEvent => ({
  id: `ev_${++seq}`,
  seq,
  createdAt: new Date().toISOString(),
  turnId,
  actor: type === 'message.received' ? { name: 'Igor' } : null,
  type,
  data,
})

async function settle(until: () => boolean, label: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (until()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function Location() {
  const location = useLocation()
  return <output data-testid="location">{location.search}</output>
}

describe('Triage', () => {
  let container: HTMLDivElement
  let root: Root
  let client: QueryClient

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    waiting = [
      session('b', [ask('ak_b', 'b', 5)]),
      session('a', [ask('ak_a', 'a', 30)]),
    ]
    working = [1, 2, 3, 4, 5, 6, 7].map((i) => session(`w${i}`, [], 'running'))
    asideRefs.clear()
    api.listSessions.mockImplementation((q: ListSessionsQuery) =>
      Promise.resolve({
        sessions: q.status === 'waiting' ? shown() : working,
        nextCursor: null,
      }),
    )
    api.getEvents.mockImplementation((id: string) =>
      Promise.resolve({
        events: [
          ev('tn_old', 'message.received', { input: `Earlier in ${id}` }),
          ev('tn_old', 'turn.completed', {}),
          ev(`tn_${id}`, 'message.received', { input: `Start ${id}` }),
          ev(`tn_${id}`, 'message.completed', { text: `Asking in ${id}` }),
        ],
        earlierTurns: [{}, {}],
        lastSeq: seq,
        hasMore: false,
      }),
    )
    api.getCapabilities.mockResolvedValue({
      models: [],
      modes: [],
      features: { steer: true },
    })
    api.setAside.mockImplementation((id: string, ref: string) => {
      asideRefs.set(id, ref)
      return Promise.resolve(shown().find((s) => s.id === id))
    })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  const render = (path = '/computer/triage') =>
    act(() => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route
                path="/computer/triage"
                element={
                  <>
                    <Triage />
                    <Location />
                  </>
                }
              />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      )
    })
  const text = () => container.textContent ?? ''
  const location = () =>
    container.querySelector('[data-testid="location"]')!.textContent
  const button = (name: string) =>
    [...container.querySelectorAll('button')].find(
      (b) => b.textContent === name || b.getAttribute('aria-label') === name,
    )!
  const box = () => container.querySelector('textarea')!
  const type = (value: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )?.set?.call(box(), value)
      box().dispatchEvent(new Event('input', { bubbles: true }))
    })
  const click = (el: Element) =>
    act(() => {
      ;(el as HTMLElement).click()
    })

  it('opens the oldest ask with its excerpt, and lists the rest', async () => {
    render()
    await settle(() => location() === '?ask=ak_a', 'the oldest ask selected')
    await settle(() => text().includes('Asking in a'), 'the excerpt')
    expect(container.querySelector('h1')?.textContent).toBe('Needs you')
    expect(text()).toContain('2 earlier messages')
    expect(text()).toContain('where it stopped')
    // The rule sits before the asking turn, after the earlier one.
    const rule = text().indexOf('where it stopped')
    expect(text().indexOf('Earlier in a')).toBeLessThan(rule)
    expect(text().indexOf('Start a')).toBeGreaterThan(rule)
    expect(
      container.querySelector('[aria-current="true"]')?.textContent,
    ).toContain('Thread a')
    // Agents working: five rows, then the rest as a link to Sessions.
    expect(text()).toContain('2 more')
    expect(text()).not.toContain('Set aside2')
  })

  it('keeps typed text per ask, and a reply answers it and moves on', async () => {
    api.sendTurn.mockImplementation((id: string) => {
      waiting = waiting.filter((s) => s.id !== id)
      return Promise.resolve({
        turn: { id: 'tn_x', status: 'running' },
        delivery: 'started',
      })
    })
    render()
    await settle(() => location() === '?ask=ak_a', 'the oldest ask selected')
    type('use the token bucket')
    const rowB = [...container.querySelectorAll('aside button')].find((b) =>
      b.textContent?.includes('Thread b'),
    )!
    click(rowB)
    await settle(() => location() === '?ask=ak_b', 'the second ask')
    expect(box().value).toBe('')
    const rowA = [...container.querySelectorAll('aside button')].find((b) =>
      b.textContent?.includes('Thread a'),
    )!
    click(rowA)
    await settle(() => box().value === 'use the token bucket', 'the draft')

    click(button('Send'))
    await settle(() => location() === '?ask=ak_b', 'the next ask')
    expect(api.sendTurn).toHaveBeenCalledWith(
      'a',
      'use the token bucket',
      'steer',
    )
  })

  it('says "Not sent" and keeps the text when sending fails', async () => {
    api.sendTurn.mockRejectedValueOnce(new Error('offline'))
    render('/computer/triage?ask=ak_a')
    await settle(() => !!container.querySelector('textarea'), 'the box')
    type('ship it')
    click(button('Send'))
    await settle(() => text().includes('Not sent'), 'the failure')
    expect(box().value).toBe('ship it')
    expect(location()).toBe('?ask=ak_a')
    api.sendTurn.mockResolvedValueOnce({
      turn: { id: 'tn_x', status: 'running' },
      delivery: 'started',
    })
    click(button('Retry'))
    await settle(() => location() === '?ask=ak_b', 'the next ask')
  })

  it('sets an ask aside, and ends on "All clear" with what is set aside', async () => {
    waiting = [waiting[1]]
    render()
    await settle(() => location() === '?ask=ak_a', 'the ask')
    click(button('Set aside'))
    await settle(() => text().includes('All clear'), 'all clear')
    expect(api.setAside).toHaveBeenCalledWith('a', 'ak_a')
    expect(text()).toContain('1 set aside')
    expect(text()).toContain('Set aside1')
  })

  it('keeps an ask answered elsewhere on screen, with Next', async () => {
    render('/computer/triage?ask=ak_a')
    await settle(() => text().includes('Asking in a'), 'the ask')
    waiting = waiting.filter((s) => s.id !== 'a')
    await act(() => client.refetchQueries())
    await settle(
      () => text().includes('This was answered elsewhere.'),
      'the line',
    )
    click(button('Next'))
    await settle(() => location() === '?ask=ak_b', 'the next ask')
  })
})
