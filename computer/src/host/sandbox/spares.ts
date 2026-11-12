// Spares on a `podman` host (work 103, step 10): containers made ahead of
// time, each with a runner that parks a Claude Code, so a new thread's first
// message skips Create, Start and the harness's start. `launch` tops the pool
// up (pool.ts decides when), `bind` makes a taken spare one thread's (the
// claim's "fork" step, claim.ts), `gone` and `discard` are "a spare leaves".
//
// Invariants:
// - A spare holds nothing of anyone until it is bound: no record, no mount
//   besides those of Create (its own empty home and run directory, the model
//   proxy's socket directory, the releases read-only), a boot spec with no
//   session and no API, no journal, and a token socket that answers nobody
//   (host.ts: a container with no record has no session to ask for).
// - Bound once, to one thread: `bind` takes the id out of the spares before
//   it writes the record, and refuses a thread that already has a record (a
//   record hit resumes; it never takes a spare).
// - A spare is made a thread's in that thread's turn (thread-lock.ts,
//   `turn`), the one a start and a prune take, from before the record is
//   looked for until the spare is claimed or discarded: nothing removes the
//   thread's things under a bind, and the cold start after a failed claim
//   takes the turn after it.
// - The record is written before anything of the person is mounted, so a
//   container that holds a person's files always has a record saying whose.
// - The journal directory is among the mounts, so the API is minted before
//   them: the runner opens its journal when it is claimed.
// - A spare that leaves is Removed, container and home, and its run directory
//   goes with it; one whose record was written keeps the record and the run
//   directory, and the thread's next start creates a container under the same
//   id (start.ts, the resume).
// - Every Podman call here goes through containers.ts and so `as.podman`
//   (podman.ts), which waits for the image lock: no spare is created while
//   provisioning holds it. None of what makes or binds a spare is
//   `repeatable` there: a Create, the mount helper or the worktrees' exec
//   that ran out of time behind the lock fails, and the spare is discarded.
// - Topping up never competes with a delivery it could wait for: one spare is
//   made at a time, none while a thread's start is in flight (`during`), and
//   none until SETTLE_MS after the last one ended, so that new threads coming
//   one after the other take the spares there are with nothing made beside
//   them. A spare already being made when a delivery arrives is not held.
// - A spare is this host's by the run directory Create mounts into it, below
//   this host's SP_RUN, like any container (containers.ts `inventory`). It is
//   never adopted by a later host (C14): the host's start removes every
//   container of its own that has no record, and the sweep removes one older
//   than its age that has no record and no connected runner (sweep.ts).

import type net from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { RunnerSpec, SessionSpec } from '../../protocol.js';
import type { RunnerApi } from '../../protocol-api.js';
import { type RunRoot, socketFor } from '../../ipc.js';
import { log } from '../../log.js';
import type { Telemetry } from '../../telemetry/emitter.js';
import type { Dimensions } from '../../telemetry/envelope.js';
import { awaitRunner, dialSocket } from '../runner-sockets.js';
import type { Containers } from './containers.js';
import type { Records, SandboxRecord } from './records.js';
import type { ThreadLocks } from './thread-lock.js';
import type { SandboxWorkspace } from './workspace.js';

export interface SpareDeps {
  tm: Telemetry;
  records: Records;
  /** The threads' turns, shared with the starts and prune. */
  locks: ThreadLocks;
  containers: Pick<Containers, 'create' | 'up' | 'pid' | 'remove' | 'diagnose'>;
  /** Delete a run directory (sweep.ts); never rejects. */
  deleteRun(id: string): Promise<unknown>;
  runRoot(id: string): RunRoot;
  version: string;
  /** The session's journal, socket (below `run`) and token for this runner; undefined off the API. */
  mint(spec: SessionSpec, runnerId: string, run: RunRoot): Promise<RunnerApi | undefined>;
  workspace: Pick<SandboxWorkspace, 'repos' | 'dirs' | 'binds' | 'mount' | 'prepare'>;
  /** Connect to a runner's socket; undefined when nothing answers. */
  dial?: (socket: string) => Promise<net.Socket | undefined>;
  /** How long after a thread's start no spare is made; SETTLE_MS unless given. */
  settleMs?: number;
}

/** A spare that listens, not yet adopted. */
export interface Spare {
  id: string;
  run: RunRoot;
  sock: net.Socket;
  createMs: number;
  startMs: number;
}

/** A spare made one thread's: what the claim sends and the host keeps. */
export interface Bound {
  record: SandboxRecord;
  run: RunRoot;
  /** The session as the runner gets it: a new thread has no transcript. */
  session: SessionSpec;
  /** With its token, for the `claim` frame. */
  api?: RunnerApi;
  /** The record, the directories and the API's mint; the mounts (with the container's pid); the worktrees and root files. */
  readyMs: number;
  mountMs: number;
  addMs: number;
}

export type SandboxSpares = ReturnType<typeof sandboxSpares>;

/** Measured on 2 vCPU: a spare made beside a new thread's claim takes it from 0.6 s to 1.1 s; a claim ends within 1 s. */
export const SETTLE_MS = 2000;

export function sandboxSpares(d: SpareDeps) {
  const { tm, containers: c } = d;
  const dial = d.dial ?? dialSocket;
  /** The spares of this host that serve no thread: made here, not yet bound, not yet gone. */
  const mine = new Set<string>();
  const leaving = new Map<string, Promise<void>>();
  const settleMs = d.settleMs ?? SETTLE_MS;
  let starts = 0;
  let lastStart = 0;
  const waiting: (() => void)[] = [];
  let queue: Promise<unknown> = Promise.resolve();

  /** A thread's start: no spare is made while one is in flight. */
  async function during<T>(fn: () => Promise<T>): Promise<T> {
    starts++;
    try {
      return await fn();
    } finally {
      lastStart = Date.now();
      if (!--starts) for (const go of waiting.splice(0)) go();
    }
  }
  const quiet = async () => {
    for (;;) {
      if (starts) await new Promise<void>((r) => waiting.push(r));
      const left = lastStart + settleMs - Date.now();
      if (!starts && left <= 0) return;
      if (left > 0) await new Promise((r) => setTimeout(r, left));
    }
  };

  /** Remove (container and home); the run directory too unless a record says the id is a thread's. Once per id at a time; never rejects. */
  function drop(id: string): Promise<void> {
    mine.delete(id);
    let p = leaving.get(id);
    if (!p) {
      p = (async () => {
        await c.remove(id);
        if (!d.records.get(id)) await d.deleteRun(id);
      })().finally(() => leaving.delete(id));
      leaving.set(id, p);
    }
    return p;
  }

  async function one(): Promise<Spare> {
    await quiet();
    const id = randomBytes(8).toString('hex');
    const run = d.runRoot(id);
    mine.add(id);
    try {
      const createMs = await c.create(id);
      // No session and no API: the runner parks, and knows nobody.
      const rs: RunnerSpec = { id, socket: socketFor(run, id), version: d.version };
      const t0 = Date.now();
      const up = await c.up(id, rs);
      try {
        const sock = await awaitRunner(rs, {
          tm, t0,
          dial: () => dial(rs.socket),
          late: async () => log.warn(`spare ${id} never listened:\n${(await c.diagnose(id)).slice(-4000)}`),
        });
        return { id, run, sock, createMs, startMs: up.startMs };
      } catch (e) {
        up.tokens.close();
        throw e;
      }
    } catch (e) {
      await drop(id);
      throw e;
    }
  }

  /** Top the pool up by one: Create, bring up with no thread, wait for its runner. One at a time; a failure leaves nothing. */
  function launch(): Promise<Spare> {
    const p = queue.then(one);
    queue = p.catch(() => {});
    return p;
  }

  /**
   * Make the spare `id` the container of `spec`'s thread: the record under the spare's id, the directories, the mounts into the
   * running container, the worktrees. After this the runner can be claimed into `/workspace`. A rejection leaves the record (if
   * it was written); the caller discards the spare and starts the thread cold, which resumes under the same id.
   */
  async function bind(id: string, spec: SessionSpec, f: Dimensions): Promise<Bound> {
    if (!mine.delete(id)) throw new Error(`${id} is not a spare of this host`);
    if (d.records.find(spec.owner.dir, spec.key)) throw new Error(`${spec.key} has a sandbox already: it resumes, it takes no spare`);
    const { sdkSessionId: _transcript, forkPath: _fork, ...session } = spec; // a new home has no transcript; the runner's fork is /workspace
    const now = new Date().toISOString();
    const record: SandboxRecord = { id, person: spec.owner.dir, key: spec.key, createdAt: now, usedAt: now };
    const t00 = Date.now();
    d.records.write(record);
    const run = d.runRoot(id);
    const names = d.workspace.repos(record);
    await d.workspace.dirs(record, names);
    const api = await d.mint(session, id, run);
    const t0 = Date.now();
    const readyMs = t0 - t00;
    await d.workspace.mount(id, await c.pid(id), record.person, d.workspace.binds(record, names, api && path.dirname(api.journal)));
    const mountMs = Date.now() - t0;
    const done = tm.start('fork.done', f);
    try {
      const p = await d.workspace.prepare(id, names);
      done.end({ outcome: 'completed', data: { repos: Object.keys(p.record.repos ?? {}).length } });
      return { record: p.record, run, session, api, readyMs, mountMs, addMs: p.addMs };
    } catch (e) {
      done.end({ outcome: 'failed', error_type: 'git_worktree', data: { fork_error_type: 'git_worktree' } });
      throw e;
    }
  }

  return {
    launch,
    bind,
    during,
    /** `fn` in the thread's turn: a claim, from the look for its record to the spare claimed or discarded. */
    turn: <T>(spec: SessionSpec, fn: () => Promise<T>): Promise<T> => d.locks.run(spec.owner.dir, spec.key, fn),
    /** True when the thread has a record: it resumes, and never takes a spare. */
    known: (spec: SessionSpec) => !!d.records.find(spec.owner.dir, spec.key),
    /** A spare's connection closed (it exited, was evicted, the host told it to go): Remove. Nothing for a container that is a thread's. */
    gone: (id: string): Promise<void> => (mine.has(id) || leaving.has(id) ? drop(id) : Promise.resolve()),
    /** A spare that was taken and not claimed: Remove; its record, if written, stays. */
    discard: drop,
    /** True from before a spare's Create until it is a thread's or gone: the sweep leaves it alone (host.ts). */
    has: (id: string) => mine.has(id) || leaving.has(id),
    /** The ids of the spares that serve no thread. */
    ids: () => [...mine],
  };
}
