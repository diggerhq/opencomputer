// What a `podman` host is made of (work 103): the runners' user, the image of
// its release, the records, the containers and the starts, put together from
// the host's environment. host/main.ts makes one when SP_LAUNCH=podman and
// asks it for nothing else.
//
// Invariant: a `podman` host that cannot sandbox every session does not start.
// Without a runners' user it would run sessions as itself, without SP_IMAGE
// and SP_IMAGE_ABI it has nothing to run them in, and a spare is not a
// container yet; each of these throws here, at boot, never at a first message.

import path from 'node:path';
import type { Person, SessionSpec } from '../../protocol.js';
import type { RunnerApi } from '../../protocol-api.js';
import { type RunRoot, sandboxRunFor, socketFor } from '../../ipc.js';
import { runnerVars } from '../../runner-env.js';
import type { Telemetry } from '../../telemetry/emitter.js';
import { definitionFile, forkDir, mkdirAsRunner } from '../../workspaces/index.js';
import { launch } from '../launch.js';
import { dialSocket } from '../runner-sockets.js';
import { runnerUser } from '../runner-user.js';
import { containers } from './containers.js';
import { asRunner } from './podman.js';
import { type SandboxRecord, sandboxRecords } from './records.js';
import { sandboxStarts } from './start.js';

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
  const all = containers({
    as: asRunner(user.sudo), runRoot, dataDir: d.data, root: d.root, image, abi,
    start: (id, ms) => launch({ id, socket: socketFor(runRoot(id), id), version: d.version }, 'podman', env, d.root, ms),
    vars: () => runnerVars(env), definition: definitionFile, serveTokens: d.serveTokens,
  });
  return { stop: all.stop, starts: sandboxStarts({ tm: d.tm, records, containers: all, runRoot, image, abi, version: d.version,
    mint: d.mint, workspace: sandboxWorkspace, mkdir: mkdirAsRunner, dial: (socket) => dialSocket(socket, { uid: user.uid }) }) };
}
