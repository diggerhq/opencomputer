// Waking a session's runner for a send the host's writer queued, or an attach's
// `resume` (work 084).
// The host always asks the gateway (`wake`), whose `start` brings the runner,
// which runs the queued turns. Even when the host knows the session's spec it
// does not start the runner itself: only the gateway has the session's vault
// secrets, and they must reach the runner with its start, since a `secrets`
// frame for a session with no runner is dropped (host/main.ts).
//
// Invariants:
// - One `wake` per session in flight; its queued turns fail (`runtime_failed`)
//   when no runner took the session within `waitMs`, or at once when the
//   gateway cannot be reached, so a client never waits on them forever.
// - A runner minted for the session (`woken`) answers the wake.

import type { HostToGateway } from '../protocol.js';
import { log } from '../log.js';

export const WAKE_WAIT_MS = 60_000;
const DID_NOT_START = 'The agent did not start';

export interface WakeDeps {
  send(m: HostToGateway): boolean;
  /** Fail the session's queued turns, when the host's writer still has it. */
  failQueued(sessionId: string, message: string): void;
  waitMs?: number;
}

export function apiWake(d: WakeDeps) {
  const waking = new Map<string, ReturnType<typeof setTimeout>>();

  function woken(sessionId: string) {
    clearTimeout(waking.get(sessionId));
    waking.delete(sessionId);
  }

  function failed(sessionId: string, message = DID_NOT_START) {
    woken(sessionId);
    log.warn(`wake ${sessionId}: ${message}`);
    d.failQueued(sessionId, message);
  }

  /**
   * The session's writer asked for its runner (a send while none ran), or an attach resumes it; the runner takes the
   * turns it queued from the journal. False: the gateway could not be reached.
   */
  function wake(sessionId: string): boolean {
    if (waking.has(sessionId)) return true;
    if (!d.send({ t: 'wake', sessionId })) {
      failed(sessionId, 'The computer could not reach the gateway to start the agent');
      return false;
    }
    const t = setTimeout(() => failed(sessionId), d.waitMs ?? WAKE_WAIT_MS);
    t.unref?.();
    waking.set(sessionId, t);
    return true;
  }

  return {
    wake,
    woken,
    failed,
    stop() {
      for (const t of waking.values()) clearTimeout(t);
      waking.clear();
    },
  };
}
