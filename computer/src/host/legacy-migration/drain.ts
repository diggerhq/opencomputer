// ONE-TIME systemd->podman migration (work 103). Delete together with the systemd launch path in step 11.
//
// Drain-then-flip, on a `systemd` host: told to (SIGUSR2, from provision.sh
// when the release's SP_LAUNCH turns from systemd to podman), the host tells
// every runner to exit after its turn, starts nothing new and exits once no
// runner is left, or at the deadline. Its unit's `Restart=` brings it back
// with the new SP_LAUNCH, as a `podman` host, and each thread's next delivery
// migrates it there (migrate.ts).
//
// Invariants:
// - Nothing is cut: a runner ends its turn and its subagents first (runner
//   main.ts `exit`). Only at the deadline is a runner still busy told to go
//   now, and the host leaves `graceMs` later whatever is left.
// - No delivery reaches a runner once the drain began: `held()` never settles,
//   so the delivery is the gateway's again when the host's socket closes, and
//   it sends it to the next host.
// - A runner that connects after the drain began (a start already under way)
//   is told to exit too, at the next tick.

import type net from 'node:net';
import { log } from '../../log.js';
import type { HostToRunner } from '../../protocol.js';

export const DRAIN_DEADLINE_MS = 10 * 60_000;
const TICK_MS = 1000;
const GRACE_MS = 10_000;

export interface DrainDeps {
  /** Every connected runner, the spares too. */
  runners(): Iterable<{ id: string; sock: net.Socket }>;
  send(sock: net.Socket, m: HostToRunner): void;
  /** The host's own shutdown (main.ts): its unit restarts it. */
  exit(): void;
  deadlineMs?: number;
  graceMs?: number;
  tickMs?: number;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
}

export function legacyDrain(d: DrainDeps) {
  const deadlineMs = d.deadlineMs ?? DRAIN_DEADLINE_MS;
  const graceMs = d.graceMs ?? GRACE_MS;
  const now = d.now ?? Date.now;
  const every = d.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const told = new WeakSet<net.Socket>();
  let since: number | undefined;
  let forced = false;
  let done = false;

  function tick() {
    if (done || since === undefined) return;
    const left = [...d.runners()];
    if (left.length === 0) return finish('no runner left');
    const late = now() - since >= deadlineMs;
    for (const r of left) {
      if (late && !forced) d.send(r.sock, { t: 'exit', ms: 0 } satisfies HostToRunner);
      else if (!told.has(r.sock)) d.send(r.sock, { t: 'exit' } satisfies HostToRunner);
      told.add(r.sock);
    }
    if (late && !forced) {
      forced = true;
      log.warn(`legacy drain: deadline, ${left.length} runner(s) told to exit now: ${left.map((r) => r.id).join(' ')}`);
    }
    if (now() - since >= deadlineMs + graceMs) finish(`${left.length} runner(s) still connected`);
  }

  function finish(why: string) {
    done = true;
    log.info(`legacy drain: exiting after ${Math.round((now() - (since ?? now())) / 1000)} s (${why})`);
    d.exit();
  }

  return {
    get draining() {
      return since !== undefined;
    },
    /** What a delivery gets while draining: a promise that never settles (the gateway redelivers to the next host). */
    held: <T>() => new Promise<T>(() => {}),
    start() {
      if (since !== undefined) return;
      since = now();
      log.info(`legacy drain: telling every runner to exit after its turn; leaving when none is left or in ${Math.round(deadlineMs / 1000)} s`);
      tick();
      if (!done) (every(tick, d.tickMs ?? TICK_MS) as { unref?: () => void })?.unref?.();
    },
    tick,
  };
}
