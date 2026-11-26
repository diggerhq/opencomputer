import { describe, expect, it } from 'vitest'
import { docSpans, mergeDoc } from './doc'

// Spec 22.3: a save over a Doc that moved is merged three ways; overlapping
// lines keep the person's; spans say which lines a person wrote.

const base = ['# Goal', 'Ship it', '', '## Plan', '- one', '- two'].join('\n')

describe('mergeDoc', () => {
  it('keeps both sides where they changed different lines', () => {
    const ours = base.replace('Ship it', 'Ship it this week')
    const theirs = `${base}\n- three`
    expect(mergeDoc(base, ours, theirs)).toEqual({ text: `${ours}\n- three`, conflicts: 0 })
  })

  it('keeps the person’s lines where both changed the same ones, and counts it', () => {
    const ours = base.replace('Ship it', 'Ship it this week')
    const theirs = base.replace('Ship it', 'Ship it next month')
    expect(mergeDoc(base, ours, theirs)).toEqual({ text: ours, conflicts: 1 })
  })

  it('takes theirs when the person changed nothing', () => {
    const theirs = `${base}\n- three`
    expect(mergeDoc(base, base, theirs)).toEqual({ text: theirs, conflicts: 0 })
  })
})

describe('docSpans', () => {
  it('marks the lines the person wrote, and only those', () => {
    const next = base.replace('- one', '- one, first')
    expect(docSpans({ text: base, spans: [] }, base, next, 'usr_me')).toEqual([{ from: 4, to: 5, by: 'usr_me' }])
  })

  it('carries earlier spans through lines added above them', () => {
    const prev = { text: base, spans: [{ from: 1, to: 2, by: 'usr_me' }] }
    const theirs = `Intro\n${base}`
    // The agent added a line above; the person's line moves down with it.
    expect(docSpans(prev, theirs, theirs, 'usr_me')).toEqual([{ from: 2, to: 3, by: 'usr_me' }])
  })
})
