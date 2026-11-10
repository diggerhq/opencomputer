// Where a session's Codex keeps its state (work 082): one CODEX_HOME per
// session under the runner user's ~/.calvin/codex, named by a hash of the
// session key. Shared by the runner, which makes it (harness/codex), and the
// host, which removes it with the session's fork (workspaces/codex-homes.ts).
//
// Invariants: the name depends on the session key alone, so both sides find
// the same directory; the key is hashed, never a path component itself.

import { createHash } from 'node:crypto';
import path from 'node:path';

/** The directory of every session's CODEX_HOME, under the runner user's `home`. */
export const codexRoot = (home: string) => path.join(home, '.calvin', 'codex');

/** The session's CODEX_HOME under `root`. */
export function codexHome(root: string, sessionKey: string) {
  return path.join(root, createHash('sha256').update(sessionKey).digest('hex').slice(0, 24));
}
