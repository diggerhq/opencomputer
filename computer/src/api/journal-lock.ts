// The journal's exclusive lock (work 084, "One writer, one log"): whichever
// process holds it is the session's one writer. Node has no flock(2), so a
// child holds it for us: `flock -x -o <file> sh -c 'echo locked; exec cat'`.
// flock(1) takes the lock on its own fd, then runs `cat` on our stdin pipe and
// waits for it; `cat` exits when the pipe closes, which happens when we close
// it (release) or when this process dies for any reason, SIGKILL included,
// because the kernel closes our end. Then flock(1) exits and the lock goes.
//
// Invariants: `take` resolves only after the child printed `locked` (the lock
// is held); a held lock fails at once with `locked` (or after `waitMs`);
// `release` resolves after the child exited, so a successor's `take` cannot
// race the old holder. The lock is advisory and on the inode: every writer of
// a journal goes through here (runner and host), so the rule holds between
// them; a process that writes the file without it is not stopped.

import { type ChildProcess, spawn } from 'node:child_process';
import type { Socket } from 'node:net';

const FLOCK = '/usr/bin/flock';
/** flock(1)'s exit status when the lock is held by someone else (`-E`). */
const CONFLICT = 75;

export class LockError extends Error {
  constructor(
    readonly code: 'locked' | 'failed',
    message: string,
  ) {
    super(message);
  }
}

export class FileLock {
  private exited: Promise<void>;

  private constructor(private child: ChildProcess) {
    this.exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once('exit', () => resolve());
    });
  }

  /** Hold an exclusive flock on `file` until `release` or this process ends. */
  static take(file: string, waitMs = 0, flock = FLOCK): Promise<FileLock> {
    const wait = waitMs > 0 ? ['-w', String(Math.max(waitMs / 1000, 0.001))] : ['-n'];
    const child = spawn(flock, ['-x', ...wait, '-E', String(CONFLICT), '-o', file, 'sh', '-c', 'echo locked; exec cat'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new Promise((resolve, reject) => {
      let out = '';
      let err = '';
      const fail = (e: LockError) => {
        child.stdin?.destroy();
        reject(e);
      };
      child.stderr?.on('data', (d: Buffer) => (err += d.toString()));
      child.once('error', (e) => fail(new LockError('failed', `flock: ${e.message}`)));
      child.once('exit', (code) => {
        if (out.includes('locked')) return;
        fail(code === CONFLICT ? new LockError('locked', `${file} is locked by another writer`) : new LockError('failed', `flock exited ${code}: ${err.trim()}`));
      });
      child.stdout?.on('data', (d: Buffer) => {
        out += d.toString();
        if (!out.includes('locked')) return;
        child.stdout?.destroy();
        child.stderr?.destroy();
        // Neither the child nor its stdin keeps this process alive; the pipe still closes when it dies.
        child.unref();
        (child.stdin as unknown as Socket | null)?.unref?.();
        resolve(new FileLock(child));
      });
    });
  }

  /** Drop the lock; resolves once the holder exited. */
  release(): Promise<void> {
    this.child.stdin?.end();
    return this.exited;
  }
}
