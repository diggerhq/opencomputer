// A thread's container through its life (work 103): create, bring up, stop,
// remove, recreate, list. Every Podman call is an argv from podman-args.ts,
// run as the runners' user (podman.ts) with the timeout of the spec's
// "Timeouts and failures" table, which TIMEOUTS holds.
//
// Invariants:
// - The host writes only the root of a run directory and its `tokens/`
//   (sessions can write neither), by temporary file and rename; what a session
//   may write (`runners/`, `secrets/`) is emptied before every start.
// - A start that fails after Start leaves no container running: `up` stops it
//   and closes its token socket before it rejects.
// - Stop never signals the unit (`systemctl --user kill` takes conmon with the
//   payload, and Podman then says `running` for ever): past its timeout it
//   kills the payload's cgroup.
// - A container whose unit is not active is not running, whatever Podman says:
//   `stale` is how callers ask, and they recreate it. Recreating costs the
//   container what it installed, so `stale` is never said of one that only
//   ended between two looks.
// - `stop` resolves only for a container that is down: one that outlived
//   Podman's stop and the kill of its cgroup rejects.

import path from 'node:path';
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { RunnerSpec } from '../../protocol.js';
import { type RunRoot, runnersDir, secretsFor, tokenSocketFor } from '../../ipc.js';
import { log } from '../../log.js';
import { bootEnv } from './boot-env.js';
import type { AsRunner } from './podman.js';
import {
  containerName, createArgs, emptyRunArgs, execArgs, inventoryArgs, logsArgs, pidArgs, recreateRemoveArgs, removeArgs, stopArgs, unitName,
} from './podman-args.js';
import type { SandboxRecord } from './records.js';

/** Milliseconds, from the spec's table. `start` bounds the unit's start, `pid` the wait for the container's first process after it. */
export const TIMEOUTS = { create: 60_000, start: 20_000, pid: 5_000, stop: 15_000, remove: 30_000, inventory: 10_000, unit: 5_000 } as const;
const PID_POLL_MS = 20;
const SYSTEMCTL = '/usr/bin/systemctl';

export interface ContainerInfo {
  /** The runner id (label `sp.runner`). */
  id: string;
  /** Podman's word: created, running, stopping, exited, … */
  state: string;
  /** The image ABI it was created under (label `sp.abi`). */
  abi: string;
  image: string;
  /** Unix milliseconds. */
  createdAt: number;
}

export interface Inventory {
  containers: ContainerInfo[];
  /** Home volumes, by runner id. */
  volumes: { id: string; createdAt: number }[];
}

export interface ContainersDeps {
  as: AsRunner;
  /** Start the container's unit (launch.ts, the `podman` branch); resolves once the unit is started. */
  start(id: string, timeoutMs: number): Promise<void>;
  /** A runner's run root (`sandboxRunFor`). */
  runRoot(id: string): RunRoot;
  /** The host's SP_DATA, release, and the image and ABI of that release. */
  dataDir: string;
  root: string;
  image: string;
  abi: string;
  /** `runnerVars(env)`, read at every start. */
  vars(): Record<string, string>;
  /** The definition file in effect, if any (`definitionFile`). */
  definition(): string | undefined;
  /** `tokens.serveRunner`. */
  serveTokens(run: RunRoot, id: string, session: () => string | undefined): { close(): void };
  /** A sandbox was removed: what else the host keeps by its id goes too (its preview ports, C9). */
  removed?(id: string): void;
  sleep?: (ms: number) => Promise<void>;
}

export interface Up {
  /** The container's first process, as the host sees it. */
  pid: number;
  /** Its token socket, open since before the start; the caller closes it when the runner is gone. */
  tokens: { close(): void };
  /** Start until Pid. */
  startMs: number;
}

export type Containers = ReturnType<typeof containers>;

/** Write `file` whole: a temporary file beside it, then a rename. */
function writeWhole(file: string, text: string, mode: number) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode); // the umask may have taken bits
  renameSync(tmp, file);
}

function dir(p: string, mode: number) {
  mkdirSync(p, { recursive: true });
  chmodSync(p, mode);
}

const absent = (e: unknown) => /no such container|no container with name or ID/i.test(String((e as { stderr?: string })?.stderr ?? ''));

export function containers(d: ContainersDeps) {
  const { as } = d;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  /** Create the container (60 s). Its run directory is a mount source, so it exists first. Resolves with the time taken. */
  async function create(id: string): Promise<number> {
    const t0 = Date.now();
    const run = d.runRoot(id);
    dir(run, 0o2750);
    await as.podman(createArgs({ id, run, dataDir: d.dataDir, image: d.image, abi: d.abi }), { timeoutMs: TIMEOUTS.create });
    return Date.now() - t0;
  }

  /** True when the container's unit is active. */
  const unitActive = (id: string) =>
    as.run([SYSTEMCTL, '--user', 'is-active', '--quiet', unitName(id)], { timeoutMs: TIMEOUTS.unit }).then(() => true, () => false);

  /** The run directory as a start needs it: what the session wrote gone, the host's files current. */
  async function prepareRun(id: string, spec: RunnerSpec) {
    const run = d.runRoot(id);
    await as.podman(emptyRunArgs(run), { timeoutMs: TIMEOUTS.remove }).catch((e) => {
      const lines = String(e?.stderr ?? '').trim().split('\n').filter(Boolean);
      if (!lines.length || !lines.every((l) => /No such file or directory/.test(l))) throw e; // a first start has neither directory
    });
    dir(run, 0o2750);
    dir(runnersDir(run), 0o2770);
    dir(path.dirname(secretsFor(run, id)), 0o2770);
    dir(path.dirname(tokenSocketFor(run, id)), 0o2750);
    const def = d.definition();
    if (def) writeWhole(path.join(run, 'definition.json'), readFileSync(def, 'utf8'), 0o640);
    else rmSync(path.join(run, 'definition.json'), { force: true });
    writeWhole(path.join(run, 'boot.env'), bootEnv({ root: d.root, spec, vars: d.vars() }), 0o640);
    return run;
  }

  /** The container's first process once it has one (polled every 20 ms, 5 s in all). */
  async function pid(id: string): Promise<number> {
    const end = Date.now() + TIMEOUTS.pid;
    for (;;) {
      const left = end - Date.now();
      const out = left > 0 ? await as.podman(pidArgs(id), { timeoutMs: left }).catch(() => '') : '';
      const n = Number(out.trim());
      if (Number.isInteger(n) && n > 0) return n;
      if (Date.now() + PID_POLL_MS >= end) throw new Error(`container ${containerName(id)} has no process ${TIMEOUTS.pid} ms after its start`);
      await sleep(PID_POLL_MS);
    }
  }

  /**
   * Bring the created container up for `spec`: its run directory, its token socket, Start, then Pid.
   * `record`: the thread it serves; none for a container that serves no thread yet.
   */
  async function up(id: string, spec: RunnerSpec, record?: SandboxRecord): Promise<Up> {
    const run = await prepareRun(id, spec);
    const tokens = d.serveTokens(run, id, () => record?.key);
    const t0 = Date.now();
    try {
      await d.start(id, TIMEOUTS.start);
      const p = await pid(id);
      // Podman's pid is the previous run's when the unit never came up: never trusted while the unit is inactive.
      if (!(await unitActive(id))) throw new Error(`unit ${unitName(id)} is not active after its start`);
      return { pid: p, tokens, startMs: Date.now() - t0 };
    } catch (e) {
      await stop(id).catch((x) => log.warn(`container ${id} not stopped after a failed start: ${x?.message ?? x}`));
      tokens.close();
      throw e;
    }
  }

  /** Kill the payload's cgroup, as the runners' user, and wait for the unit to go (5 s). True when nothing runs in the unit any more. */
  async function killPayload(id: string): Promise<boolean> {
    const cgroup = (await as.run([SYSTEMCTL, '--user', 'show', '-p', 'ControlGroup', '--value', unitName(id)], { timeoutMs: TIMEOUTS.unit })).trim();
    if (!cgroup.startsWith('/') || !cgroup.endsWith(`/${unitName(id)}`)) return true; // no such unit: nothing is running in it
    await as.run(['/bin/sh', '-c', 'for d in "$1"/libpod-payload-*; do [ -e "$d/cgroup.kill" ] && echo 1 > "$d/cgroup.kill"; done; true', 'sh', `/sys/fs/cgroup${cgroup}`],
      { timeoutMs: TIMEOUTS.unit });
    for (const end = Date.now() + TIMEOUTS.unit; ; await sleep(100)) {
      if (!(await unitActive(id))) return true;
      if (Date.now() >= end) return false;
    }
  }

  /**
   * Stop the container: SIGTERM, SIGKILL after `seconds` (15 s in all), then the payload's cgroup if Podman did not manage.
   * Resolves when it is down or was never there; rejects, in one line, when its unit is still active after all that.
   */
  async function stop(id: string, seconds = 10): Promise<void> {
    try {
      await as.podman(stopArgs(id, seconds), { timeoutMs: TIMEOUTS.stop });
    } catch (e) {
      if (absent(e)) return;
      log.warn(`podman stop ${containerName(id)} failed (${(e as Error)?.message ?? e}); killing its cgroup`);
      if (!(await killPayload(id))) throw new Error(`container ${containerName(id)} did not stop: its unit is still active after its cgroup was killed`);
    }
  }

  /** Remove the container and its home (30 s each). Never rejects: what stays is logged and the sweep's. True when both went. */
  async function remove(id: string): Promise<boolean> {
    let ok = true;
    for (const args of removeArgs(id))
      await as.podman(args, { timeoutMs: TIMEOUTS.remove }).catch((e) => {
        ok = false;
        log.warn(`sandbox ${id} not removed: ${e?.message ?? e}`);
      });
    d.removed?.(id);
    return ok;
  }

  /** Remove the container alone and create it again from the current image; the home volume stays. Resolves with the time taken. */
  async function recreate(id: string): Promise<number> {
    const t0 = Date.now();
    await as.podman(recreateRemoveArgs(id), { timeoutMs: TIMEOUTS.remove });
    await create(id);
    return Date.now() - t0;
  }

  /** Every sandbox container and home volume Podman has (10 s each). */
  async function inventory(): Promise<Inventory> {
    const args = inventoryArgs();
    const [cs, vs] = await Promise.all([as.podman(args.containers, { timeoutMs: TIMEOUTS.inventory }), as.podman(args.volumes, { timeoutMs: TIMEOUTS.inventory })]);
    const list = (text: string): { Labels?: Record<string, string>; Names?: string[]; Name?: string; State?: string; Image?: string; Created?: number; CreatedAt?: string }[] => {
      const v = JSON.parse(text.trim() || '[]');
      if (!Array.isArray(v)) throw new Error('podman: not a list');
      return v;
    };
    return {
      containers: list(cs).flatMap((c) => {
        const id = c?.Labels?.['sp.runner'];
        // The label and the name agree for every container the host made; anything else is not ours to touch.
        if (typeof id !== 'string' || !c.Names?.includes?.(containerName(id))) return [];
        return [{ id, state: String(c.State ?? ''), abi: String(c.Labels?.['sp.abi'] ?? ''), image: String(c.Image ?? ''), createdAt: Number(c.Created ?? 0) * 1000 }];
      }),
      volumes: list(vs).flatMap((v) => {
        const m = /^sp-home-(.+)$/.exec(String(v?.Name ?? ''));
        return m ? [{ id: m[1], createdAt: Date.parse(String(v.CreatedAt ?? '')) || 0 }] : [];
      }),
    };
  }

  const runs = (state: string | undefined) => state === 'running' || state === 'stopping';

  /**
   * Podman says it runs, its unit says nothing does: the unit was killed from outside. `podman start` does nothing to it and `podman stop` never ends.
   * `c` is a moment old, and a container that ends by itself is `exited` to Podman before its unit is gone: so Podman is asked again once the unit
   * is seen inactive, and only one it still calls running is stale. A unit whose state could not be read (no answer) rejects: that is not "inactive".
   */
  async function stale(c: ContainerInfo): Promise<boolean> {
    if (!runs(c.state)) return false;
    const inactive = await as.run([SYSTEMCTL, '--user', 'is-active', '--quiet', unitName(c.id)], { timeoutMs: TIMEOUTS.unit }).then(
      () => false,
      (e) => {
        if ((e as { timedOut?: boolean })?.timedOut) throw e;
        return true;
      },
    );
    return inactive && runs((await inventory()).containers.find((x) => x.id === c.id)?.state);
  }

  /** A command in the running container, as the session's user: its stdout. */
  const execIn = (id: string, argv: string[], o: { dir: string; timeoutMs: number; stdin?: string }) =>
    as.podman(execArgs(id, argv, { dir: o.dir, interactive: o.stdin !== undefined }), { timeoutMs: o.timeoutMs, stdin: o.stdin });

  /** For the error of a start that never became ready: the unit's status and the last 50 lines the container wrote. */
  const diagnose = (id: string) =>
    as.run(['/bin/sh', '-c', `${SYSTEMCTL} --user status --no-pager --lines=0 "$1" 2>&1 | cut -c1-200; echo '--- podman logs'; /usr/bin/podman ${logsArgs(id).slice(0, -1).join(' ')} "$2" 2>&1; true`,
      'sh', unitName(id), containerName(id)], { timeoutMs: TIMEOUTS.inventory }).then((s) => s.trim(), (e) => `no diagnosis: ${e?.message ?? e}`);

  return { create, up, stop, remove, recreate, inventory, execIn, stale, unitActive, diagnose };
}
