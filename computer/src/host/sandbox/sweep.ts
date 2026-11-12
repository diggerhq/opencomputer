// What a `podman` host does about containers it did not start in this life
// (work 103, "Sequences"): at its start it takes the running ones back
// (Host restart), and at every housekeeping pass it removes what belongs to
// no thread (Sweep) and counts what there is (Health).
//
// Invariants:
// - Both begin with an Inventory and do nothing at all when it fails: the next
//   pass tries again. The Inventory lists only this host's containers
//   (containers.ts), so neither ever touches another host's.
// - A running container is taken back only as its record's thread: its token
//   socket is served first, its runner's socket is dialed checked (rule 4),
//   and the first report within 5 s must name the record's key
//   (start-runner.ts `adopt`). Anything else is stopped; nothing is removed
//   for it, and the next message resumes the thread.
// - A container without a record is removed at the start whatever its age
//   (C14: no spare outlives its host). The sweep removes only what is older
//   than `ageMs`, has no record and no connected runner.
// - A home volume is removed only when Podman has no container for its id at
//   all, this host's or another's, there is no record of it, and this host's
//   run directory for the id exists: a volume has no label, and that directory
//   is the only thing that says the id was this host's. It is removed without
//   `--force`, which would take a container using it along.
// - A run directory goes only when its id has no container and no volume, no
//   runner, and nothing touched it (or its record) for `ageMs`: a start makes
//   the directory before the container.
// - Records are never deleted here (prune.ts does, last).

import type net from 'node:net';
import path from 'node:path';
import { lstatSync, readdirSync, rmSync, statfsSync } from 'node:fs';
import { type RunRoot, socketFor } from '../../ipc.js';
import { log } from '../../log.js';
import type { Telemetry } from '../../telemetry/emitter.js';
import type { Containers, Inventory } from './containers.js';
import { TIMEOUTS } from './containers.js';
import type { AsRunner } from './podman.js';
import { emptyRunArgs, volumeRmArgs } from './podman-args.js';
import type { Records, SandboxRecord } from './records.js';

/** "Only objects older than 10 minutes." */
export const SWEEP_AGE_MS = 10 * 60_000;
const SYSTEMCTL = '/usr/bin/systemctl';
const ID = /^[0-9a-f]{16}$/;

export interface SweepDeps {
  as: AsRunner;
  tm: Telemetry;
  records: Pick<Records, 'all' | 'get'>;
  containers: Pick<Containers, 'inventory' | 'stop' | 'remove'>;
  /** `$SP_RUN/sandbox`, and a runner's run root in it. */
  runDir: string;
  runRoot(id: string): RunRoot;
  /** The host's SP_DATA, for its use in percent. */
  dataDir: string;
  /** `tokens.serveRunner`. */
  serveTokens(run: RunRoot, id: string, session: () => string | undefined): { close(): void };
  /** The checked dial of a runner's socket (runner-sockets.ts `dialSocket`); undefined when nothing answers. */
  dial(socket: string): Promise<net.Socket | undefined>;
  /** Take a runner found running on as its record's (start-runner.ts `adopt`, verified); rejects when it is not, having told it to go. */
  adopt(record: SandboxRecord, run: RunRoot, sock: net.Socket): Promise<unknown>;
  /** True while a runner with this id is connected: a thread's, or a spare. */
  running(id: string): boolean;
  /** How old an object must be for the sweep (SP_SWEEP_AGE_MS; 10 minutes). */
  ageMs?: number;
  now?: () => number;
}

/** What one pass removed, by kind (`sandbox.swept`). */
export interface Swept { containers: number; volumes: number; run_dirs: number; units: number }

/** For `host.sample`: containers by Podman's state, `/data` used in percent, `podman system df`'s total in bytes. */
export interface SandboxHealth {
  containers_running: number;
  containers_exited: number;
  containers_created: number;
  containers_other: number;
  data_used_pct?: number;
  podman_bytes?: number;
}

export type SandboxSweep = ReturnType<typeof sandboxSweep>;

const msg = (e: unknown) => (e as Error)?.message ?? String(e);

export function sandboxSweep(d: SweepDeps) {
  const { as, containers: c } = d;
  const now = d.now ?? Date.now;
  const age = d.ageMs ?? SWEEP_AGE_MS;
  let health: SandboxHealth | undefined;

  /** Delete a run directory: what the session wrote goes inside Podman's user namespace, the rest is the host's. Never rejects; true when it is gone. */
  async function deleteRun(id: string): Promise<boolean> {
    const run = d.runRoot(id);
    try {
      await as.podman(emptyRunArgs(run), { timeoutMs: TIMEOUTS.remove }).catch((e) => {
        const lines = String(e?.stderr ?? '').trim().split('\n').filter(Boolean);
        if (!lines.length || !lines.every((l) => /No such file or directory/.test(l))) throw e; // a directory no start ever filled
      });
      rmSync(run, { recursive: true, force: true });
      return true;
    } catch (e) {
      log.warn(`sandbox ${id}: run directory not deleted: ${msg(e)}`);
      return false;
    }
  }

  /** Host restart: take back every running container that is its record's, stop the others, remove what has no record. The ids taken back. */
  async function reconcile(): Promise<Set<string>> {
    const adopted = new Set<string>();
    let inventory: Inventory;
    try {
      inventory = await c.inventory();
    } catch (e) {
      log.warn(`sandbox: no inventory at start (${msg(e)}); the sweep tries again`);
      return adopted;
    }
    await Promise.all(inventory.containers.map(async ({ id, state }) => {
      const record = d.records.get(id);
      if (!record) return void (await c.remove(id), log.info(`sandbox ${id}: a container without a record, removed`));
      if (state !== 'running') return; // the next message resumes it (start.ts)
      const run = d.runRoot(id);
      const t0 = now();
      let tokens: { close(): void } | undefined;
      let sock: net.Socket | undefined;
      try {
        tokens = d.serveTokens(run, id, () => record.key);
        sock = await d.dial(socketFor(run, id));
        if (!sock) throw new Error('nothing answers on its socket');
        await d.adopt(record, run, sock);
        adopted.add(id);
        log.info(`sandbox ${id}: running, taken back for ${record.key} in ${now() - t0} ms`);
      } catch (e) {
        log.warn(`sandbox ${id}: running but not taken back (${msg(e)}); stopping it`);
        sock?.destroy();
        await c.stop(id).catch((x) => log.warn(`sandbox ${id} not stopped: ${msg(x)}`));
        tokens?.close();
      }
    }));
    return adopted;
  }

  /** Failed units of this host's sandboxes (`mine`: the ids with a run directory when the pass began, and every record's), reset so that their names can start again. */
  async function resetFailed(mine: Set<string>): Promise<number> {
    const out = await as.run([SYSTEMCTL, '--user', 'list-units', '--state=failed', '--plain', '--no-legend', 'sp-runner-*.service'], { timeoutMs: TIMEOUTS.unit });
    const units = out.split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((u) => {
      const id = /^sp-runner-([0-9a-f]{16})\.service$/.exec(u)?.[1];
      return !!id && (!!d.records.get(id) || mine.has(id));
    });
    if (units.length) await as.run([SYSTEMCTL, '--user', 'reset-failed', ...units], { timeoutMs: TIMEOUTS.unit });
    return units.length;
  }

  /** The ids that have a run directory. */
  function runDirs(): string[] {
    try {
      return readdirSync(d.runDir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() && ID.test(e.name) ? [e.name] : []));
    } catch {
      return []; // no sandbox ever started
    }
  }

  const exists = (p: string) => !!lstatSync(p, { throwIfNoEntry: false });

  async function measure(inventory: Inventory) {
    const n = (f: (s: string) => boolean) => inventory.containers.filter((x) => f(x.state)).length;
    const named = ['running', 'exited', 'created'];
    const h: SandboxHealth = {
      containers_running: n((s) => s === 'running'), containers_exited: n((s) => s === 'exited'), containers_created: n((s) => s === 'created'),
      containers_other: n((s) => !named.includes(s)),
    };
    try {
      const s = statfsSync(d.dataDir);
      if (s.blocks > 0) h.data_used_pct = Math.round(((s.blocks - s.bavail) / s.blocks) * 100);
    } catch {
      // no figure
    }
    try {
      const rows = JSON.parse(await as.podman(['system', 'df', '--format', 'json'], { timeoutMs: TIMEOUTS.inventory })) as { RawSize?: number }[];
      h.podman_bytes = rows.reduce((sum, r) => sum + (Number(r?.RawSize) || 0), 0);
    } catch (e) {
      log.warn(`sandbox: podman system df: ${msg(e)}`);
    }
    health = h;
  }

  /** One pass. Undefined when the Inventory failed: nothing was looked at. Never rejects. */
  async function sweep(): Promise<Swept | undefined> {
    let inventory: Inventory;
    try {
      inventory = await c.inventory();
    } catch (e) {
      log.warn(`sandbox: no inventory (${msg(e)}); nothing swept this pass`);
      return undefined;
    }
    const swept: Swept = { containers: 0, volumes: 0, run_dirs: 0, units: 0 };
    try {
      const old = (at: number) => now() - at >= age;
      const idle = (id: string) => !d.records.get(id) && !d.running(id);
      const has = new Set([...inventory.containers.map((x) => x.id), ...inventory.foreign]);
      const homes = new Set(inventory.volumes.map((v) => v.id));
      for (const x of inventory.containers) {
        if (!idle(x.id) || !old(x.createdAt)) continue;
        log.info(`sandbox ${x.id}: a container without a record, removed`);
        // Remove takes the home too; what stays of either is the next pass's.
        if (await c.remove(x.id)) (swept.containers++, has.delete(x.id), homes.delete(x.id));
      }
      for (const v of inventory.volumes) {
        if (has.has(v.id) || !homes.has(v.id) || !idle(v.id) || !old(v.createdAt) || !exists(d.runRoot(v.id))) continue;
        await as.podman(volumeRmArgs(v.id), { timeoutMs: TIMEOUTS.remove }).then(
          () => (swept.volumes++, homes.delete(v.id), log.info(`sandbox ${v.id}: a home without a container or a record, removed`)),
          (e) => log.warn(`sandbox ${v.id}: home not removed: ${msg(e)}`),
        );
      }
      const dirs = runDirs();
      for (const id of dirs) {
        if (has.has(id) || homes.has(id) || d.running(id)) continue;
        const st = lstatSync(path.join(d.runDir, id), { throwIfNoEntry: false });
        const used = Date.parse(d.records.get(id)?.usedAt ?? '') || 0;
        if (!st || !old(Math.max(st.mtimeMs, st.ctimeMs, used))) continue;
        if (await deleteRun(id)) swept.run_dirs++;
      }
      swept.units = await resetFailed(new Set(dirs)).catch((e) => (log.warn(`sandbox: failed units not reset: ${msg(e)}`), 0));
      await measure(inventory);
    } catch (e) {
      log.warn(`sandbox: sweep: ${msg(e)}`);
    }
    if (Object.values(swept).some(Boolean)) d.tm.emit('sandbox.swept', { data: { ...swept } });
    return swept;
  }

  return { reconcile, sweep, deleteRun, health: () => health };
}
