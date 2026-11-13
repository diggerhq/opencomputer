// Waiting for provisioning to finish with Podman's storage (work 103). While
// deploy/vm/sandbox.sh pulls an image and warms its user-namespace copy, the
// storage lock holds every other Podman call of the runners' user: measured on
// Podman 4.9.3 with a 3.78 GB image on 2 vCPU, `exec`, `stop`, `start`,
// `create`, `rm`, `ps`, `inspect`, `volume ls` and `image exists` each waited
// the whole 124 s of the warm-up, and up to 13 s while a 300 MB layer was
// applied. A self-update does that with sessions alive, and a call that waits
// that long runs out of its own time and fails a person's message.
//
// So sandbox.sh holds an exclusive flock(2) on IMAGE_LOCK for as long as it
// does either, and the host takes a shared one for an instant before each of
// its Podman calls: it waits instead of timing out. A call somebody is
// waiting for at a browser or a command line (a terminal open, `/files`)
// waits a few seconds only and is then refused with words for that person.
//
// Invariants:
// - A session cannot hold the lock: the file is root's, 0640, group the
//   host's, in /run, and flock needs it open.
// - The wait never rejects and is bounded (WAIT_S, or what its caller says):
//   it answers whether the storage is free. Past WAIT_S, or without flock(1),
//   a call goes ahead and is bounded by its own timeout as before; a caller
//   that named its own bound refuses instead (podman.ts `settled`).
// - A lock is its holder's: provisioning that died holds nothing, and leaves
//   only the file. sandbox.sh removes the file as it finishes, so a call
//   normally pays one stat; with a file left behind, one flock(1) (7 ms
//   measured) until the next run.
// - A provisioning run queued behind another takes a new file once the first
//   removed its own (sandbox.sh). So after a wait that was a real one the host
//   looks at the path again, NEXT_MS later, and waits for that run too; all
//   within the one bound.
// - A call already running when provisioning takes the lock waits inside
//   Podman and may run out of its time: podman.ts asks `imageBusy` then, and
//   makes the call once more after the wait when its caller called it
//   `repeatable`; any other fails as a timeout does.
// - Every command of the host that runs Podman waits here first, through
//   `AsRunner.settled` (podman.ts names them all). Not covered: what a helper
//   or a session's unit does once it was started.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { log } from '../../log.js';

/** The same path in deploy/vm/sandbox.sh. One per computer, like the runners' Podman store. */
export const IMAGE_LOCK = '/run/slack-presence-image.lock';
const FLOCK = '/usr/bin/flock';
/** Longer than a pull and a warm-up take (181 to 214 s measured for both, work 103 "Provisioning"). */
export const WAIT_S = 300;
/** A wait this long was for a holder (a free lock answers in 7 ms). */
const HELD_MS = 500;
/** How long a provisioning run that waited for another needs to take its own lock: it wakes, makes the file and locks it. */
const NEXT_MS = 200;

export interface ImageLockDeps {
  lock?: string;
  waitS?: number;
  exists?: (p: string) => boolean;
  /** Runs flock(1); resolves with its exit code, or undefined when it could not run. */
  flock?: (args: string[]) => Promise<number | undefined>;
  now?: () => number;
  nextMs?: number;
}

const run = (args: string[]) =>
  new Promise<number | undefined>((resolve) => execFile(FLOCK, args, (e) => resolve(!e ? 0 : typeof e.code === 'number' ? e.code : undefined)));

/** Resolves once provisioning is not pulling or warming an image (true), or after `waitS` with the lock still held (false). Without the file, nobody is. */
export async function imageSettled(d: ImageLockDeps = {}): Promise<boolean> {
  const { lock = IMAGE_LOCK, waitS = WAIT_S, exists = existsSync, flock = run, now = Date.now, nextMs = NEXT_MS } = d;
  if (!exists(lock)) return true;
  const t0 = now();
  for (;;) {
    const left = Math.ceil(waitS - (now() - t0) / 1000);
    if (left <= 0) break;
    const r0 = now();
    // Exit 1 is flock's "still held"; anything else that is not 0 (a file it may not open) is nobody holding it.
    const code = await flock(['--shared', '--timeout', String(left), lock, '/usr/bin/true']);
    if (code === 1) return log.warn(`podman: provisioning still holds ${lock} after ${waitS} s`), false;
    if (code !== 0 || now() - r0 < HELD_MS) break;
    // It was held, and is free: a run queued behind that one takes its own file now.
    await new Promise((r) => setTimeout(r, nextMs));
    if (!exists(lock)) break;
  }
  const ms = now() - t0;
  if (ms >= 1000) log.info(`podman: waited ${ms} ms for provisioning to finish with an image`);
  return true;
}

/** True while provisioning holds the lock at this moment. */
export async function imageBusy(d: Pick<ImageLockDeps, 'lock' | 'exists' | 'flock'> = {}): Promise<boolean> {
  const { lock = IMAGE_LOCK, exists = existsSync, flock = run } = d;
  return exists(lock) && (await flock(['--shared', '--nonblock', lock, '/usr/bin/true'])) === 1;
}
