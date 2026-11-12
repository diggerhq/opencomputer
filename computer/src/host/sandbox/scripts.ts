// The workspace scripts (bin/ws-*.sh) in containers (work 103, C12): the two
// ScriptRunners of a `podman` host. `sessionScripts(id)` runs a script in a
// thread's running container, as the session's user, where the workspace is
// `/workspace` and the clones `/clones`. `helperScripts(person, binds?)` runs
// one in a container made for that run, which sees that person's clones and
// nothing of anybody else.
//
// Invariants:
// - The host never runs git: on a `podman` host every script goes through one
//   of these two.
// - A helper gets a network only for a script that fetches, and never runs
//   longer than the spec's table says (HELPER_SECONDS), whatever its caller
//   asked: Podman ends it, since the script is its first process.
// - A script in a session's container is ended inside the container
//   (`timeout`), so nothing of it is left running there when its time is up.
// - Failures are ScriptError, as from the host's runner, so callers are the same.

import path from 'node:path';
import { ScriptError, type ScriptRunner } from '../../workspaces/script-runner.js';
import type { Telemetry } from '../../telemetry/emitter.js';
import { CLONES, WORKSPACE } from './mounts.js';
import { type AsRunner, PODMAN, PodmanError } from './podman.js';
import { type Bind, HELPER_SCOPE, helperArgs } from './podman-args.js';

/** Seconds a helper may run, by script (the spec's "Helper run"). */
export const HELPER_SECONDS: Record<string, number> = { 'ws-clone.sh': 600, 'ws-sync.sh': 120, 'ws-fetch.sh': 120, 'ws-inspect.sh': 60, 'ws-forget.sh': 30 };
/** The scripts that reach a remote. */
const FETCHES = new Set(['ws-clone.sh', 'ws-sync.sh', 'ws-fetch.sh']);
/** What the host waits past a script's own limit before it gives up on the command. */
const GRACE_MS = 15_000;
const TIMEOUT = '/usr/bin/timeout';

export interface ScriptsDeps {
  as: AsRunner;
  tm: Telemetry;
  /** The host's release (its `bin/` holds the scripts) and SP_DATA. */
  root: string;
  dataDir: string;
  /** The helpers' run directory, `$SP_RUN/helper`. */
  helperRun: string;
  image: string;
  /** `containers.execIn`. */
  execIn(id: string, argv: string[], o: { dir: string; timeoutMs: number; stdin?: string | Buffer }): Promise<string>;
}

export type SandboxScripts = ReturnType<typeof sandboxScripts>;

const failed = (script: string, e: unknown, seconds: number) => {
  if (!(e instanceof PodmanError)) return e;
  // 124: `timeout` ended it; 255 with Podman's own word: `--timeout` did.
  const killed = e.timedOut || e.code === 124 || /timed out|timeout/i.test(e.stderr.split('\n').slice(-2).join(' '));
  return new ScriptError(script, e.code ?? null, killed ? `timed out after ${seconds} s` : e.stderr, killed);
};

export function sandboxScripts(d: ScriptsDeps) {
  const bin = (script: string) => {
    if (!/^ws-[a-z]+\.sh$/.test(script)) throw new Error(`not a workspace script: ${script}`);
    return path.join(d.root, 'bin', script);
  };

  /** In the thread's running container. */
  function sessionScripts(id: string): ScriptRunner {
    return {
      clones: CLONES,
      workspace: () => WORKSPACE,
      async run(script, args, o) {
        const seconds = Math.max(1, Math.ceil(o.timeoutMs / 1000));
        const argv = [...(o.timeoutMs > 0 ? [TIMEOUT, '--kill-after=5', String(seconds)] : []), '/bin/sh', bin(script), ...args];
        return d.execIn(id, argv, { dir: '/', timeoutMs: o.timeoutMs > 0 ? o.timeoutMs + GRACE_MS : 0, stdin: o.stdin }).catch((e) => {
          throw failed(script, e, seconds);
        });
      },
    };
  }

  /** In a container of its own, on `person`'s clones. `binds`: a stopped thread's workspace and registries, for a script that reads them. */
  function helperScripts(person: string, binds: Bind[] = []): ScriptRunner {
    return {
      clones: CLONES,
      workspace: () => WORKSPACE,
      async run(script, args, o) {
        const cap = HELPER_SECONDS[script];
        if (!cap) throw new Error(`${script} does not run in a helper container`);
        const seconds = o.timeoutMs > 0 ? Math.min(cap, Math.max(1, Math.ceil(o.timeoutMs / 1000))) : cap;
        const argv = helperArgs({
          person, people: path.join(d.dataDir, 'people'), run: d.helperRun, image: d.image, network: FETCHES.has(script), timeoutS: seconds,
          stdin: o.stdin !== undefined, binds, script: bin(script), args,
        });
        const span = d.tm.start('sandbox.helper', { data: { script } });
        try {
          const out = await d.as.run([...HELPER_SCOPE, PODMAN, ...argv], { timeoutMs: seconds * 1000 + GRACE_MS, stdin: o.stdin });
          span.end({ outcome: 'completed' });
          return out;
        } catch (e) {
          const err = failed(script, e, seconds);
          span.end({ outcome: 'failed', error_type: (err as ScriptError).killed ? 'timeout' : 'launch' });
          throw err;
        }
      },
    };
  }

  return { sessionScripts, helperScripts };
}
