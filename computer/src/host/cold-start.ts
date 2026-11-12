// A runner's cold start on the host, one orchestration for both launch modes
// (work 103): bring the runner's process up, then make the session's fork and
// wait for the runner's socket together.
//
// Invariant: the fork is complete (every worktree added, .fork.json written)
// before `coldStart` resolves, and the host hands the runner its socket
// connection, and with it `credentials` and the first `deliver`, only after
// that (host/start-runner.ts `adopt`). The runner process itself may boot inside the
// still-empty fork directory: until it has credentials it only listens on its
// socket and never reads its cwd, so Claude Code never starts, nor sees the
// fork, before the worktrees exist. If either step fails, the runner is made
// to go (`abandon`) and the start fails with the first failure.

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

export interface StartSteps<T> {
  /** Bring the runner's process up: launch it (detached), or create/start/mount its container. */
  up: () => Promise<void>;
  /** Make the fork's content; absent when it exists (a resume). */
  prepare?: () => Promise<void>;
  /** Resolves once the runner answers on its socket. */
  ready: () => Promise<T>;
  /** A step failed after `up`: make it go. */
  abandon: () => Promise<void>;
}

/** `up`, then `prepare` and `ready` together; any rejection abandons and rethrows the first. */
export async function coldStart<T>(s: StartSteps<T>): Promise<T> {
  await s.up(); // a failed `up` leaves nothing behind itself
  try {
    const [ready] = await Promise.all([s.ready(), s.prepare?.()]);
    return ready;
  } catch (e) {
    await s.abandon().catch(() => {}); // the first failure is the one to report
    throw e;
  }
}
