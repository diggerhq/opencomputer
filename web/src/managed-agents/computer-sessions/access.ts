import type {
  AccessInput,
  AccessMode,
  SessionAccess,
} from '../computer-sessions-api'

// Who may read and drive a session, as the dashboard shows and changes it.
// The server decides every request; these only shape the controls.

export const MODE_LABEL: Record<AccessMode, string> = {
  owner: 'Only me',
  org: 'Whole organization',
  people: 'Specific people',
}

/** The short label on a session: who besides the owner can get in. */
export function accessLabel(
  a: SessionAccess,
  { isOwner, nameOf }: { isOwner: boolean; nameOf: (id: string) => string },
): string {
  if (a.mode === 'org') return 'Whole organization'
  if (a.mode === 'owner' || !a.people.length)
    return isOwner ? 'Only me' : 'Owner only'
  if (a.people.length === 1) return `Shared with ${nameOf(a.people[0])}`
  return `Shared with ${a.people.length} people`
}

/**
 * The form sent: `people` without duplicates or the owner, sorted, and only
 * for `people`; `people` naming nobody is `owner`.
 */
export function normalizeAccess(
  next: AccessInput,
  ownerIds: readonly string[] = [],
): AccessInput {
  if (next.mode !== 'people') return { mode: next.mode }
  const people = [...new Set(next.people ?? [])]
    .filter((id) => !ownerIds.includes(id))
    .sort()
  return people.length ? { mode: 'people', people } : { mode: 'owner' }
}

export function sameAccess(a: AccessInput, b: AccessInput): boolean {
  const x = normalizeAccess(a)
  const y = normalizeAccess(b)
  return (
    x.mode === y.mode && (x.people ?? []).join() === (y.people ?? []).join()
  )
}

/**
 * Whether `next` lets in anyone `prev` did not: the change that hands the
 * owner's secrets and subscription to more people, so it is confirmed first.
 * No `prev` (a new session): any sharing at all.
 */
export function widens(prev: AccessInput | undefined, next: AccessInput) {
  const n = normalizeAccess(next)
  if (n.mode === 'owner') return false
  if (!prev) return true
  const p = normalizeAccess(prev)
  if (p.mode === 'org') return false
  if (n.mode === 'org') return true
  return (n.people ?? []).some((id) => !(p.people ?? []).includes(id))
}

/** `a` with `id` let in: how an admin adds themselves to get in (Q4). */
export function withPerson(a: AccessInput, id: string): AccessInput {
  if (a.mode === 'org') return { mode: 'org' }
  return normalizeAccess({ mode: 'people', people: [...(a.people ?? []), id] })
}

/** The Q6 warning, for a change that lets more people in. */
export function shareWarning(isOwner: boolean) {
  return isOwner
    ? 'Anyone who can drive this session runs it as you: with your secrets, your connections and your model subscription.'
    : 'Anyone who can drive this session runs it as its owner: with their secrets, their connections and their model subscription.'
}
