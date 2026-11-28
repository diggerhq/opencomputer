// Build offload (work 136): the line protocol between the host and the
// offload service (src/offload/, its own systemd unit and user), and between a
// session's `oc-offload` and the host's per-runner relay (host/offload-relay.ts).
// The only thing those processes share.
//
// One JSON line in, one JSON line out, one request per connection, on
// `/run/opencomputer-offload/control.sock` (the host's) or
// `<run>/tokens/<runnerId>.offload.sock` (a session's).
//
// Invariants:
// - A session never names its fence: the relay drops whatever `fence` it sent
//   and attaches the host's ({org, sessionKey from the sandbox record,
//   runnerId, epoch of the served socket}). The service refuses a job request
//   whose fence is not the job's, field for field.
// - `cancelFence` and an unfenced `health` come from the host alone: the relay
//   forwards neither.
// - Nothing here carries an AWS credential, endpoint or token; a session gets
//   presigned S3 URLs and nothing else.

import net from 'node:net';
import path from 'node:path';

export const OFFLOAD_CONTROL = '/run/opencomputer-offload/control.sock';
export const OFFLOAD_SIZES = ['s', 'm'] as const;
export type OffloadSize = (typeof OFFLOAD_SIZES)[number];

/** A runner's offload socket, beside its token socket (`tokenSocketFor`), in the directory only the host writes. */
export const offloadSocketFor = (run: string, id: string) => path.join(run, 'tokens', `${id}.offload.sock`);

/** Who asks, in the host's word. `epoch`: the served socket's, larger for every socket the host serves. */
export interface Fence {
  org: string;
  sessionKey: string;
  runnerId: string;
  epoch: number;
}

export const sameFence = (a: Fence, b: Fence) => a.org === b.org && a.sessionKey === b.sessionKey && a.runnerId === b.runnerId && a.epoch === b.epoch;

export type JobState = 'submitted' | 'queued' | 'launching' | 'running' | 'done' | 'failed' | 'cancelled' | 'timeout';
export const TERMINAL: ReadonlySet<JobState> = new Set(['done', 'failed', 'cancelled', 'timeout']);

export interface JobView {
  id: string;
  state: JobState;
  size: OffloadSize;
  cmd: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  /** What the builder agent last said (`downloading`, `running`, `uploading`, …), while it runs. */
  agentState?: string;
  exitCode?: number;
  error?: string;
  artifactSha256?: string;
  artifactBytes?: number;
  /** 1-based, while queued. */
  queuePosition?: number;
}

/** What a session may ask; the relay forwards these and only these. */
export type SessionRequest =
  | { op: 'health' }
  | { op: 'submit'; size: OffloadSize; cmd: string; artifacts: string[]; timeoutMin?: number; sourceBytes: number }
  | { op: 'start'; id: string }
  | { op: 'status'; id: string }
  | { op: 'logs'; id: string; offset: number }
  | { op: 'cancel'; id: string }
  | { op: 'fetch'; id: string }
  | { op: 'list' };
export const SESSION_OPS: ReadonlySet<string> = new Set(['health', 'submit', 'start', 'status', 'logs', 'cancel', 'fetch', 'list']);

export type ControlRequest = (SessionRequest & { fence?: Fence }) | { op: 'cancelFence'; fence: Fence } | { op: 'drain'; timeoutSec?: number };

export interface Health {
  ready: boolean;
  /** Why not, when not. */
  reason?: string;
  draining: boolean;
  running: number;
  queued: number;
  maxConcurrent: number;
  maxMinutes: number;
  sourceMaxMb: number;
  artifactMaxMb: number;
  sizes: OffloadSize[];
}

export type ControlResponse =
  | ({ ok: true } & Record<string, unknown>)
  | { ok: false; error: string; code?: 'unavailable' | 'refused' | 'not-found' | 'over-cap' | 'bad-request' | 'stale-fence' };

/** A request line longer than this is refused (a command and its artifact list fit many times over). */
export const MAX_LINE = 256 * 1024;

/** The first JSON line on `sock`; rejects on a bad or overlong line, or a close before one. */
export function readLine(sock: net.Socket, max = MAX_LINE): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buf = '';
    sock.setEncoding('utf8');
    const done = (f: () => void) => (sock.off('data', data), sock.off('end', end), sock.off('error', reject), f());
    const end = () => done(() => reject(new Error('closed before a line')));
    const data = (d: string) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0 && buf.length <= max) return;
      if (i < 0 || i > max) return done(() => reject(new Error('request line too long')));
      done(() => {
        try {
          resolve(JSON.parse(buf.slice(0, i)));
        } catch {
          reject(new Error('not a JSON line'));
        }
      });
    };
    sock.on('data', data);
    sock.once('end', end);
    sock.once('error', reject);
  });
}

/** One request to a line socket, its one answer; rejects on no answer within `timeoutMs`. */
export function askLine(socket: string, req: object, timeoutMs = 30_000): Promise<ControlResponse> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socket);
    const timer = setTimeout(() => (sock.destroy(), reject(new Error(`no answer from ${socket} in ${timeoutMs} ms`))), timeoutMs);
    sock.once('error', (e) => (clearTimeout(timer), reject(e)));
    sock.once('connect', () => sock.write(JSON.stringify(req) + '\n'));
    readLine(sock, 16 * MAX_LINE).then(
      (r) => (clearTimeout(timer), sock.end(), resolve(r as ControlResponse)),
      (e) => (clearTimeout(timer), sock.destroy(), reject(e)),
    );
  });
}
