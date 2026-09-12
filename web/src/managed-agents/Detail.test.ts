import { describe, expect, it } from 'vitest'
import { PROJECT_DETAIL_TABS } from './Detail'

describe('managed project detail tabs', () => {
  it('routes the managed GitHub connection tab instead of falling back', () => {
    expect(PROJECT_DETAIL_TABS.has('github')).toBe(true)
  })
})
