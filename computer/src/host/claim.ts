// A new session's runner from the warm pool (work 069): take a parked spare
// whose Claude credential matches the delivery's, make the session's fork,
// then `claim` the spare into it. Anything short of a claimed spare falls back
// to a cold start, in the fork when it was made.
//
// Invariants: the spare is claimed only after the fork is complete, since its
// Claude Code reads the fork's AGENTS.md and skills when claimed. A spare that
// refused or did not answer is discarded, never offered again: it may have
// claimed late, so it is not known to be parked. One whose fork failed was
// never spoken to, so it goes back to the pool.

import type { MissReason } from './pool.js';

export type ClaimMiss = MissReason | 'refused' | 'timeout' | 'gone';

export interface ClaimSteps<R> {
  /** A parked spare, now ours; else why there is none. */
  take: () => R | MissReason;
  /** Make the session's fork; resolves with its path. */
  fork: () => Promise<string>;
  /** Claim the spare into the fork; rejects if it refused or did not answer in time. */
  claim: (r: R, forkPath: string) => Promise<void>;
  /** Tell a spare that was not claimed to exit. */
  discard: (r: R) => void;
  /** Put a spare nothing was sent to back in the pool; discarded when absent. */
  release?: (r: R) => void;
}

export type ClaimOutcome<R> = { runner: R; forkPath: string } | { missed: ClaimMiss; forkPath?: string };

/** Whether `call`'s rejection was its timeout, or the runner's exit, rather than the runner's refusal. */
export const isTimeout = (e: unknown) => /did not answer/.test(String((e as Error)?.message ?? e));
export const isGone = (e: unknown) => /runner gone/.test(String((e as Error)?.message ?? e));

export async function claimSpare<R>(s: ClaimSteps<R>): Promise<ClaimOutcome<R>> {
  const taken = s.take();
  if (taken === 'none' || taken === 'credential') return { missed: taken as MissReason };
  const r = taken as R;
  let forkPath: string;
  try {
    forkPath = await s.fork();
  } catch (e) {
    (s.release ?? s.discard)(r);
    throw e;
  }
  try {
    await s.claim(r, forkPath);
    return { runner: r, forkPath };
  } catch (e) {
    s.discard(r);
    return { missed: isTimeout(e) ? 'timeout' : isGone(e) ? 'gone' : 'refused', forkPath };
  }
}
