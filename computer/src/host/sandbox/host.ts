// What a `podman` host is made of (work 103): the runners' user, the image of
// its release, the records, the containers, the starts, the virtual preview
// ports and where a session's terminal and files are, put together from
// the host's environment. host/main.ts makes one when SP_LAUNCH=podman and
// asks it for nothing else.
//
// It also turns the workspaces' two seams its way, once, when it is made: the
// scripts that work on a person's clones with no session run in a helper
// container (scripts.ts), and housekeeping prunes a thread's build
// directories without host git (artifacts.ts), then prunes the threads idle
// beyond retention (prune.ts).
//
// Invariant: a sandbox whose container was removed, by whichever path, has
// its named previews unpreviewed at the gateway before its virtual ports are
// freed; a name the gateway did not hear of stays owed (previews.ts). While
// Podman still has the container (a Remove that failed) it keeps both.
//
// Invariant: a `podman` host that cannot sandbox every session does not start.
// Without a runners' user it would run sessions as itself, without SP_IMAGE
// and SP_IMAGE_ABI it has nothing to run them in, and a spare is not a
// container yet; each of these throws here, at boot, never at a first message.
//
// Invariant: the helpers' token socket gives GitHub tokens for the
// definition's repositories only, for no session (tokens.ts `serveHelper`).

import type net from 'node:net';
import path from 'node:path';
import type { Person, SessionSpec } from '../../protocol.js';
import type { RunnerApi } from '../../protocol-api.js';
import { type RunRoot, sandboxRunFor, socketFor } from '../../ipc.js';
import { log } from '../../log.js';
import { runnerVars } from '../../runner-env.js';
import type { Telemetry } from '../../telemetry/emitter.js';
import { definitionFile, forkDir, loadDefinition, repoSlug, useForkKeeper, useScripts, workspacesEnabled } from '../../workspaces/index.js';
import { launch } from '../launch.js';
import { dialSocket } from '../runner-sockets.js';
import { runnerUser } from '../runner-user.js';
import { sandboxArtifacts } from './artifacts.js';
import { containers } from './containers.js';
import { mounts } from './mounts.js';
import { asRunner } from './podman.js';
import { previewPorts } from './preview-ports.js';
import { type SandboxRecord, sandboxRecords } from './records.js';
import { type SandboxPlace, sandboxScripts } from './scripts.js';
import { sandboxPrune } from './prune.js';
import { sandboxStarts } from './start.js';
import { SWEEP_AGE_MS, sandboxSweep } from './sweep.js';
import { threadLocks } from './thread-lock.js';
import { sandboxWorkspaces } from './workspace.js';

export interface SandboxHostDeps {
  env: NodeJS.ProcessEnv;
  /** HOST_RUN and HOST_DATA. */
  run: string;
  data: string;
  /** The release the host runs from, and its version. */
  root: string;
  version: string;
  /** SP_POOL_SIZE. */
  spares: number;
  tm: Telemetry;
  /** Both are asked for at a start, not here: the host builds what answers them after this. */
  mint(spec: SessionSpec, runnerId: string, run: RunRoot): Promise<RunnerApi | undefined>;
  serveTokens(run: RunRoot, id: string, session: () => string | undefined): { close(): void };
  /** `tokens.serveHelper`. */
  serveHelper(socket: string, allowed: () => string[]): net.Server;
  /** True while the runner with this id is connected. */
  running(id: string): boolean;
  /** Take a runner found running at the host's start on as its record's (start-runner.ts `adopt`, verified). */
  adopt(record: SandboxRecord, run: RunRoot, sock: net.Socket): Promise<unknown>;
  /** A removed sandbox's preview name: tell the gateway (previews.ts `forget`). `from`: its thread, '' when it had no record. */
  unpreview(name: string, from: string): void;
  /** SP_SWEEP_AGE_MS: how old an object without a thread must be for the sweep (10 minutes). */
  sweepAgeMs?: number;
}

/** A sandboxed thread's workspace on the host, from its record: the runner itself knows it as `/workspace`. */
export const sandboxWorkspace = (r: SandboxRecord) => forkDir({ dir: r.person } as Person, r.key);

/** On a `podman` host every thread runs in its own container, and nothing runs outside one. */
export function sandboxHost(d: SandboxHostDeps) {
  const { env } = d;
  const user = runnerUser(env);
  if (!user) throw new Error('SP_LAUNCH=podman needs a runner user (SP_RUNNER_USER): this host would run sessions as itself. deploy/vm/sp-host.sh sets one up.');
  const { SP_IMAGE: image, SP_IMAGE_ABI: abi } = env;
  if (!image || !abi) throw new Error("SP_LAUNCH=podman needs SP_IMAGE and SP_IMAGE_ABI; the release's .sp-version.env sets both");
  if (d.spares) throw new Error('SP_LAUNCH=podman: spares are not containers yet; set SP_POOL_SIZE=0');
  const runRoot = (id: string) => sandboxRunFor(d.run, id);
  const records = sandboxRecords(path.join(d.data, 'state', 'sandboxes'));
  const locks = threadLocks();
  const ports = previewPorts(path.join(d.data, 'state', 'previews.json'));
  const as = asRunner(user.sudo);
  const all = containers({
    as, runRoot, dataDir: d.data, root: d.root, image, abi,
    start: (id, ms) => launch({ id, socket: socketFor(runRoot(id), id), version: d.version }, 'podman', env, d.root, ms),
    vars: () => runnerVars(env), definition: definitionFile, serveTokens: d.serveTokens,
    removed: (id) => {
      for (const e of ports.all()) if (e.id === id && e.name) d.unpreview(e.name, records.get(id)?.key ?? '');
      ports.releaseAll(id);
    },
  });
  const helperRun = path.join(d.run, 'helper');
  const mnt = mounts({ as, root: d.root, dataDir: d.data });
  const scripts = sandboxScripts({ as, sudo: user.sudo, tm: d.tm, root: d.root, dataDir: d.data, helperRun, image, execIn: all.execIn });
  const workspace = sandboxWorkspaces({ as, records, mounts: mnt, scripts: scripts.sessionScripts, pid: all.pid });
  const artifacts = sandboxArtifacts({ as, records, locks, mounts: mnt, helper: scripts.helperScripts, running: d.running });
  // A clones directory is `<people>/<person>/ws`: the helper is that person's.
  useScripts((clonesDir) => scripts.helperScripts(path.basename(path.dirname(clonesDir))));
  const dial = (socket: string) => dialSocket(socket, { uid: user.uid });
  const sweep = sandboxSweep({ as, tm: d.tm, records, locks, containers: all, runDir: path.join(d.run, 'sandbox'), runRoot, dataDir: d.data,
    serveTokens: d.serveTokens, dial, adopt: d.adopt, running: d.running, ageMs: d.sweepAgeMs });
  const prune = sandboxPrune({ as, records, locks, mounts: mnt, helper: scripts.helperScripts, running: d.running, lastUsed: artifacts.lastUsed,
    remove: all.remove, deleteRun: sweep.deleteRun });
  useForkKeeper(async (person) => (await artifacts.pruneIdle(person.dir), prune.pruneIdle(person.dir)));
  return {
    stop: all.stop,
    starts: sandboxStarts({ tm: d.tm, records, locks, containers: all, runRoot, image, abi, version: d.version, mint: d.mint, workspace, workspaces: workspacesEnabled, dial }),
    /** Host restart: the running containers taken back, by id (sweep.ts). */
    reconcile: sweep.reconcile,
    /** One sweep of what belongs to no thread; never rejects. */
    sweep: sweep.sweep,
    /** Containers by state and the disk, as of the last sweep (`host.sample`). */
    health: sweep.health,
    /** Sweep now and from then on, one pass at a time: every half of the age an object must have, at most every 5 minutes. */
    sweeping() {
      let busy = false;
      const pass = () => !busy && ((busy = true), void sweep.sweep().finally(() => (busy = false)));
      pass();
      return setInterval(pass, Math.min(5 * 60_000, Math.max(1000, (d.sweepAgeMs ?? SWEEP_AGE_MS) / 2))).unref();
    },
    /** Where a session's terminal and files are (api-host `sandbox`): from its record, never from what a runner said. */
    async place(spec: SessionSpec): Promise<SandboxPlace | undefined> {
      const r = records.find(spec.owner.dir, spec.key);
      return r && { id: r.id, person: r.person, workspace: mnt.workspace(r), running: await all.unitActive(r.id) };
    },
    /** Where the `/files` scripts of a place run (api-wire.ts). */
    files: scripts.filesPlace,
    /** The virtual ports, and how a container's preview socket is reached (previews.ts). */
    previews: { ports, run: runRoot, uid: user.uid },
    /** `checkout_repo` of a sandboxed session, by its runner id. */
    checkout: workspace.checkout,
    /** A delivery to a sandboxed session: its record is used now. */
    touch: workspace.touch,
    /** The definition in effect changed: every running container reads the new one. `ids`: the runners connected. */
    definitionChanged(ids: string[]) {
      for (const id of ids)
        try {
          all.rewriteDefinition(id);
        } catch (e) {
          log.warn(`sandbox ${id}: definition not rewritten: ${(e as Error)?.message ?? e}`);
        }
    },
    /** Open the helpers' token socket; the caller closes it when the host stops. */
    serveHelpers: () => d.serveHelper(path.join(helperRun, 'token.sock'), () => (workspacesEnabled() ? loadDefinition().repos.map((r) => repoSlug(r.remote)) : [])),
  };
}
