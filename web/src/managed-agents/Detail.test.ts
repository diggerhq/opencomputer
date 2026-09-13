import { describe, expect, it } from 'vitest'
import { PROJECT_DETAIL_TABS } from './Detail'

describe('managed project detail tabs', () => {
  it('routes managed connections and retains the GitHub compatibility alias', () => {
    expect(PROJECT_DETAIL_TABS.has('connections')).toBe(true)
    expect(PROJECT_DETAIL_TABS.has('github')).toBe(true)
  })
})
