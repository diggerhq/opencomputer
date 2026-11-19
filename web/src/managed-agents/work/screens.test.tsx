// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '@/api/errors'
import { AuthContext, type AuthContextValue } from '@/hooks/useAuth'
import { makeItem, minutesAgo } from './fixtures'

const workApi = vi.hoisted(() => ({
  getOpenItems: vi.fn(),
  getClosedItems: vi.fn(),
  getItem: vi.fn(),
  getHistory: vi.fn(),
  getRepository: vi.fn(),
  putRepository: vi.fn(),
}))
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  ...workApi,
}))
vi.mock('../computer-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../computer-api')>()),
  getComputer: vi.fn().mockResolvedValue({
    github: { installations: [{ id: '1', accountLogin: 'acme' }] },
  }),
}))

const { Board } = await import('./Board')
const { ItemView } = await import('./Item')

const repository = {
  installationId: '1',
  owner: 'acme',
  name: 'knowledge',
  branch: 'main',
  problem: null,
}
const openPage = (items: ReturnType<typeof makeItem>[], over = {}) => ({
  etag: '"h1"',
  page: {
    repository,
    head: 'abc',
    asOf: new Date().toISOString(),
    building: false,
    items,
    ...over,
  },
})

const auth: AuthContextValue = {
  user: {
    id: 'usr_1',
    email: 'a@example.com',
    orgId: 'org_1',
    computerEnabled: true,
  },
  loading: false,
  error: null,
  switchOrg: async () => {},
  refreshUser: async () => {},
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
  workApi.getClosedItems.mockResolvedValue({ items: [], nextCursor: null })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.body.innerHTML = ''
  vi.clearAllMocks()
})

async function render(url: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  act(() => {
    root.render(
      <AuthContext.Provider value={auth}>
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={[url]}>
            <Routes>
              <Route path="/computer/work" element={<Board />} />
              <Route path="/computer/work/:number" element={<ItemView />} />
            </Routes>
          </MemoryRouter>
        </QueryClientProvider>
      </AuthContext.Provider>,
    )
  })
  for (let i = 0; i < 50 && container.querySelector('[role="status"]'); i++) {
    await flush()
  }
  await flush()
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function column(title: string) {
  const el = container.querySelector(`section[aria-label="${title}"]`)
  if (!el) throw new Error(`no column ${title}`)
  return el
}
const titles = (el: Element) =>
  [...el.querySelectorAll('article h3 a')].map((a) => a.textContent)

function click(el: Element | null | undefined) {
  if (!el) throw new Error('nothing to click')
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('board', () => {
  const items = [
    makeItem({ number: 1, title: 'Mine, quiet', mine: true }),
    makeItem({
      number: 2,
      title: 'Mine, needs me',
      mine: true,
      updatedAt: minutesAgo(600),
      attention: { state: 'needs_you', name: null, since: minutesAgo(30) },
    }),
    makeItem({
      number: 3,
      title: 'Theirs, waiting',
      updatedAt: minutesAgo(10),
      attention: { state: 'waiting_on', name: 'Maya', since: minutesAgo(180) },
    }),
    makeItem({
      number: 4,
      title: 'Mine, done',
      mine: true,
      readyToClose: true,
      warnings: ['A Left item has no checkbox.'],
    }),
  ]

  it('shows my items in their columns, needing me first', async () => {
    workApi.getOpenItems.mockResolvedValue(openPage(items))
    workApi.getClosedItems.mockResolvedValue({
      items: [
        makeItem({
          number: 5,
          title: 'Closed lately',
          stage: 'closed',
          mine: true,
          closedAt: minutesAgo(60),
          closedBy: 'Igor',
        }),
        makeItem({
          number: 6,
          title: 'Closed long ago',
          stage: 'closed',
          mine: true,
          closedAt: minutesAgo(30 * 24 * 60),
        }),
      ],
      nextCursor: null,
    })
    await render('/computer/work')
    expect(titles(column('In progress'))).toEqual([
      'Mine, needs me',
      'Mine, quiet',
    ])
    expect(titles(column('Ready to close'))).toEqual(['Mine, done'])
    expect(titles(column('Closed'))).toEqual(['Closed lately'])
    expect(column('Closed').textContent).toContain('Closed by Igor')
    expect(column('In progress').textContent).toContain('needs you')
    expect(
      container.querySelector('[aria-label^="The doc has a problem"]'),
    ).not.toBeNull()
  })

  it('shows everyone, with others waiting in grey words', async () => {
    workApi.getOpenItems.mockResolvedValue(openPage(items))
    await render('/computer/work?tab=everyone')
    expect(titles(column('In progress'))).toEqual([
      'Mine, needs me',
      'Theirs, waiting',
      'Mine, quiet',
    ])
    expect(column('In progress').textContent).toContain('waiting on Maya · 3h')
  })

  it('filters by text and by tag from the address', async () => {
    workApi.getOpenItems.mockResolvedValue(
      openPage([
        makeItem({ number: 1, title: 'Billing', tags: ['billing'] }),
        makeItem({ number: 2, title: 'Docs', tags: ['docs'] }),
      ]),
    )
    await render('/computer/work?tab=everyone&tag=docs')
    expect(titles(column('In progress'))).toEqual(['Docs'])
    act(() => root.unmount())
    root = createRoot(container)
    await render('/computer/work?tab=everyone&q=bill')
    expect(titles(column('In progress'))).toEqual(['Billing'])
  })

  it('points to Everyone when I own nothing', async () => {
    workApi.getOpenItems.mockResolvedValue(
      openPage([makeItem({ number: 3, title: 'Theirs' })]),
    )
    await render('/computer/work')
    expect(container.textContent).toContain('You own no items')
    click(
      [...container.querySelectorAll('button')].find(
        (b) => b.textContent === 'Everyone' && b.getAttribute('role') !== 'tab',
      ),
    )
    await flush()
    expect(titles(column('In progress'))).toEqual(['Theirs'])
  })

  it('explains what an item is before a repository is set', async () => {
    workApi.getOpenItems.mockResolvedValue(
      openPage([], { repository: null, head: null, asOf: null }),
    )
    workApi.getRepository.mockResolvedValue(null)
    await render('/computer/work')
    expect(container.textContent).toContain('An item is a working doc')
    expect(container.textContent).toContain('Working docs')
    expect(workApi.getClosedItems).not.toHaveBeenCalled()
  })

  it('reads a 404 as not available yet', async () => {
    workApi.getOpenItems.mockRejectedValue(new ApiError('Not found', 404))
    await render('/computer/work')
    expect(container.textContent).toContain('The board is not available yet')
  })

  it('sends a repository problem to settings', async () => {
    workApi.getOpenItems.mockResolvedValue(
      openPage(items, {
        repository: {
          ...repository,
          problem: 'access_denied',
          problemMessage: 'GitHub refused access to the repository.',
        },
      }),
    )
    await render('/computer/work')
    expect(container.textContent).toContain(
      'Cannot read acme/knowledge. GitHub refused access to the repository.',
    )
    expect(container.textContent).not.toContain('access_denied')
    expect(
      container.querySelector('a[href="/computer#work-repository"]'),
    ).not.toBeNull()
  })

  it('offers no Close or Reopen yet', async () => {
    workApi.getOpenItems.mockResolvedValue(openPage(items))
    await render('/computer/work')
    const words = [...container.querySelectorAll('button')].map(
      (b) => b.textContent,
    )
    expect(words).not.toContain('Close')
    expect(words).not.toContain('Reopen')
  })
})

describe('item page', () => {
  const item = makeItem({
    number: 12,
    title: 'Usage billing',
    owner: { email: 'igor@example.com', name: 'Igor', id: 'usr_1' },
    author: { email: 'maya@example.com', name: 'Maya', id: null },
    tags: ['billing'],
    sessions: [
      { id: 'cs_1', title: 'Meter minutes', ownerName: 'Igor', status: 'idle' },
    ],
    pullRequests: [
      {
        url: 'https://github.com/acme/app/pull/41',
        state: 'merged',
        title: 'Meter',
      },
    ],
  })

  it('renders the doc under a header, with details beside it', async () => {
    workApi.getItem.mockResolvedValue({
      item,
      body: '---\nnumber: 12\n---\n# Usage billing\n\n## Why\n\nBecause.',
    })
    await render('/computer/work/12')
    expect(container.querySelector('h1')?.textContent).toBe('12Usage billing')
    expect(container.querySelector('article h2')?.textContent).toBe('Why')
    expect(container.textContent).toContain('started by Maya')
    expect(container.textContent).not.toContain('number: 12')
    expect(
      container.querySelector('a[href="/computer/sessions/cs_1"]')?.textContent,
    ).toBe('Meter minutes')
    expect(container.textContent).toContain('#41 Meter')
    expect(container.textContent).toContain('merged')
    expect(workApi.getHistory).not.toHaveBeenCalled()
  })

  it('says when an item has no owner', async () => {
    workApi.getItem.mockResolvedValue({
      item: { ...item, owner: null },
      body: 'x',
    })
    await render('/computer/work/12')
    expect(container.querySelector('header')?.textContent).toContain('no owner')
  })

  it('lists the changes on the History tab', async () => {
    workApi.getItem.mockResolvedValue({ item, body: 'x' })
    workApi.getHistory.mockResolvedValue({
      revisions: [
        {
          sha: 'abcdef1234567',
          url: 'https://github.com/acme/knowledge/commit/abcdef1',
          at: minutesAgo(5),
          authorName: 'Computer for Igor',
          summary: 'Record the price question',
          sessionId: 'cs_9',
        },
      ],
      nextCursor: null,
    })
    await render('/computer/work/12?tab=history')
    expect(workApi.getHistory).toHaveBeenCalledWith(12, undefined)
    expect(container.textContent).toContain('Record the price question')
    expect(container.textContent).toContain('Computer for Igor')
    expect(
      container.querySelector('a[href="/computer/sessions/cs_9"]'),
    ).not.toBeNull()
    expect(
      container.querySelector(
        'a[href="https://github.com/acme/knowledge/commit/abcdef1"]',
      )?.textContent,
    ).toContain('abcdef1')
  })

  it('says when there is no such item', async () => {
    workApi.getItem.mockRejectedValue(new ApiError('Not found', 404))
    await render('/computer/work/99')
    expect(container.textContent).toContain('No such item')
  })
})
