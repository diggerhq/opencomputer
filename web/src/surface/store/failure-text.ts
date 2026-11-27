import type { Failure, Pending } from '@opencomputer/sdk/computer'

// How a refused write is told to the person (R42): what did not go through,
// and why.

// What a refusal's code means to the person, when the server gave no reason.
const CODES: Record<string, string> = {
  insufficient_credits: 'you are out of credits',
  http_402: 'you are out of credits',
  session_not_found: 'this thread no longer exists',
  computer_unavailable: 'your computer is not reachable right now',
  unavailable: 'the service is not reachable right now',
  workspace_unavailable: 'your computer is not reachable right now',
  forbidden: 'you do not have access to this',
  http_403: 'you do not have access to this',
  unauthenticated: 'you are signed out',
  http_401: 'you are signed out',
  turn_in_progress: 'the agent is still working',
  inbox_full: 'too many messages are waiting; try again when the agent catches up',
  too_large: 'it is too long',
  http_413: 'it is too long',
  rate_limited: 'too many requests; try again in a moment',
  model_unavailable: 'that model is not available',
  unsupported_model: 'that model is not available',
  unsupported_effort: 'that effort is not available for this model',
  unsupported_mode: 'that mode is not available',
  conflict: 'it changed meanwhile',
  not_found: 'it no longer exists',
  internal: 'something went wrong on our side',
}

export const OUT_OF_CREDITS = new Set(['insufficient_credits', 'http_402'])
export function sayFailure(f: Pick<Failure, 'code' | 'reason'>): string {
  return f.reason || CODES[f.code] || f.code
}

// Why a pull request was not merged, or its merge not reverted (work 118).
const MERGE: Record<string, string> = {
  changed: 'it changed since you looked',
  conflicts: 'it conflicts with its base branch',
  draft: 'it is a draft',
  closed: 'it is closed',
  not_merged: 'it is not merged',
  stale: 'that click was a while ago, so merge again if you still mean it',
  checks_failing: 'a check did not pass',
  checks_running: 'its checks are still running',
  merging: 'someone else is merging it',
  writers_only: 'only people who can write to this thread can merge it',
  github_not_connected: 'GitHub is not connected',
}
export function sayMergeFailure(f: Pick<Failure, 'code' | 'reason' | 'detail'>): string {
  const { message, check } = (f.detail ?? {}) as { message?: unknown; check?: unknown }
  if (f.reason === 'checks_failing' && typeof check === 'string') return `its check “${check}” did not pass`
  if (f.reason === 'checks_running' && typeof check === 'string') return `its check “${check}” is still running`
  const said = MERGE[f.reason] ?? MERGE[f.code]
  if (said) return said
  // GitHub's own words: a rule of the repository, a failing required check.
  if (f.reason === 'blocked' && typeof message === 'string') return `GitHub said “${message.replace(/\.$/, '')}”`
  return sayFailure(f)
}

const SAID: Partial<Record<string, string>> = {
  'thread.done': 'Could not mark it done',
  'thread.place': 'Could not move it',
  'thread.rename': 'Could not rename it',
  'track.create': 'Could not make the track',
  'doc.save': 'Could not save the Doc',
  undo: 'Could not undo that',
  'result.merge': 'Not merged',
  'result.revert': 'Could not revert the merge',
}
// What did not go through, as the start of the toast.
export function whatFailed(e: Pending): string {
  return e.kind === 'mutation'
    ? (SAID[e.name] ?? 'That did not go through')
    : e.kind === 'turn' || e.kind === 'session'
      ? 'Your message was not sent'
      : e.kind === 'settings'
        ? 'Could not change the settings'
        : 'That did not go through'
}
