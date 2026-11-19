// A session's Codex home goes with its fork (work 082, #129 round 2). Codex
// writes its threads' rollouts under CODEX_HOME/sessions, which grow with
// every turn; nothing else removes them. pruneFork (prune.ts) calls this
// once it removed a fork, the point where Calvin decides a session is done.
//
// Invariants: it removes only the home named by the session's key
// (codex-home.ts), as the runners' user (as-runner.ts); a home that does not
// exist (a Claude session) is not an error; it never throws, it logs.

import { codexHome, codexRoot } from '../codex-home.js';
import { log } from '../log.js';
import { rm, runnerHome } from './as-runner.js';

/** Remove the CODEX_HOME of the session `key`; returns the path it removed. */
export async function removeCodexHome(key: string) {
  const home = codexHome(codexRoot(runnerHome()), key);
  try {
    await rm(home);
    return home;
  } catch (e) {
    log.warn(`workspaces: codex home of ${key} (${home}) not removed: ${(e as Error)?.message ?? e}`);
    return undefined;
  }
}
