// @vitest-environment happy-dom
// The review's summary as the agent wrote it (S9): a real surface over the
// managed-agents Worker run locally (services/managed-agents/test/fixtures/
// stack.ts). The test is the agent: it opens a pull request and saves a
// summary through `review.save`. The diff, which the server fetches from
// GitHub, is a recorded one; the diff library is replaced by a plain drawing
// of the hunks it is handed and the lines it is asked to mark.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { makeId, memoryStorage } from '@opencomputer/sdk/computer'
import type { FileDiffMetadata, SelectedLineRange } from '@pierre/diffs'
import type { Host } from '../host'
import { NOWHERE } from '../host'
import { SurfaceContext } from '../hooks'
import { createSurface, type Surface } from '../store'
import {
  startStack,
  type Caller,
  type Stack,
} from '../../../../services/managed-agents/test/fixtures/stack'

vi.mock('@pierre/diffs/react', () => ({
  FileDiff: ({
    fileDiff,
    selectedLines,
  }: {
    fileDiff: FileDiffMetadata
    selectedLines?: SelectedLineRange | null
  }) => (
    <pre data-testid="diff" data-file={fileDiff.name}>
      {fileDiff.hunks
        .map((h) => `@@ +${h.additionStart},${h.additionCount}`)
        .join(' ')}
      {selectedLines &&
        ` marked ${selectedLines.side} ${selectedLines.start}-${selectedLines.end}`}
    </pre>
  ),
  Virtualizer: ({
    children,
    className,
  }: {
    children: React.ReactNode
    className?: string
  }) => (
    <div className={className}>
      <div>{children}</div>
    </div>
  ),
}))

const { default: Review } = await import('./Review')

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function settle(until: () => boolean, label: string) {
  for (let i = 0; i < 2000; i += 1) {
    if (until()) return
    await act(() => sleep(5))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

const FILES = ['src/handler.ts', 'src/rows.ts', 'src/rows.test.ts']
// What GitHub answered for the pull request.
const DIFF = FILES.map(
  (f, i) =>
    `diff --git a/${f} b/${f}\n--- a/${f}\n+++ b/${f}\n@@ -${10 + i},3 +${10 + i},4 @@\n const org = session.org\n-const rows = await each(ids, loadRow)\n+const rows = await loadRows(org)\n+rows.sort(byPosition)\n return rows\n`,
).join('')
const PARTS = [
  {
    title: 'Rows load in one query',
    claim:
      '`loadRows` asks once for every row of the organization, instead of once per row.',
    points: ['The loop over ids is gone; nothing else called `loadRow`.'],
    files: [
      { path: FILES[0], note: 'Calls `loadRows` and sorts by position.' },
      { path: FILES[1] },
    ],
    excerpts: [
      {
        path: FILES[0],
        start: 10,
        end: 13,
        why: 'The one query, and the sort that keeps the order.',
      },
    ],
    eye: [
      {
        text: 'The order of the rows now comes from the query, not from the loop.',
        path: FILES[0],
        line: 12,
      },
    ],
  },
  {
    title: 'The test covers both orders',
    claim: 'One test for an empty organization, one for sixty rows.',
    files: [{ path: FILES[2] }],
  },
]

let stack: Stack
beforeAll(async () => {
  stack = await startStack()
}, 60_000)
afterAll(() => stack?.close())

function open(me: Caller): Surface {
  let loc = NOWHERE
  const net = me.net()
  const host: Host = {
    platform: 'web',
    principal: { org: me.principal.org, subject: me.principal.subject },
    api: { fetch: (path, init) => net.fetch(path, init) },
    connect: () => net.connect(),
    notify: () => {},
    badge: () => {},
    openExternal: () => {},
    onOpen: () => {},
    location: {
      get: () => loc,
      set: (l) => void (loc = l),
      onChange: () => () => {},
    },
  }
  const s = createSurface({
    host,
    storage: memoryStorage(),
    visible: () => true,
  })
  s.diff = () => Promise.resolve(DIFF)
  return s
}

describe('Review summary', () => {
  let container: HTMLDivElement
  let root: Root
  let s: Surface

  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    s?.close()
  })

  it('shows the claim, points, excerpts, eye items and file notes the agent wrote', async () => {
    const org = `org_review${Math.random().toString(36).slice(2, 8)}`
    const computer = await stack.host(org)
    s = open(await stack.member(org, 'ada'))
    await settle(() => s.get().ready && s.get().synced, 'the surface')
    const sid = s.start('Open a PR for the slow query', { open: false })
    // The agent's turn: the pull request, its review, and ready.
    await computer.turn(sid)
    const agent = await stack.agent(org, sid)
    const put = async (path: string, body: unknown) => {
      const r = await agent.fetch(path, {
        method: 'PUT',
        body: JSON.stringify(body),
        headers: { 'idempotency-key': `idem_${makeId('op').slice(3)}` },
      })
      if (r.status >= 300) throw new Error(`${path}: ${await r.text()}`)
    }
    const resultId = makeId('res')
    await put(`/work/results/${resultId}`, {
      sid,
      kind: 'pr',
      ref: 'https://github.com/acme/console/pull/1',
      title: 'PR #1',
    })
    await put(`/work/results/${resultId}/review`, {
      head: 'h1a91c7',
      parts: PARTS,
    })
    await put(`/work/threads/${sid}/ready`, { what: 'PR #1 is open', resultId })
    computer.say(sid, 'Done, and up as PR #1.')
    computer.end(sid)
    const pr = () =>
      s
        .list()
        .threads.find((t) => t.id === sid)
        ?.results.find((r) => r.type === 'pr')
    await settle(() => !!pr() && s.thread(sid)?.mark === 'ready', 'the PR')

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    act(() =>
      root.render(
        <SurfaceContext.Provider value={s}>
          <QueryClientProvider client={client}>
            <Review resultId={pr()!.id} />
          </QueryClientProvider>
        </SurfaceContext.Provider>,
      ),
    )
    const text = () => container.textContent ?? ''
    await settle(
      () => text().includes('asks once for every row'),
      'the summary',
    )
    await settle(() => !text().includes('Fetching the diff'), 'the diff')

    // The claim and points of each part.
    expect(text()).toContain('Rows load in one query')
    expect(text()).toContain('instead of once per row')
    expect(text()).toContain('nothing else called')
    expect(text()).toContain('One test for an empty organization')
    // The thing worth the reviewer's eye, with where it is.
    expect(text()).toContain('One thing worth your eye')
    expect(text()).toContain('The order of the rows now comes from the query')
    expect(text()).toContain('src/handler.ts:12')
    // What the agent said of a file.
    const handler = container.querySelector('[data-path="src/handler.ts"]')
    expect(handler?.textContent).toContain('sorts by position')

    // The excerpt: its lines and why, and the hunk they are in, marked.
    const excerpt = container.querySelector('[data-excerpt="src/handler.ts"]')!
    expect(excerpt.textContent).toContain('lines 10–13')
    expect(excerpt.textContent).toContain('The one query, and the sort')
    expect(excerpt.querySelector('[data-testid="diff"]')?.textContent).toBe(
      '@@ +10,4 marked additions 10-13',
    )
    // Only the excerpt is drawn as code: a summary with excerpts lists the
    // other files rather than opening each.
    expect(container.querySelectorAll('[data-testid="diff"]')).toHaveLength(1)
  }, 30_000)
})
