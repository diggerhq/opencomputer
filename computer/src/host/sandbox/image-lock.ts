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
// its Podman calls: it waits instead of timing out.
//
// Invariants:
// - A session cannot hold the lock: the file is root's, 0640, group the
//   host's, in /run, and flock needs it open.
// - The wait never rejects and is bounded (WAIT_S): past it, or without
//   flock(1), the call goes ahead and is bounded by its own timeout as before.
// - A lock is its holder's: provisioning that died holds nothing, and leaves
//   only the file. sandbox.sh removes the file as it finishes, so a call
//   normally pays one stat; with a file left behind, one flock(1) (7 ms
//   measured) until the next run.
// - Not covered: a call already running when provisioning takes the lock.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { log } from '../../log.js';

/** The same path in deploy/vm/sandbox.sh. One per computer, like the runners' Podman store. */
export const IMAGE_LOCK = '/run/slack-presence-image.lock';
const FLOCK = '/usr/bin/flock';
/** Longer than a pull and a warm-up take (181 to 214 s measured for both, work 103 "Provisioning"). */
export const WAIT_S = 300;

export interface ImageLockDeps {
  lock?: string;
  waitS?: number;
  exists?: (p: string) => boolean;
  /** Runs flock(1); resolves with its exit code, or undefined when it could not run. */
  flock?: (args: string[]) => Promise<number | undefined>;
  now?: () => number;
}

const run = (args: string[]) =>
  new Promise<number | undefined>((resolve) => execFile(FLOCK, args, (e) => resolve(!e ? 0 : typeof e.code === 'number' ? e.code : undefined)));

/** Resolves once provisioning is not pulling or warming an image, or after `waitS`. Without the file, nobody is. */
export function imageSettled(d: ImageLockDeps = {}): Promise<void> {
  const { lock = IMAGE_LOCK, waitS = WAIT_S, exists = existsSync, flock = run, now = Date.now } = d;
  if (!exists(lock)) return Promise.resolve();
  const t0 = now();
  // Exit 1 is flock's "still held"; anything else that is not 0 (a file it may not open) is nobody holding it.
  return flock(['--shared', '--timeout', String(waitS), lock, '/usr/bin/true']).then((code) => {
    const ms = now() - t0;
    if (code === 1) log.warn(`podman: provisioning still holds ${lock} after ${waitS} s; going on`);
    else if (ms >= 1000) log.info(`podman: waited ${ms} ms for provisioning to finish with an image`);
  });
}
