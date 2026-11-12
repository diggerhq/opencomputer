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
//   creates the container it does not find).
// - The runner's socket is in a directory the session can write: it is
//   connected to only when it is a socket, and to the file that was checked
//   (runner-sockets.ts `dialSocket`, checked-socket.ts).

import type net from 'node:net';
import { randomBytes } from 'node:crypto';
import type { RunnerSpec, SessionSpec } from '../../protocol.js';
import type { RunnerApi } from '../../protocol-api.js';
import { type RunRoot, socketFor } from '../../ipc.js';
import { log } from '../../log.js';
import type { Telemetry } from '../../telemetry/emitter.js';
import type { Dimensions } from '../../telemetry/envelope.js';
import { coldStart } from '../cold-start.js';
import { awaitRunner, dialSocket } from '../runner-sockets.js';
import type { Containers } from './containers.js';
import type { Records, SandboxRecord } from './records.js';

/** The session's fork, as its runner sees it. */
export const WORKSPACE = '/workspace';

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
  /** The thread's workspace on the host (`forkDir`). */
  workspace(r: SandboxRecord): string;
  /** `mkdir -p` as the runners' user. */
  mkdir(dir: string): Promise<void>;
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
}

export type SandboxStarts = ReturnType<typeof sandboxStarts>;

/** The image's tag, shortened as telemetry carries it. */
export const imageTag = (image: string) => image.slice(image.lastIndexOf(':') + 1).slice(0, 12);

export function sandboxStarts(d: SandboxStartDeps) {
  const { tm, containers: c } = d;
  const dial = d.dial ?? dialSocket;

  /** The container for a thread that has a record: there, of this ABI and not left running by anything; made again otherwise. */
  async function ready(id: string): Promise<{ recreated: boolean; ms?: number }> {
    const found = (await c.inventory()).containers.find((x) => x.id === id);
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
    const { sdkSessionId: _transcript, forkPath: _fork, ...fresh } = spec;
    const session: SessionSpec = found ? spec : fresh; // a new home has no transcript
    const record: SandboxRecord = found ? { ...found, usedAt: now } : { id: randomBytes(8).toString('hex'), person: spec.owner.dir, key: spec.key, createdAt: now, usedAt: now };
    d.records.write(record);
    const { id } = record;
    const run = d.runRoot(id);
    const api = await d.mint(session, id, run);
    const rs: RunnerSpec = { id, session: { ...session, forkPath: WORKSPACE }, socket: socketFor(run, id), api: api && { ...api, token: '' }, version: d.version };
    const data: Record<string, string | number | boolean> = { launch_mode: 'podman', image: imageTag(d.image) };
    const t0 = Date.now();
    let tokens: { close(): void } | undefined;
    const sock = await coldStart({
      up: async () => {
        const launched = tm.start('runner.launched', { ...f, data });
        try {
          if (found) {
            const r = await ready(id);
            data['container.recreated'] = r.recreated;
            if (r.ms !== undefined) data['container.create_ms'] = r.ms;
          } else {
            await d.mkdir(d.workspace(record));
            data['container.create_ms'] = await c.create(id).catch(async (e) => {
              await c.remove(id); // whatever a failed Create left; the record stays
              throw e;
            });
          }
          const up = await c.up(id, rs, record);
          tokens = up.tokens;
          data['container.start_ms'] = up.startMs;
          launched.end({ outcome: 'completed', data });
        } catch (e) {
          launched.end({ outcome: 'failed', error_type: 'launch', data });
          throw e;
        }
      },
      ready: () =>
        awaitRunner(rs, {
          tm, f, t0,
          dial: () => dial(rs.socket),
          why: async () => {
            const why = await c.diagnose(id);
            log.warn(`sandbox ${id} never listened:\n${why}`);
            return why.slice(-4000);
          },
        }),
      abandon: async () => {
        await c.stop(id).catch((e) => log.warn(`sandbox ${id} not stopped after a failed start: ${e?.message ?? e}`));
        tokens?.close();
      },
    });
    return { record, run, sock, session, api, resumed: !!found };
  }

  return { start };
}
