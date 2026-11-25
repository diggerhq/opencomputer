// What a host does about releases other than its own (work 118, section 43.1).
//
// - The gateway closes a host that speaks an older protocol with 4426 ("upgrade
//   required"). The host then asks for its self-update at once instead of
//   waiting for the timer: it creates `<run>/update-now`, which
//   slack-presence-self-update.path (deploy/vm/self-update.sh) watches. Asking
//   again is harmless: the update does nothing until a newer release is
//   published, and the link's backoff paces the asking.
// - A runner of another release speaks that release's frames. A host stops
//   every such runner when it starts: a turn in flight ends interrupted, its
//   journal is kept, and the session cold-starts on this release at its next
//   delivery.
//
// Invariant: the host never updates itself; it only leaves the request, and
// root's unit decides (a host that is not a backend-made computer has no unit
// and nothing happens).

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SessionReport } from '../protocol.js';
import { log } from '../log.js';

/** The close code of a gateway that no longer speaks this host's protocol. */
export const UPGRADE_REQUIRED = 4426;
/** The file whose existence starts the self-update (self-update.sh removes it as it starts). */
export const UPDATE_NOW = 'update-now';

/** On a gateway close: ask for the self-update when the code says this release is too old. True when asked. */
export function updateOnClose(code: number, run: string, write: (file: string) => void = (f) => writeFileSync(f, '')): boolean {
  if (code !== UPGRADE_REQUIRED) return false;
  try {
    write(path.join(run, UPDATE_NOW));
    log.warn('the gateway asks for a newer release (4426): self-update requested');
  } catch (e) {
    log.warn(`self-update not requested: ${(e as Error)?.message ?? e}`);
  }
  return true;
}

/** The runners found at start that another release started (one that reports no version included). */
export const ofAnotherRelease = <R extends { report?: Pick<SessionReport, 'runnerVersion'> }>(runners: Iterable<R>, version: string): R[] =>
  [...runners].filter((r) => r.report?.runnerVersion !== version);
