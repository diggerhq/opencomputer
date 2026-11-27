// Following the end: a reader moving up, by however little, is never pulled
// back down by the next render (131).

import { describe, expect, it } from 'vitest'
import { following, type Seen } from './follow'

const s = (top: number, bottom: number, view = 400): Seen => ({
  top,
  bottom,
  view,
})

describe('following', () => {
  it('leaves the end on a move up of a few pixels', () => {
    expect(following(true, s(800, 0), s(797, 3))).toBe(false)
  })

  it('stays left while the reader rests near the end', () => {
    expect(following(false, s(797, 3), s(797, 3))).toBe(false)
  })

  it('stays left while content grows below', () => {
    expect(following(false, s(700, 100), s(700, 180))).toBe(false)
  })

  it('keeps following while content grows below', () => {
    expect(following(true, s(800, 0), s(800, 40))).toBe(true)
  })

  it('keeps following when content shrinks and clamps the top', () => {
    expect(following(true, s(800, 0), s(760, 0))).toBe(true)
  })

  it('keeps following through a resizing view', () => {
    expect(following(true, s(800, 0), s(780, 60, 340))).toBe(true)
  })

  it('follows again on moving down to near the end', () => {
    expect(following(false, s(700, 100), s(790, 10))).toBe(true)
  })

  it('follows again on reaching the end', () => {
    expect(following(false, s(700, 100), s(800, 0))).toBe(true)
  })
})
