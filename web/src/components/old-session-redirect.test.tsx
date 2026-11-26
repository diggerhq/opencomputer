// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import OldSessionRedirect from './old-session-redirect'
;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

function Location() {
  return <span data-testid="location">{useLocation().pathname}</span>
}

function landing(url: string) {
  const container = document.createElement('div')
  const root = createRoot(container)
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="computer/sessions/*" element={<OldSessionRedirect />} />
          <Route path="*" element={<Location />} />
        </Routes>
      </MemoryRouter>,
    )
  })
  const path = container.textContent
  act(() => root.unmount())
  return path
}

describe('the old session pages', () => {
  it('open the same place on the work surface', () => {
    expect(landing('/computer/sessions')).toBe('/computer/work')
    expect(landing('/computer/sessions/new')).toBe('/computer/work/new')
    expect(landing('/computer/sessions/cs_1')).toBe('/computer/work/t/cs_1')
  })
})
