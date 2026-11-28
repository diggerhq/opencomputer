// @vitest-environment happy-dom
// A link in a message to one of the reader's pull requests (work 118): drawn
// as the result, with Merge where it can merge. Any other link stays a link.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStore } from 'zustand'
import type { ResultRow } from '@opencomputer/sdk/computer'
import { MarkdownLinkContext, type MarkdownLink } from '@/managed-agents/markdown-link'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SurfaceContext } from '../hooks'
import type { State } from '../store/surface-state'
import type { Surface } from '../store/surface-store'
import { pullAt } from '../store/pulls'
import { PullLink } from './PullLink'
import { Rich } from './Rich'

const URL = 'https://github.com/o/r/pull/7'
const pr = (over: Partial<ResultRow> = {}): ResultRow =>
  ({ kind: 'result', id: 'res_1', version: 1, sessionId: 'cs_1', type: 'pr', ref: URL, title: 'Fix the thing', state: 'open', meta: null, pull: { head: 'a'.repeat(40) }, ...over }) as ResultRow

const link: MarkdownLink = (href, plain) => <PullLink href={href} plain={plain} />

let root: Root
let el: HTMLDivElement
let surface: { merge: ReturnType<typeof vi.fn>; openResult: ReturnType<typeof vi.fn> }

beforeEach(() => {
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
  surface = { merge: vi.fn(), openResult: vi.fn() }
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

function draw(text: string, results: ResultRow[], unmerged: State['unmerged'] = {}) {
  const state = { rows: { result: new Map(results.map((r) => [r.id, r])) }, unmerged, loc: { thread: 'cs_1' } } as unknown as State
  const store = createStore(() => state)
  act(() =>
    root.render(
      <TooltipProvider>
        <SurfaceContext.Provider value={{ ...surface, store } as unknown as Surface}>
          <MarkdownLinkContext.Provider value={link}>
            <Rich text={text} size="reading" />
          </MarkdownLinkContext.Provider>
        </SurfaceContext.Provider>
      </TooltipProvider>,
    ),
  )
}
const chip = () => el.querySelector('[data-pull-link]')
const merge = () => el.querySelector<HTMLButtonElement>('[data-merge]')

describe('a pull request link in a message', () => {
  it('is the result, with Merge, which merges it; its body opens the review', () => {
    draw(`Opened [the pull request](${URL}/files).`, [pr()])
    expect(chip()?.textContent).toBe('Fix the thing#7Merge')
    expect(el.querySelector('a')).toBeNull()
    act(() => merge()!.click())
    expect(surface.merge).toHaveBeenCalledWith('res_1')
    act(() => chip()!.querySelector('button')!.click())
    expect(surface.openResult).toHaveBeenCalledWith(expect.objectContaining({ id: 'res_1' }))
  })

  it('says its state as it is now, and offers no Merge once merged, or while a draft', () => {
    draw(`See ${URL}`, [pr({ state: 'merged' })])
    expect(chip()?.textContent).toBe('Fix the thing#7merged')
    expect(merge()).toBeNull()
    draw(`See ${URL}`, [pr({ pull: { draft: true } })])
    expect(merge()).toBeNull()
    draw(`See ${URL}`, [pr({ pull: { merging: { by: 'user:usr_b', at: Date.now(), head: 'a'.repeat(40) } } })])
    expect(chip()?.textContent).toBe('Fix the thing#7merging…')
  })

  it('says a merge was refused, and still offers Merge', () => {
    draw(`See ${URL}`, [pr()], { res_1: { why: 'it conflicts with its base branch', head: 'a'.repeat(40) } })
    expect(chip()?.textContent).toBe('Fix the thing#7not mergedMerge')
  })

  it('leaves any other link a link: another pull request, another site', () => {
    draw(`[one](https://github.com/o/r/pull/8) and [two](https://example.com/pull/7)`, [pr()])
    expect(chip()).toBeNull()
    expect([...el.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual(['https://github.com/o/r/pull/8', 'https://example.com/pull/7'])
  })

  it("of two threads' results for one pull request, the open thread's own", () => {
    const rows = new Map([pr({ id: 'res_2', sessionId: 'cs_2' }), pr()].map((r) => [r.id, r]))
    expect(pullAt(rows, URL, 'cs_1')?.id).toBe('res_1')
    expect(pullAt(rows, URL, 'cs_2')?.id).toBe('res_2')
    expect(pullAt(rows, `${URL}#issuecomment-1`)?.id).toBeDefined()
    expect(pullAt(rows, 'https://github.com/o/r/pull/70')).toBeUndefined()
  })
})
