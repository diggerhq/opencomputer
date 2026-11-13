// The one way a `podman` host runs a script on a person's files (work 103,
// C12 and C13): in the thread's running container, as the session's user,
// where the workspace is `/workspace` and the clones `/clones`; or in a helper
// container made for that run, which sees that person's clones, what its
// caller binds, and nothing of anybody else.
//
// `sessionScripts(id)` and `helperScripts(person, binds?)` are the two
// ScriptRunners of the workspace scripts (bin/ws-*.sh): a script runs to its
// end and its output is the answer. `filesPlace(thread)` is where the `/files`
// scripts run (workspace-files.ts `Place`): the same two commands, started and
// handed back, since a file or an archive is a stream; in the container while
// the thread runs, else in a helper with its workspace bound at `/workspace`,
// read-only unless the script writes, and never with a network.
//
// Invariants:
// - The host never runs git, and never opens a workspace file: on a `podman`
//   host every script goes through here.
// - A helper gets a network only for a script that fetches, and never runs
//   longer than the spec's table says (HELPER_SECONDS; a clone: as long as
//   its caller says), whatever its caller asked: Podman ends it, since the
//   script is its first process.
// - A script in a session's container is ended inside the container
//   (`timeout`), so nothing of it is left running there when its time is up.
// - A `/files` script whose command on the host ended any other way than by
//   the script's own exit (its reader went away, its time was up, the host
//   ended it: the child's `kill`) is ended where it runs as well: ending
//   `podman exec` or `podman run` leaves a process that neither reads nor
//   writes running in the container (measured, Podman 4.9.3). So the host
//   signals the script's `timeout` in the session's container, and stops the
//   helper by its name.
// - Failures of a ScriptRunner are ScriptError, as from the host's runner, so
//   callers are the same. A `/files` script's exit code is its caller's to read.
// - A helper container and a `/files` script start only once provisioning is
//   not holding Podman's storage (image-lock.ts): a helper waits as any
//   Podman call does, a `/files` script as long as a person may be kept
//   waiting, and is refused past that (use.ts).
// - Where a `/files` script runs is decided when it starts, from what the
//   thread is then (use.ts `enter`), not from the SandboxPlace its caller
//   holds. A container that stops after that (the idle stop) makes `podman
//   exec` fail, or kills the script with it; nothing falls back to the host.
//   `lost` tells that end from a failure of the script, and the caller runs
//   the script again, where the thread is then, only when it changes nothing
//   (workspace-files.ts).

import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { ScriptError, type ScriptRunner } from '../../workspaces/script-runner.js';
import type { Telemetry } from '../../telemetry/emitter.js';
import type { Place } from '../workspace-files.js';
import { CLONES, WORKSPACE } from './mounts.js';
import { type AsRunner, bounded, PODMAN, PodmanError, TIMEOUT } from './podman.js';
import type { Use } from './use.js';
import { type Bind, execArgs, filesEndArgs, filesTagged, HELPER_SCOPE, helperArgs, helperStopArgs } from './podman-args.js';

/**
 * Seconds a helper may run, by script (the spec's "Helper run"): the most its caller can ask, and what it gets when the
 * caller names no limit. A clone's is the second only: its caller's limit (30 min for the clone and for each setup
 * command, src/workspaces/clones.ts) applies whole.
 */
export const HELPER_SECONDS: Record<string, number> = { 'ws-clone.sh': 1800, 'ws-sync.sh': 120, 'ws-fetch.sh': 120, 'ws-inspect.sh': 60, 'ws-forget.sh': 30 };
/** The scripts whose caller's limit is not capped. */
const UNCAPPED = new Set(['ws-clone.sh']);
/** The scripts that reach a remote. */
const FETCHES = new Set(['ws-clone.sh', 'ws-sync.sh', 'ws-fetch.sh']);
/** What the host waits past a script's own limit before it gives up on the command. */
const GRACE_MS = 15_000;
/** Seconds a `/files` script may run at most: one that carries an archive of 1 GiB out, or an upload in. */
export const FILES_SECONDS = 3600;

/** What ending the rest of a `/files` script in its container may take. */
const LEFT_MS = 20_000;

/** A thread's sandbox as its terminal and its `/files` need it; sandbox/host.ts fills it from the thread's record. */
export interface SandboxPlace {
  /** The sandbox id (`sp-runner-<id>`). */
  id: string;
  /** `person.dir`. */
  person: string;
  /** The workspace on the host: what is mounted at `/workspace` while the thread runs. */
  workspace: string;
  /** The thread's container is running. */
  running: boolean;
}

export interface ScriptsDeps {
  as: AsRunner;
  /** `runnerUser(env).sudo`: for a script whose output is a stream, which `as` does not start. */
  sudo: string[];
  /** Starts such a script; tests pass their own. */
  spawn?: (cmd: string, args: string[]) => ChildProcess;
  tm: Telemetry;
  /** The host's release (its `bin/` holds the scripts) and SP_DATA. */
  root: string;
  dataDir: string;
  /** The helpers' run directory, `$SP_RUN/helper`. */
  helperRun: string;
  image: string;
  /** `sandboxUses.enter`: before a `/files` script starts. */
  enter(id: string): Promise<Use>;
  /** The thread's container is running now (`unitActive`). */
  running(id: string): Promise<boolean>;
  /** How long `lost` waits for a container that is stopping to have stopped (3 s); tests pass less. */
  lostWaitMs?: number;
  /** `containers.execIn`. */
  execIn(id: string, argv: string[], o: { dir: string; timeoutMs: number; stdin?: string | Buffer }): Promise<string>;
}

export type SandboxScripts = ReturnType<typeof sandboxScripts>;

/** `ranOut`: the command failed no sooner than its limit. `podman run --timeout` ends a container with exit 255 and says nothing (measured, Podman 4.9.3), so only the time tells. */
const failed = (script: string, e: unknown, seconds: number, ranOut = false) => {
  if (!(e instanceof PodmanError)) return e;
  // 124: timeout(1) ended it.
  const killed = e.timedOut || e.code === 124 || ranOut;
  return new ScriptError(script, e.code ?? null, killed ? `timed out after ${seconds} s` : e.stderr, killed);
};

export function sandboxScripts(d: ScriptsDeps) {
  const bin = (script: string) => {
    if (!/^ws-[a-z]+\.sh$/.test(script)) throw new Error(`not a workspace script: ${script}`);
    return path.join(d.root, 'bin', script);
  };

  /** `/bin/sh <sh…>` for a thread's running container, ended there after `seconds` (0: never). */
  const inSession = (sh: string[], seconds: number) => [...(seconds > 0 ? [TIMEOUT, '--kill-after=5', String(seconds)] : []), '/bin/sh', ...sh];
  /** `/bin/sh <sh…>` in a container of its own on `person`'s clones, ended by Podman after `seconds`: the whole command, for the runners' user. */
  const inHelper = (person: string, sh: string[], o: { network: boolean; seconds: number; stdin: boolean; binds: Bind[]; name?: string }) => [
    ...HELPER_SCOPE, PODMAN,
    ...helperArgs({ name: o.name, person, people: path.join(d.dataDir, 'people'), run: d.helperRun, image: d.image, network: o.network, timeoutS: o.seconds, stdin: o.stdin, binds: o.binds, sh }),
  ];

  /** In the thread's running container. */
  function sessionScripts(id: string): ScriptRunner {
    return {
      clones: CLONES,
      workspace: () => WORKSPACE,
      async run(script, args, o) {
        const seconds = Math.max(1, Math.ceil(o.timeoutMs / 1000));
        const argv = inSession([bin(script), ...args], o.timeoutMs > 0 ? seconds : 0);
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
        const asked = Math.max(1, Math.ceil(o.timeoutMs / 1000));
        const seconds = o.timeoutMs > 0 ? (UNCAPPED.has(script) ? asked : Math.min(cap, asked)) : cap;
        const argv = inHelper(person, [bin(script), ...args], { network: FETCHES.has(script), seconds, stdin: o.stdin !== undefined, binds });
        const span = d.tm.start('sandbox.helper', { data: { script } });
        const t0 = Date.now();
        try {
          await d.as.settled();
          const out = await d.as.run(argv, { timeoutMs: seconds * 1000 + GRACE_MS, stdin: o.stdin });
          span.end({ outcome: 'completed' });
          return out;
        } catch (e) {
          const err = failed(script, e, seconds, Date.now() - t0 >= seconds * 1000);
          span.end({ outcome: 'failed', error_type: (err as ScriptError).killed ? 'timeout' : 'unknown' });
          throw err;
        }
      },
    };
  }

  const start = d.spawn ?? ((cmd, args) => nodeSpawn(cmd, args, { cwd: '/', stdio: ['pipe', 'pipe', 'pipe'] }));

  /** The `/files` scripts started in a thread's container: how each ended, for `lost`. */
  const inContainer = new WeakMap<ChildProcess, { id: string; told: boolean; code?: number | null }>();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** Where the `/files` scripts of a thread run: started, not waited for; what the process prints and how it exits is the caller's. */
  function filesPlace(place: SandboxPlace): Place {
    return {
      root: WORKSPACE,
      async spawn(argv, mode) {
        const [shell, ...sh] = argv;
        if (shell !== '/bin/sh') throw new Error(`not a shell script: ${shell}`);
        const use = await d.enter(place.id);
        // What the thread is now: it may have stopped, or started, since the request came in.
        const sb = use.place;
        const seconds = Math.min(FILES_SECONDS, Math.max(1, Math.ceil(mode.seconds ?? FILES_SECONDS)));
        const tag = randomBytes(8).toString('hex');
        const command = sb.running
          ? [PODMAN, ...execArgs(sb.id, [TIMEOUT, '--kill-after=5', String(seconds), ...filesTagged(tag), '/bin/sh', ...sh], { dir: WORKSPACE, interactive: mode.stdin })]
          : inHelper(sb.person, sh, { name: `sp-files-${tag}`, network: false, seconds, stdin: !!mode.stdin, binds: [{ src: sb.workspace, dst: WORKSPACE, ro: !mode.write }] });
        // The same bound as `as.run` puts on a command (podman.ts): past it timeout(1) ends what sudo started.
        const [cmd, ...args] = [...d.sudo, '--', ...bounded(command, seconds * 1000 + GRACE_MS)];
        let p: ChildProcess;
        try {
          p = start(cmd, args);
        } catch (e) {
          use.leave();
          throw e;
        }
        const span = sb.running ? undefined : d.tm.start('sandbox.helper', { data: { script: 'files' } });
        const t0 = Date.now();
        p.once('error', () => (use.leave(), span?.end({ outcome: 'failed', error_type: 'unknown' })));
        // Whoever tells the command to end is noted: `podman exec` that was told exits 0, as if its script had (measured, Podman 4.9.3).
        let told = false;
        const ran = sb.running ? { id: sb.id, told: false, code: undefined as number | null | undefined } : undefined;
        if (ran) inContainer.set(p, ran);
        const kill = p.kill.bind(p);
        p.kill = (signal) => {
          told = true;
          if (ran) ran.told = true;
          return kill(signal);
        };
        p.once('close', (code: number | null) => {
          use.leave();
          if (ran) ran.code = code;
          // The script's own exits (a path that is not there, or leaves the workspace) are answers, not failures of the helper.
          const own = code !== null && code < 124;
          span?.end(own ? { outcome: 'completed' } : { outcome: 'failed', error_type: Date.now() - t0 >= seconds * 1000 ? 'timeout' : 'unknown' });
          if (own && !told) return;
          // Ended, not over: what it ran may still be there. Nothing to end is the usual answer, and a failure here has nobody to tell.
          d.as.podman(sb.running ? filesEndArgs(sb.id, tag) : helperStopArgs(`sp-files-${tag}`), { timeoutMs: LEFT_MS }).catch(() => {});
        });
        return p;
      },
      /**
       * The script ended because its container stopped under it: it ran in the container, nobody told it to end, its
       * command did not end as the script does (255: `podman exec` on a stopped container; 137: killed with it; measured,
       * Podman 4.9.3), and the container is not running. The exec may fail a moment before the unit is over, hence the wait.
       */
      async lost(p) {
        const ran = inContainer.get(p);
        if (!ran || ran.told || ran.code === undefined || (ran.code !== null && ran.code < 124)) return false;
        const until = Date.now() + (d.lostWaitMs ?? 3000);
        for (;;) {
          if (!(await d.running(ran.id).catch(() => true))) return true;
          if (Date.now() >= until) return false;
          await sleep(Math.min(200, d.lostWaitMs ?? 3000));
        }
      },
    };
  }

  return { sessionScripts, helperScripts, filesPlace };
}
