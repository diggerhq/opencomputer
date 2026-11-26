// @vitest-environment happy-dom
// The review's summary as the agent wrote it (S9): a real surface over the
// SDK's fake server, whose agent opens a pull request and saves a summary
// through `review.save`; the diff library is replaced by a plain drawing of
// the hunks it is handed and the lines it is asked to mark.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryStorage } from '@opencomputer/sdk/computer'
import {
  createFakeServer,
  type FakeServer,
} from '@opencomputer/sdk/computer/fake'
import type { FileDiffMetadata, SelectedLineRange } from '@pierre/diffs'
import type { Host } from '../host'
import { NOWHERE } from '../host'
import { SurfaceContext } from '../hooks'
import { createSurface, type Surface } from '../store'

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
  for (let i = 0; i < 200; i += 1) {
    if (until()) return
    await act(() => sleep(5))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

function open(fake: FakeServer): Surface {
  let loc = NOWHERE
  const host: Host = {
    platform: 'web',
    principal: fake.principal,
    api: { fetch: (path, init) => fake.fetch(path, init) },
    connect: () => fake.connect(),
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
  return createSurface({ host, storage: memoryStorage(), visible: () => true })
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
    const fake = createFakeServer({ seed: 'empty', pace: 0, latency: 0 })
    s = open(fake)
    await settle(() => s.get().ready && s.get().synced, 'the surface')
    const sid = s.start('Open a PR for the slow query', { open: false })
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
  })
})
