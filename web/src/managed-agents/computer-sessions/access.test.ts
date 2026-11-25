import { describe, expect, it } from 'vitest'
import { SessionSchema } from '../computer-sessions-api'
import {
  accessLabel,
  normalizeAccess,
  sameAccess,
  widens,
  withPerson,
} from './access'
import { orgPeople } from './members'

const nameOf = (id: string) => (id === 'usr_a' ? 'Ana' : id)

describe('accessLabel', () => {
  it('names who besides the owner gets in', () => {
    const label = (mode: 'owner' | 'org' | 'people', people: string[] = []) =>
      accessLabel({ mode, people }, { isOwner: true, nameOf })
    expect(label('owner')).toBe('Only me')
    expect(label('org')).toBe('Whole organization')
    expect(label('people', ['usr_a'])).toBe('Shared with Ana')
    expect(label('people', ['usr_a', 'usr_b'])).toBe('Shared with 2 people')
    expect(
      accessLabel({ mode: 'owner', people: [] }, { isOwner: false, nameOf }),
    ).toBe('Owner only')
  })
})

describe('normalizeAccess', () => {
  it('dedupes, drops the owner and sorts people', () => {
    expect(
      normalizeAccess(
        { mode: 'people', people: ['usr_b', 'usr_o', 'usr_a', 'usr_b'] },
        ['usr_o'],
      ),
    ).toEqual({ mode: 'people', people: ['usr_a', 'usr_b'] })
  })
  it('makes people naming nobody owner-only, and drops people elsewhere', () => {
    expect(normalizeAccess({ mode: 'people', people: [] })).toEqual({
      mode: 'owner',
    })
    expect(normalizeAccess({ mode: 'org', people: ['usr_a'] })).toEqual({
      mode: 'org',
    })
  })
  it('compares normalized forms', () => {
    expect(
      sameAccess(
        { mode: 'people', people: ['usr_b', 'usr_a'] },
        { mode: 'people', people: ['usr_a', 'usr_b'] },
      ),
    ).toBe(true)
    expect(sameAccess({ mode: 'owner' }, { mode: 'people', people: [] })).toBe(
      true,
    )
    expect(sameAccess({ mode: 'owner' }, { mode: 'org' })).toBe(false)
  })
})

describe('widens (confirm before sharing, Q6)', () => {
  it('is true when anyone new gets in', () => {
    expect(widens({ mode: 'owner' }, { mode: 'org' })).toBe(true)
    expect(
      widens({ mode: 'owner' }, { mode: 'people', people: ['usr_a'] }),
    ).toBe(true)
    expect(
      widens(
        { mode: 'people', people: ['usr_a'] },
        { mode: 'people', people: ['usr_a', 'usr_b'] },
      ),
    ).toBe(true)
    expect(widens({ mode: 'people', people: ['usr_a'] }, { mode: 'org' })).toBe(
      true,
    )
    expect(widens(undefined, { mode: 'org' })).toBe(true)
  })
  it('is false when access only narrows or stays', () => {
    expect(widens({ mode: 'org' }, { mode: 'owner' })).toBe(false)
    expect(widens({ mode: 'org' }, { mode: 'people', people: ['usr_a'] })).toBe(
      false,
    )
    expect(
      widens(
        { mode: 'people', people: ['usr_a', 'usr_b'] },
        { mode: 'people', people: ['usr_a'] },
      ),
    ).toBe(false)
    expect(widens(undefined, { mode: 'owner' })).toBe(false)
  })
})

describe('withPerson', () => {
  it('lets one more person in', () => {
    expect(withPerson({ mode: 'owner' }, 'usr_me')).toEqual({
      mode: 'people',
      people: ['usr_me'],
    })
    expect(withPerson({ mode: 'people', people: ['usr_a'] }, 'usr_me')).toEqual(
      { mode: 'people', people: ['usr_a', 'usr_me'] },
    )
    expect(withPerson({ mode: 'org' }, 'usr_me')).toEqual({ mode: 'org' })
  })
})

describe('orgPeople', () => {
  it('sends the WorkOS-derived id and knows the hashed one', async () => {
    const [p] = await orgPeople([
      {
        id: 'u1',
        workosUserId: 'user_01ABC',
        email: 'a@x.dev',
        name: 'Ana',
        role: 'admin',
      },
    ])
    expect(p.id).toBe('usr_01abc')
    expect(p.ids).toHaveLength(2)
    expect(p.ids[1]).toMatch(/^usr_x[0-9a-f]{26}$/)
    expect(p.admin).toBe(true)
  })
  it('falls back to the hashed id', async () => {
    const [p] = await orgPeople([
      { id: 'u2', email: 'b@x.dev', name: '', role: 'member' },
    ])
    expect(p.id).toMatch(/^usr_x/)
    expect(p.admin).toBe(false)
  })
})

describe('SessionSchema', () => {
  const base = {
    id: 'cs_1',
    title: null,
    status: 'idle',
    archived: false,
    owner: null,
    origin: { type: 'web' },
    settings: { model: null, effort: null, mode: null },
    activeTurnId: null,
    asks: [],
    lastText: null,
    lastSeq: 0,
    createdAt: '2026-11-25T00:00:00Z',
    lastActiveAt: null,
  }
  it('reads access and canManageAccess', () => {
    const s = SessionSchema.parse({
      ...base,
      access: { mode: 'people', people: ['usr_a'] },
      canManageAccess: true,
    })
    expect(s.access).toEqual({ mode: 'people', people: ['usr_a'] })
    expect(s.canManageAccess).toBe(true)
  })
  it('accepts a session without them', () => {
    expect(SessionSchema.parse(base).access).toBeUndefined()
  })
})
