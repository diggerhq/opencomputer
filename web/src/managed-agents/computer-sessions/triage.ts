import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  listSessions,
  sessionKeys,
  type Ask,
  type ListSessionsQuery,
  type Session,
} from '../computer-sessions-api'
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

export type TriageEntry = {
  /** The ask's id: what Set aside stores, and what the screen selects by. */
  ref: string
  session: Session
  ask: Ask
  /** The ask in one line, the screen's headline. */
  line: string
  /** When the ask opened. */
  at: string
  aside: boolean
}

/** The session's ask for triage: its oldest open ask, or null when none is open. */
export function triageEntry(s: Session): TriageEntry | null {
  const ask = s.asks
    .filter((a) => a.status === 'open')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]
  if (!ask) return null
  return {
    ref: ask.id,
    session: s,
    ask,
    line: askTitle(ask),
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
