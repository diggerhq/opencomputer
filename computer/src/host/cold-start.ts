// A runner's cold start on the host: the session's fork and the runner's
// launch, concurrently when the fork's directory is known up front, then the
// first connection to the runner's socket.
//
// Invariant: the fork is complete (every worktree added, .fork.json written)
// before `coldStart` resolves, and the host hands the runner its socket
// connection, and with it `credentials` and the first `deliver`, only after
// that (host/main.ts `adopt`). The runner process itself may boot inside the
// still-empty fork directory: until it has credentials it only listens on its
// socket and never reads its cwd, so Claude Code never starts, nor sees the
// fork, before the worktrees exist. If the fork fails, a runner that already
// came up is told to go (`abandon`) and the start fails as before.

import type { SessionSpec } from '../protocol.js';
import type { Telemetry } from '../telemetry/emitter.js';
import type { Dimensions } from '../telemetry/envelope.js';
import { ensureWorkdir } from '../workspace.js';
import { forkInfo, forkSession, workspacesEnabled } from '../workspaces/index.js';

/** Make the session's fork, as the `fork.done` span: a workspace fork (VM), else ensureWorkdir (laptop). */
export async function forkFor(tm: Telemetry, spec: SessionSpec, f: Dimensions): Promise<string> {
  const done = tm.start('fork.done', f);
  try {
    if (!workspacesEnabled()) return await ensureWorkdir(spec.key); // laptop: scratch repo or WORKDIR
    // Never waits on a clone (work 056): missing repositories are cloned in the background or on checkout_repo.
    const p = await forkSession(spec.owner, spec.key);
    done.end({ outcome: 'completed', data: { repos: Object.keys(forkInfo(p)?.repos ?? {}).length } });
    return p;
  } catch (e) {
    done.end({ outcome: 'failed', error_type: 'git_worktree', data: { fork_error_type: 'git_worktree' } });
    throw e;
  } finally {
    done.end({ outcome: 'completed' });
  }
}

/** Dial until something answers: first try at once, then every `intervalMs`, for `timeoutMs` in all. */
export async function pollReady<T>(dial: () => Promise<T | undefined>, intervalMs = 20, timeoutMs = 30_000): Promise<{ value?: T; polls: number }> {
  const end = Date.now() + timeoutMs;
  for (let polls = 1; ; polls++) {
    const value = await dial();
    if (value !== undefined) return { value, polls };
    if (Date.now() >= end) return { polls };
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export interface ColdStartSteps<T> {
  /** The fork's directory when it is known before forking (a workspace fork); the runner launches in it right away. */
  dir?: string;
  /** Creates (or completes) the fork and returns its path; absent when the fork already exists at `dir`. */
  fork?: () => Promise<string>;
  /** Starts the runner in `dir` and resolves once it answers on its socket. */
  start: (dir: string) => Promise<T>;
  /** The fork failed after the runner came up: make it go. */
  abandon: (ready: T) => void;
}

/** Fork and start the runner, concurrently when `dir` is known; resolves once both are done. */
export async function coldStart<T>(s: ColdStartSteps<T>): Promise<{ ready: T; forkPath: string }> {
  if (!s.fork) {
    if (s.dir === undefined) throw new Error('cold start without a fork or its directory');
    return { ready: await s.start(s.dir), forkPath: s.dir };
  }
  if (s.dir === undefined) {
    const forkPath = await s.fork();
    return { ready: await s.start(forkPath), forkPath };
  }
  const [forked, started] = await Promise.allSettled([s.fork(), s.start(s.dir)]);
  if (forked.status === 'rejected') {
    if (started.status === 'fulfilled') s.abandon(started.value);
    throw forked.reason;
  }
  if (started.status === 'rejected') throw started.reason;
  if (forked.value !== s.dir) {
    // Never expected (the fork lands where forkDir says); the runner's cwd would be wrong.
    s.abandon(started.value);
    throw new Error(`fork landed at ${forked.value}, runner started in ${s.dir}`);
  }
  return { ready: started.value, forkPath: forked.value };
}
