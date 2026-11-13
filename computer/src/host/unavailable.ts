// A failure of the host that the person who asked is told as it is (work 103):
// the computer cannot serve this call now, and why. Anything else a `/files`
// call or a terminal open throws reaches the client as `internal`, with no
// words of the host's.
//
// Invariants:
// - The message is written for the person: it never carries a path, a
//   command or an id.
// - `retryable` is true when the same call may succeed a little later.

import type { ApiError } from '../protocol.js';
import { apiError } from '../api/writer.js';

export class Unavailable extends Error {
  constructor(message: string, readonly retryable = true) {
    super(message);
    this.name = 'Unavailable';
  }
}

/** What an image pull or warm-up in progress makes of a call that cannot wait for it (sandbox/image-lock.ts). */
export const UPDATING = 'The computer is updating, try again in a few minutes.';

/** `e` as the API says it: `unavailable` 503 for an Unavailable, undefined for anything else. */
export const unavailable = (e: unknown): ApiError | undefined =>
  e instanceof Unavailable ? apiError('unavailable', e.message, 503, { retryable: e.retryable }) : undefined;
