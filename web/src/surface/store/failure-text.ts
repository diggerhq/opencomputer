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

const SAID: Partial<Record<string, string>> = {
  'thread.done': 'Could not mark it done',
  'thread.place': 'Could not move it',
  'thread.rename': 'Could not rename it',
  'track.create': 'Could not make the track',
  'doc.save': 'Could not save the Doc',
  undo: 'Could not undo that',
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
