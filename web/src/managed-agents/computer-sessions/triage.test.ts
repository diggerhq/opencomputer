import { describe, expect, it } from 'vitest'
import type { Ask, Session } from '../computer-sessions-api'
import { triageEntries, triageEntry } from './triage'

const ask = (id: string, createdAt: string, status = 'open'): Ask => ({
  id,
  sessionId: 'cs_1',
  turnId: 'tn_1',
  kind: 'question',
  status,
  createdAt,
  question: {
    questions: [
      {
        id: 'q1',
        header: 'Library',
        text: `Question ${id}?`,
        multiSelect: false,
        options: [],
      },
    ],
  },
})

const session = (id: string, asks: Ask[], aside = false): Session => ({
  id,
  title: `Session ${id}`,
  status: 'waiting',
  archived: false,
  aside,
  owner: null,
  origin: { type: 'dashboard' },
  settings: { model: null, effort: null, mode: null },
  activeTurnId: null,
  asks,
  lastText: null,
  lastSeq: 1,
  createdAt: '2026-11-19T10:00:00.000Z',
  lastActiveAt: null,
})

describe('triageEntry', () => {
  it("is the session's oldest open ask, headed with its words", () => {
    const e = triageEntry(
      session('a', [
        ask('ak_new', '2026-11-19T12:00:00.000Z'),
        ask('ak_closed', '2026-11-19T09:00:00.000Z', 'answered'),
        ask('ak_old', '2026-11-19T11:00:00.000Z'),
      ]),
    )
    expect(e).toMatchObject({
      ref: 'ak_old',
      line: 'Question ak_old?',
      at: '2026-11-19T11:00:00.000Z',
      aside: false,
    })
  })

  it('is null when nothing is open', () => {
    expect(
      triageEntry(
        session('a', [ask('ak_1', '2026-11-19T09:00:00.000Z', 'declined')]),
      ),
    ).toBeNull()
  })
})

describe('triageEntries', () => {
  it('orders asks oldest first and keeps set-aside ones apart', () => {
    const { needs, aside } = triageEntries([
      session('late', [ask('ak_late', '2026-11-19T12:00:00.000Z')]),
      session('none', []),
      session('early', [ask('ak_early', '2026-11-19T08:00:00.000Z')]),
      session('away', [ask('ak_away', '2026-11-19T07:00:00.000Z')], true),
    ])
    expect(needs.map((e) => e.ref)).toEqual(['ak_early', 'ak_late'])
    expect(aside.map((e) => e.ref)).toEqual(['ak_away'])
  })
})
