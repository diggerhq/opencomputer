import { describe, expect, it } from 'vitest'
import { isNearScrollEnd } from './scroll-follow'

describe('isNearScrollEnd', () => {
  it('follows when the reader is at or near the newest content', () => {
    expect(
      isNearScrollEnd({
        scrollHeight: 1_000,
        scrollTop: 600,
        clientHeight: 400,
      }),
    ).toBe(true)
    expect(
      isNearScrollEnd({
        scrollHeight: 1_000,
        scrollTop: 510,
        clientHeight: 400,
      }),
    ).toBe(true)
  })

  it('preserves position after the reader scrolls away from the bottom', () => {
    expect(
      isNearScrollEnd({
        scrollHeight: 1_000,
        scrollTop: 400,
        clientHeight: 400,
      }),
    ).toBe(false)
  })
})
