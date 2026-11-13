// What a runner in a container that serves no thread may say (work 103, step
// 10): a spare, from its start until it is bound (sandbox/spares.ts `bind`).
//
// Invariant: on a `podman` host no frame of a runner is handled for the
// session ''. A runner with no record has no thread to ask anything for: its
// state (`spare`), its telemetry and its replies to the host's calls are read;
// a request gets its answer with an error, at once, and nothing else is read.
// From the moment it is bound its key is its record's (start-runner.ts), so
// what it asks for between the bind and the claim's answer is that thread's.

import type { HostToRunner, RunnerToHost } from '../protocol.js';

export const NO_THREAD = 'this runner serves no thread';

/** The answer's `t` for each request a runner makes. */
const ANSWERS = {
  token: 'token',
  spawn: 'spawned',
  read: 'thread',
  post: 'posted',
  'secret-request': 'secret-asked',
  preview: 'previewed',
  unpreview: 'previewed',
  checkout: 'checked-out',
} as const;

/** True for what a runner with no thread is heard on. A `report` is not among them: start-runner.ts stops the runner that sends one. */
export const spareMay = (m: RunnerToHost) => m.t === 'spare' || m.t === 'telemetry' || m.t === 'reply';

/** The refusal of a request from a runner with no thread; undefined for a frame that has no answer (it is dropped). */
export const refusal = (m: RunnerToHost): HostToRunner | undefined =>
  m.t in ANSWERS && 'id' in m ? ({ t: ANSWERS[m.t as keyof typeof ANSWERS], id: m.id, error: NO_THREAD } satisfies HostToRunner) : undefined;
