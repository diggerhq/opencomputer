import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  listSessions,
  sessionKeys,
  type Ask,
  type ListSessionsQuery,
  type Session,
} from '../computer-sessions-api'
import { approvalLine } from './ask-line'
import { askTitle } from './state'

// What triage shows (work-tracking, ux-spec 3): the caller's own sessions
// that wait on them, one ask each. For now an ask is a session's oldest open
// ask, found from the session list. When sessions carry `attention` (tech
// design 3.7), this file is the one place that changes: the query asks for
// attention instead of `waiting`, and `triageEntry` reads `attention.ref` and
// its headline instead of the oldest open ask.

export const TRIAGE_NEEDS: ListSessionsQuery = {
  owner: 'me',
  status: 'waiting',
  limit: 50,
}
export const TRIAGE_WORKING: ListSessionsQuery = {
  owner: 'me',
  status: 'starting,running',
  limit: 50,
}

/** What the person is asked for; decides the answer dock's shape. */
export type TriageKind = 'approval' | 'question' | 'secret' | 'reply'

export type TriageEntry = {
  /** The ask's id: what Set aside stores, and what the screen selects by. */
  ref: string
  session: Session
  /** The open ask; null when the session needs a reply to plain text. */
  ask: Ask | null
  kind: TriageKind
  /** The ask in one line, the screen's headline. */
  line: string
  /** When the ask opened. */
  at: string
  aside: boolean
}

const KINDS = new Set(['approval', 'question', 'secret'])

/** The ask in one line, as triage heads it. */
export function askLine(ask: Ask): string {
  return ask.kind === 'approval' ? approvalLine(ask) : askTitle(ask)
}

// Tech design 3.7, read ahead of the server: a session whose last turn ended
// in text that needs its person. Absent today; the schema is loose.
type Attention = {
  reason?: string
  ref?: string
  line?: string | null
  at?: string
}

/** The session's ask for triage: its oldest open ask, or null when none is open. */
export function triageEntry(s: Session): TriageEntry | null {
  const ask = s.asks
    .filter((a) => a.status === 'open')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
  if (!ask) {
    const att = (s as { attention?: Attention | null }).attention
    if (!att?.ref || (att.reason !== 'reply' && att.reason !== 'failed'))
      return null
    return {
      ref: att.ref,
      session: s,
      ask: null,
      kind: 'reply',
      line: att.line || 'Needs a reply',
      at: att.at ?? s.lastActiveAt ?? s.createdAt,
      aside: s.aside,
    }
  }
  return {
    ref: ask.id,
    session: s,
    ask,
    kind: KINDS.has(ask.kind) ? (ask.kind as TriageKind) : 'reply',
    line: askLine(ask),
    at: ask.createdAt,
    aside: s.aside,
  }
}

/** Asks oldest first, split into those that need you and those set aside. */
export function triageEntries(sessions: Session[]) {
  const all = sessions
    .map(triageEntry)
    .filter((e): e is TriageEntry => e !== null)
    .sort((a, b) => a.at.localeCompare(b.at))
  return {
    needs: all.filter((e) => !e.aside),
    aside: all.filter((e) => e.aside),
  }
}

export function useTriage() {
  const needs = useQuery({
    queryKey: sessionKeys.list(TRIAGE_NEEDS),
    queryFn: () => listSessions(TRIAGE_NEEDS),
    refetchInterval: 5_000,
  })
  const working = useQuery({
    queryKey: sessionKeys.list(TRIAGE_WORKING),
    queryFn: () => listSessions(TRIAGE_WORKING),
    refetchInterval: 5_000,
  })
  // Kept while the list is unchanged, so an entry's identity says whether it moved.
  const entries = useMemo(
    () => triageEntries(needs.data?.sessions ?? []),
    [needs.data],
  )
  return {
    ...entries,
    working: working.data?.sessions ?? [],
    loaded: needs.isSuccess,
  }
}

/** The rail's badge: asks that need you, set-aside ones not counted. */
export function useTriageCount(enabled = true) {
  const { data } = useQuery({
    queryKey: sessionKeys.list(TRIAGE_NEEDS),
    queryFn: () => listSessions(TRIAGE_NEEDS),
    refetchInterval: 15_000,
    enabled,
  })
  return triageEntries(data?.sessions ?? []).needs.length
}
