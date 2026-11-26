// Codex as a kind of harness (work 082): what the runner's main.ts imports,
// lazily, only for a session whose spec names Codex, so a Claude runner never
// loads this directory.
//
// Invariants:
// - the options are read from the environment by main.ts alone and passed in
//   here (env is read only in process main files);
// - each start owns one app-server, ended by closing its scope (the
//   finalizer is synchronous, as `close` in ../types.ts requires);
// - no compactor and no spare of its own: Codex compacts on its own, and a
//   spare runner claimed for Codex starts it then (runner main.ts), as its
//   start (about 250 ms) is small next to the runner's launch.

import { Effect, Scope } from 'effect';
import type { HarnessKind } from '../types.js';
import { CODEX_CAPS, CodexHarness, type CodexOptions } from './harness.js';

export { CODEX_CAPS, type CodexOptions } from './harness.js';

/** Codex, run as `o` says; `started` hears of each harness it starts. */
export function codexKind(o: Omit<CodexOptions, 'sessionKey'>, sessionKey: string, started?: (h: CodexHarness) => void): HarnessKind {
  return {
    id: 'codex',
    caps: CODEX_CAPS,
    start(spec) {
      const harness = new CodexHarness(spec, { ...o, sessionKey });
      started?.(harness);
      const scope = Effect.runSync(Scope.make());
      Effect.runSync(
        Scope.addFinalizer(
          scope,
          Effect.sync(() => harness.close()),
        ),
      );
      return { harness, scope };
    },
  };
}
