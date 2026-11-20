import { useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  getCapabilities,
  sessionKeys,
  type Ask,
  type ListSessionsQuery,
  type Session,
} from '../computer-sessions-api'
import { approvalLine, isPlan } from './ask-line'

export const NEEDS_YOU: ListSessionsQuery = { status: 'waiting', limit: 50 }
export const WORKING: ListSessionsQuery = {
  status: 'starting,running',
  limit: 50,
}

export const isBusy = (status: string) =>
  status === 'running' || status === 'starting'

export function statusLabel(status: string) {
  switch (status) {
    case 'waiting':
      return 'Needs you'
    case 'running':
      return 'Working'
    case 'starting':
      return 'Starting'
    case 'suspended':
      return 'Asleep'
    default:
      return 'Idle'
  }
}

export function askTitle(ask: Ask): string {
  if (ask.kind === 'approval') {
    if (isPlan(ask)) return 'Has a plan to review'
    const line = approvalLine(ask)
    const lower = /^[A-Z][a-z]/.test(line)
      ? line[0].toLowerCase() + line.slice(1)
      : line
    return `Wants to ${lower}`
  }
  if (ask.kind === 'question') {
    const q = ask.question?.questions[0]
    return q?.text || q?.header || 'Has a question'
  }
  if (ask.kind === 'secret') {
    const name = (ask.secret as { name?: string } | null)?.name
    return name ? `Needs the secret ${name}` : 'Needs a secret'
  }
  return 'Needs you'
}

// The one line under a session's title: what it is waiting on, else the last
// thing it said.
export function sessionLine(s: Session): string {
  const ask = s.asks.find((a) => a.status === 'open') ?? s.asks[0]
  if (s.status === 'waiting' && ask) return askTitle(ask)
  return (s.lastText ?? '').replace(/\s+/g, ' ').trim()
}

export function sessionTitle(s: Session) {
  return s.title?.trim() || 'Untitled session'
}

// Last seq read per session, kept in this browser. A session is unread when it
// moved past what was read, or when it moved since this browser first looked
// and was never opened here.
const SEEN_KEY = 'computer-sessions-seen'
type Seen = { since: string; seq: Record<string, number> }
const listeners = new Set<() => void>()
let seenCache: Seen | null = null

function readSeen(): Seen {
  if (seenCache) return seenCache
  try {
    const raw = localStorage.getItem(SEEN_KEY)
    if (raw) seenCache = JSON.parse(raw) as Seen
  } catch {
    // ignore: a broken entry starts over
  }
  if (!seenCache?.seq) {
    seenCache = { since: new Date().toISOString(), seq: {} }
    localStorage.setItem(SEEN_KEY, JSON.stringify(seenCache))
  }
  return seenCache
}

export function markSeen(id: string, seq: number) {
  const seen = readSeen()
  if ((seen.seq[id] ?? -1) >= seq) return
  seenCache = { ...seen, seq: { ...seen.seq, [id]: seq } }
  localStorage.setItem(SEEN_KEY, JSON.stringify(seenCache))
  listeners.forEach((l) => l())
}

export function useSeen(): Seen {
  return useSyncExternalStore((l) => {
    listeners.add(l)
    return () => listeners.delete(l)
  }, readSeen)
}

export function isUnread(s: Session, seen: Seen) {
  const read = seen.seq[s.id]
  if (read !== undefined) return s.lastSeq > read
  return !!s.lastActiveAt && s.lastActiveAt > seen.since
}

export function useCapabilities() {
  return useQuery({
    queryKey: sessionKeys.capabilities,
    queryFn: getCapabilities,
    staleTime: 5 * 60_000,
  })
}
