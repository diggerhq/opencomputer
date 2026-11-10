// Waking a session's runner for a send the host's writer queued (work 084).
// The host knows a session's spec only from the gateway's frames since it
// booted; for one it has none of, it asks the gateway (`wake`), whose `start`
// brings the runner, which runs the queued turns.
//
// Invariants:
// - One `wake` per session in flight; its queued turns fail (`runtime_failed`)
//   when no runner took the session within `waitMs`, or at once when the
//   gateway cannot be reached, so a client never waits on them forever.
// - A runner minted for the session (`woken`) answers the wake.

import type { ApiDelivery, Delivery, HostToGateway, SessionSpec } from '../protocol.js';
import { log } from '../log.js';
import type { StartOptions } from './api-host.js';

export const WAKE_WAIT_MS = 60_000;
const DID_NOT_START = 'The agent did not start';

export interface WakeDeps {
  spec(sessionId: string): SessionSpec | undefined;
  send(m: HostToGateway): boolean;
  start(spec: SessionSpec, o: StartOptions): Promise<unknown>;
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

  /** The session's writer asked for its runner (a send or resume while none ran). */
  function wake(sessionId: string, delivery?: ApiDelivery) {
    const spec = d.spec(sessionId);
    if (!spec) {
      if (waking.has(sessionId)) return;
      if (!d.send({ t: 'wake', sessionId })) return failed(sessionId, 'The computer could not reach the gateway to start the agent');
      const t = setTimeout(() => failed(sessionId), d.waitMs ?? WAKE_WAIT_MS);
      t.unref?.();
      waking.set(sessionId, t);
      return;
    }
    const msg: Delivery | undefined = delivery && { userId: delivery.member, text: '', ts: '', api: delivery };
    void d.start(spec, { msg }).catch((e) => failed(sessionId, `${DID_NOT_START}: ${e?.message ?? e}`));
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
