// When the host takes on a runner connection: registers it, follows its
// messages, sends it `credentials` and lets deliveries reach it, after which
// the runner's harness may start in its fork.
//
// Invariant: a runner is never taken on while its fork is incomplete. A cold
// start connects only once the fork is complete (cold-start.ts), so it takes
// on at once, as does a spare the host launched (work 069; it has no fork). A
// runner found already running (after a host restart) is `verify`-ed: taken
// on at its first message, a report naming its session and fork or a spare's
// state; or stopped if that fork is incomplete (the previous host died
// mid-fork), and the next delivery then cold-starts and finishes the fork. A
// runner says which session it serves only in its report (its socket is named
// by its id), so one that never reports is stopped after `timeoutMs`.

import type { RunnerToHost } from '../protocol.js';

/** The message a verified runner was taken on with: it names the session, or says it is a spare. */
export type First = Extract<RunnerToHost, { t: 'report' } | { t: 'spare' }>;

export interface AdoptionSteps {
  verify: boolean;
  /** Whether the fork at this path is complete. */
  complete: (forkPath: string | undefined) => boolean;
  /** Take it on; `first` when verified. */
  take: (first?: First) => void;
  /** Tell the runner to exit: its fork is incomplete, or it never said what it is. */
  stop: (why: string) => void;
  /** The connection closed before the runner was taken on or stopped. */
  gone: () => void;
  timeoutMs?: number;
}

export function adoption(s: AdoptionSteps) {
  let state: 'pending' | 'taken' | 'stopped' = 'pending';
  const take = (first?: First) => {
    if (state !== 'pending') return;
    state = 'taken';
    s.take(first);
  };
  const stop = (why: string) => {
    if (state !== 'pending') return;
    state = 'stopped';
    s.stop(why);
  };
  if (!s.verify) take();
  else setTimeout(() => stop('it did not report within the adoption timeout'), s.timeoutMs ?? 5000).unref();
  return {
    get state() {
      return state;
    },
    /** A message from the runner; true if the host should handle it (telemetry always, the rest once taken on). */
    message(m: RunnerToHost): boolean {
      if (state === 'pending' && m.t === 'report' && !s.complete(m.report.forkPath)) {
        stop(`its fork ${m.report.forkPath} is incomplete`);
        return false;
      }
      if (state === 'pending' && (m.t === 'report' || m.t === 'spare')) take(m);
      return state === 'taken' || (state === 'pending' && m.t === 'telemetry');
    },
    closed() {
      if (state !== 'pending') return;
      state = 'stopped';
      s.gone();
    },
  };
}
