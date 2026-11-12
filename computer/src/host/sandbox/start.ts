// Starting a thread's runner in its container (work 103, "Sequences"): the
// new thread and the resume, one orchestration (cold-start.ts) for both.
// start-runner.ts adopts what this returns and sends the frames, as it does
// for every other runner.
//
// Invariants:
// - A thread has a record before it has a container, and the record decides:
//   a hit resumes under the record's id, a miss is a new thread, which starts
//   with no transcript and no fork path whatever the gateway sent.
// - The runner's view of its workspace is `/workspace`, in the spec it boots
//   from; the host path never goes in.
// - A start that fails leaves no container running and no token socket open;
//   the record stays, so the next message resumes under the same id (and
//   creates the container it does not find). That holds for whoever takes the
//   started runner on, too: `Started.abandon` is theirs to call.
// - A transcript lives in the thread's home: `sdkSessionId` goes in only when
//   the home volume was there before this start. A record alone (a first
//   start whose Create failed, a volume removed) is a new home.
// - The thread's workspace directory and its registries are made at every
//   start: a first start may have failed before they were. The mounts
//   (workspace.ts) are part of bringing the container up.
// - A thread whose record has no `repos` gets its workspace prepared while its
//   runner boots; the runner is connected to, and so given credentials and
//   its first message, only after that. A start whose preparation failed is
//   abandoned and its record keeps no `repos`, so the next start prepares
//   again.
// - `runner.launched` is one event per start with the container's timings,
//   `container.add_ms` among them: it is emitted once the worktrees were
//   added, with the time and the duration of the launch itself.
// - A start's error is one line. Why a runner never listened goes to the
//   host's log, never into the error (it reaches the gateway's reply).
// - The runner's socket is in a directory the session can write: it is
//   connected to only when it is a socket, and to the file that was checked
//   (runner-sockets.ts `dialSocket`, checked-socket.ts).

import type net from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { RunnerSpec, SessionSpec } from '../../protocol.js';
import type { RunnerApi } from '../../protocol-api.js';
import { type RunRoot, socketFor } from '../../ipc.js';
import { log } from '../../log.js';
import type { Telemetry } from '../../telemetry/emitter.js';
import type { Dimensions } from '../../telemetry/envelope.js';
import { coldStart } from '../cold-start.js';
import { awaitRunner, dialSocket } from '../runner-sockets.js';
import type { Containers, Inventory } from './containers.js';
import { WORKSPACE } from './mounts.js';
import type { Records, SandboxRecord } from './records.js';
import type { SandboxWorkspace } from './workspace.js';

export { WORKSPACE };

export interface SandboxStartDeps {
  tm: Telemetry;
  records: Records;
  containers: Pick<Containers, 'create' | 'up' | 'stop' | 'remove' | 'recreate' | 'inventory' | 'stale' | 'unitActive' | 'diagnose'>;
  runRoot(id: string): RunRoot;
  /** SP_IMAGE and SP_IMAGE_ABI of the host's release. */
  image: string;
  abi: string;
  version: string;
  /** The session's journal, socket (below `run`) and token for this runner; undefined off the API. */
  mint(spec: SessionSpec, runnerId: string, run: RunRoot): Promise<RunnerApi | undefined>;
  /** The thread's files: directories, mounts, worktrees (workspace.ts). */
  workspace: Pick<SandboxWorkspace, 'repos' | 'dirs' | 'binds' | 'mount' | 'prepare'>;
  /** True when a workspace definition is in effect (`workspacesEnabled`). */
  workspaces(): boolean;
  /** Connect to a runner's socket; undefined when nothing answers. */
  dial?: (socket: string) => Promise<net.Socket | undefined>;
}

export interface Started {
  record: SandboxRecord;
  run: RunRoot;
  sock: net.Socket;
  /** The session as the runner got it: without a transcript when the thread is new. */
  session: SessionSpec;
  /** With its token, for the `api` frame. */
  api?: RunnerApi;
  resumed: boolean;
  /** The runner is not taken on after all: stop its container and close its token socket. Never rejects. */
  abandon(): Promise<void>;
}

export type SandboxStarts = ReturnType<typeof sandboxStarts>;

/** The image's tag, shortened as telemetry carries it. */
export const imageTag = (image: string) => image.slice(image.lastIndexOf(':') + 1).slice(0, 12);

export function sandboxStarts(d: SandboxStartDeps) {
  const { tm, containers: c } = d;
  const dial = d.dial ?? dialSocket;

  /** The container for a thread that has a record: there, of this ABI and not left running by anything; made again otherwise. */
  async function ready(id: string, inventory: Inventory): Promise<{ recreated: boolean; ms?: number }> {
    const found = inventory.containers.find((x) => x.id === id);
    if (!found || found.abi !== d.abi || (await c.stale(found))) {
      log.info(`sandbox ${id}: ${!found ? 'no container' : found.abi !== d.abi ? `ABI ${found.abi}, now ${d.abi}` : 'stale'}; creating it again`);
      return { recreated: true, ms: await c.recreate(id) };
    }
    // Running with nobody connected (the host restarted): stopped, so that it starts with a fresh run directory and token socket.
    if (found.state !== 'created' && found.state !== 'exited') await c.stop(id);
    return { recreated: false };
  }

  /** Start the runner of `spec`'s thread and connect to it. `f`: the delivery's trace. */
  async function start(spec: SessionSpec, f: Dimensions): Promise<Started> {
    const now = new Date().toISOString();
    const found = d.records.find(spec.owner.dir, spec.key);
    const { sdkSessionId, forkPath: _fork, ...fresh } = spec;
    let record: SandboxRecord = found ? { ...found, usedAt: now } : { id: randomBytes(8).toString('hex'), person: spec.owner.dir, key: spec.key, createdAt: now, usedAt: now };
    d.records.write(record);
    const { id } = record;
    const run = d.runRoot(id);
    let rs: RunnerSpec = { id, socket: socketFor(run, id), version: d.version };
    const data: Record<string, string | number | boolean> = { launch_mode: 'podman', image: imageTag(d.image) };
    const t0 = Date.now();
    let session: SessionSpec = fresh; // a new home has no transcript
    let api: RunnerApi | undefined;
    let tokens: { close(): void } | undefined;
    const abandon = async () => {
      await c.stop(id).catch((e) => log.warn(`sandbox ${id} not stopped after a failed start: ${e?.message ?? e}`));
      tokens?.close();
    };
    // What this start mounts; a thread without `repos` yet also gets a worktree of each (`prepare`).
    let names: string[] = [];
    const prepares = d.workspaces() && !record.repos;
    let launch: { at: number; ms: number } | undefined;
    const launched = (failed = false) => {
      if (!launch) return;
      tm.emit('runner.launched', { ...f, duration_ms: launch.ms, outcome: failed ? 'failed' : 'completed', ...(failed && { error_type: 'launch' as const }), data }, launch.at);
      launch = undefined;
    };
    const sock = await coldStart({
      up: async () => {
        const began = Date.now();
        try {
          names = d.workspace.repos(record);
          await d.workspace.dirs(record, names);
          const inventory = found && (await c.inventory());
          // The transcript is in the home: resumed only into one that was there before this start.
          if (sdkSessionId && inventory && inventory.volumes.some((v) => v.id === id)) session = { ...fresh, sdkSessionId };
          api = await d.mint(session, id, run);
          rs = { ...rs, session: { ...session, forkPath: WORKSPACE }, api: api && { ...api, token: '' } };
          if (inventory) {
            const r = await ready(id, inventory);
            data['container.recreated'] = r.recreated;
            if (r.ms !== undefined) data['container.create_ms'] = r.ms;
          } else {
            data['container.create_ms'] = await c.create(id).catch(async (e) => {
              await c.remove(id); // whatever a failed Create left; the record stays
              throw e;
            });
          }
          const binds = d.workspace.binds(record, names, api && path.dirname(api.journal));
          const up = await c.up(id, rs, record, (pid) => d.workspace.mount(id, pid, record.person, binds));
          tokens = up.tokens;
          data['container.start_ms'] = up.startMs;
          if (up.mountMs !== undefined) data['container.mount_ms'] = up.mountMs;
          launch = { at: Date.now(), ms: Date.now() - began };
          if (!prepares) launched();
        } catch (e) {
          launch = { at: Date.now(), ms: Date.now() - began };
          launched(true);
          throw e;
        }
      },
      prepare: prepares
        ? async () => {
            const done = tm.start('fork.done', f);
            try {
              const p = await d.workspace.prepare(id, names);
              record = p.record;
              data['container.add_ms'] = p.addMs;
              done.end({ outcome: 'completed', data: { repos: Object.keys(p.record.repos ?? {}).length } });
            } catch (e) {
              done.end({ outcome: 'failed', error_type: 'git_worktree', data: { fork_error_type: 'git_worktree' } });
              throw e;
            } finally {
              launched();
            }
          }
        : undefined,
      ready: () =>
        awaitRunner(rs, {
          tm, f, t0,
          dial: () => dial(rs.socket),
          late: async () => log.warn(`sandbox ${id} never listened:\n${(await c.diagnose(id)).slice(-4000)}`),
        }),
      abandon,
    });
    return { record, run, sock, session, api, resumed: !!found, abandon };
  }

  return { start };
}
