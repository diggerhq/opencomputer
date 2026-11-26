import { describe, expect, it } from 'vitest'
import type { MachineRow, PlaceRow, SessionRow } from '@opencomputer/sdk/computer'
import { Draft, emptyRows, type Rows } from './rows'
import { threadView } from './views'

// A brand-new organization's first message waits minutes for its machine to be made; the thread
// must say so rather than show "working" with nothing under it.

const SID = 'cs_0000000000000001'
const ORG = '7d046331-d0b8-45e4-a159-bf95f4812d9f'

function session(over: Partial<SessionRow> = {}): SessionRow {
  return {
    kind: 'session',
    id: SID,
    version: 1,
    title: 'ok lets see which repos can we see',
    status: 'starting',
    lastSeq: 0,
    lastText: null,
    lastTurn: null,
    lastAgentSeq: 0,
    asks: [],
    blocked: false,
    inbox: [],
    machine: ORG,
    ...over,
  } as unknown as SessionRow
}

const place = { kind: 'place', id: SID, version: 1, sessionId: SID, trackId: null, position: 1, doneAt: null, earlierAt: null, keep: false, attention: null, readySeq: null } as unknown as PlaceRow
const machine = (state: string, id = ORG) => ({ kind: 'machine', id, version: 1, state, revision: 1 }) as MachineRow

function rowsOf(...rows: (SessionRow | PlaceRow | MachineRow)[]): Rows {
  const d = new Draft(emptyRows())
  for (const r of rows) d.set(r)
  return d.done()
}

describe('threadView: a thread waiting on its machine', () => {
  it('says the computer is being set up while the machine is provisioning', () => {
    const v = threadView(rowsOf(session(), place, machine('provisioning')), 'usr_me', SID)!
    expect(v.mark).toBe('working')
    expect(v.waiting).toMatch(/Setting up your computer/)
    expect(v.line).toBe(v.waiting)
  })

  it('names the machine of an optimistic row, which does not know its machine yet', () => {
    expect(threadView(rowsOf(session({ machine: '' }), place, machine('waking')), 'usr_me', SID)!.waiting).toBe('Waking your computer')
  })

  it('says the computer could not start when it failed', () => {
    expect(threadView(rowsOf(session(), place, machine('failed')), 'usr_me', SID)!.waiting).toBe('Your computer could not start')
  })

  it('says nothing once the machine is up or the thread has begun', () => {
    expect(threadView(rowsOf(session(), place, machine('ready')), 'usr_me', SID)!.waiting).toBeNull()
    expect(threadView(rowsOf(session({ status: 'running', lastSeq: 3 }), place, machine('provisioning')), 'usr_me', SID)!.waiting).toBeNull()
    expect(threadView(rowsOf(session(), place), 'usr_me', SID)!.waiting).toBeNull()
  })

  it('updates when only the machine row changes', () => {
    const first = rowsOf(session(), place, machine('provisioning'))
    const before = threadView(first, 'usr_me', SID)!
    const d = new Draft(first)
    d.set(machine('ready'))
    const after = threadView(d.done(), 'usr_me', SID)!
    expect(before.waiting).not.toBeNull()
    expect(after.waiting).toBeNull()
  })
})
