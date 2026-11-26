import { expect, it } from 'vitest'
import { SessionSchema } from '../computer-sessions-api'

const session = {
  id: 'cs_1',
  title: null,
  status: 'idle',
  archived: false,
  owner: null,
  origin: { type: 'dashboard' },
  settings: { model: null, effort: null, mode: null },
  activeTurnId: null,
  asks: [],
  lastText: null,
  lastSeq: 0,
  createdAt: '2026-11-26T00:00:00Z',
  lastActiveAt: null,
}

it('shows a terminal only when the API says you may open one (owner first)', () => {
  expect(SessionSchema.parse(session).canOpenTerminal).toBeUndefined()
  expect(
    SessionSchema.parse({ ...session, canOpenTerminal: false }).canOpenTerminal,
  ).toBe(false)
  expect(
    SessionSchema.parse({ ...session, canOpenTerminal: true }).canOpenTerminal,
  ).toBe(true)
})
