// A request from the host to one of its runners that waits for the runner's
// `reply` (deliver, action, stop, claim): moved out of host/main.ts unchanged.
//
// Invariants: every call is answered once, by the runner's reply, by its
// socket closing (main fails the pending calls then), or by the timeout; a
// call to a runner whose socket is gone fails at once rather than waiting.

import { randomUUID } from 'node:crypto';
import type net from 'node:net';
import type { Delivery, RunnerApi, SessionSpec, TraceContext } from '../protocol.js';
import { send } from '../ipc.js';

export type RunnerCall =
  | { t: 'deliver'; msg: Delivery; trace?: TraceContext }
  | { t: 'action'; promptId: string; value: string; userId: string }
  | { t: 'stop' }
  | { t: 'claim'; session: SessionSpec & { forkPath: string }; api?: RunnerApi };

export interface Callable {
  sock: net.Socket;
  calls: Map<string, (r: { ok: boolean; error?: string }) => void>;
}

/** Send a request to a runner and wait for its reply. */
export function callRunner(r: Callable, m: RunnerCall, timeoutMs = 60_000) {
  if (r.sock.destroyed) return Promise.reject(new Error('runner gone')); // sending would be silent; a claim must not wait out its timeout
  const id = randomUUID();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => done({ ok: false, error: `runner did not answer ${m.t}` }), timeoutMs);
    const done = (x: { ok: boolean; error?: string }) => {
      clearTimeout(timer);
      r.calls.delete(id);
      x.ok ? resolve() : reject(new Error(x.error ?? 'failed'));
    };
    r.calls.set(id, done);
    send(r.sock, { ...m, id });
  });
}
