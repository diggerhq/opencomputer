// Starting runners and taking them on (work 045, 069; split out of host/main.ts
// for work 103): `adopt` makes a connected runner the host's (its session's, or
// a spare), `startRunner` gets a session its runner (a claimed spare, else a
// cold start in its fork; on a `podman` host its thread's container,
// sandbox/start.ts), `launchSpare` starts one for the pool.
// host/main.ts keeps the registry (`runners`), what a runner's messages mean,
// and delivery; it passes those in as `StartDeps`.
//
// Invariants:
// - A runner gets `credentials` only once adoption took it (adoption.ts):
//   never one whose fork is incomplete.
// - A new session in a prepared workspace may take a spare; a resumed one
//   always starts cold, to resume.
// - The API token of a cold-started runner goes over its socket, never in
//   argv or the environment.
// - A sandboxed runner serves the thread of its record (work 103): the key is
//   the record's, and a report naming another stops the runner.
// - A sandboxed runner that started and was not adopted (it exited meanwhile,
//   or adoption refused it) leaves no container running and no token socket.

import type net from 'node:net';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import type {
  HarnessName,
  HostCredentials,
  HostToGateway,
  HostToRunner,
  Person,
  RunnerToHost,
  SessionReport,
  SessionSpec,
  SpareReport,
} from '../protocol.js';
import type { RunnerApi } from '../protocol-api.js';
import { forkDir, forkInfo, mkdirAsRunner, workspacePrepared, workspacesEnabled } from '../workspaces/index.js';
import { type RunRoot, lines, send, socketFor } from '../ipc.js';
import { log } from '../log.js';
import type { Telemetry } from '../telemetry/emitter.js';
import type { Dimensions } from '../telemetry/envelope.js';
import { credentialFingerprint } from '../credential-fingerprint.js';
import { adoption, type First } from './adoption.js';
import { claimSpare } from './claim.js';
import { coldStart, forkFor } from './cold-start.js';
import type { Pool } from './pool.js';
import { callRunner as call } from './runner-call.js';
import { awaitRunner, launchProcess, launchRunner } from './runner-sockets.js';
import type { SandboxRecord } from './sandbox/records.js';
import type { SandboxStarts } from './sandbox/start.js';
import type { ColdStart, Forwarded } from './trace.js';

export interface Runner {
  /** Its socket's name: an id (work 069), or its session key's for runners from before. */
  id: string;
  /** The session it serves; '' while it is a spare. */
  key: string;
  sock: net.Socket;
  spare?: SpareReport;
  /** The session's owner as last sent, so a `people` update reaches its commits. */
  owner?: Person;
  report?: SessionReport;
  /** Work 082: what it runs, from its launch's spec or its first report; absent = claude. */
  harness?: HarnessName;
  lastDelivery: number;
  connectedAt: number;
  exiting?: boolean;
  /** Set by a launch, taken by the delivery that caused it: the path is not `warm`. */
  cold?: ColdStart;
  /** The last trace forwarded (also in `<key>.trace.json`), for `turn.abandoned`. */
  forwarded?: Forwarded;
  calls: Map<string, (r: { ok: boolean; error?: string }) => void>;
  /** Work 103: the thread's record and run root, for a runner in a container. */
  sandbox?: Sandboxed;
}

export interface Sandboxed { record: SandboxRecord; run: RunRoot }

/** What host/main.ts owns and a start needs. Everything is asked for when used, so main.ts may wire it before its parts exist. */
export interface StartDeps {
  tm: Telemetry;
  /** How runners are launched (launch.ts): the mode, the host's environment and its release. */
  launch: { tm: Telemetry; mode: string; env: NodeJS.ProcessEnv; root: string };
  /** The run root runners are started under (ipc.ts). */
  run: RunRoot;
  version: string;
  pool: Pool<Runner>;
  /** The organization's credentials as the gateway last sent them. */
  creds(): HostCredentials | undefined;
  /** Credentials as `key`'s runner gets them (model-access.ts). */
  forRunner(key: string, c: HostCredentials | undefined, harness?: HarnessName): HostCredentials | undefined;
  /** The session's model route (model-access.ts `routes.mode`). */
  routeMode(key: string): string;
  /** Work 084: the session's journal, socket and token for this runner; undefined off the API. */
  mint(spec: SessionSpec, runnerId: string): Promise<RunnerApi | undefined>;
  /** The runner's own token socket below its run root, naming the session it serves now (tokens.ts). */
  serveTokens(run: RunRoot, id: string, session: () => string | undefined): { close(): void };
  /** Work 103: on a `podman` host, how a thread's runner starts; every session then starts through it. */
  sandbox?: SandboxStarts;
  fillPool(): void;
  /** Run a fork so its workspace events join the delivery's trace. */
  inFork<T>(f: Dimensions, fn: () => Promise<T>): Promise<T>;
  /** The runner serves its session from now on. */
  register(r: Runner): void;
  /** Its socket closed. */
  closed(r: Runner): void;
  /** A message from an adopted runner. */
  message(r: Runner, m: RunnerToHost): unknown;
  /** Tell a runner to go and close its socket. */
  exit(sock: net.Socket): void;
  toGateway(m: HostToGateway): void;
}

const newRunnerId = () => randomBytes(8).toString('hex');

/** A workspace fork is complete once .fork.json is written (the last step of forkSession). */
const forkComplete = (forkPath: string | undefined) => !workspacesEnabled() || !forkPath || !!forkInfo(forkPath);

export function runnerStarts(d: StartDeps) {
  const { tm } = d;

  /** Take a connected runner on (adoption.ts): register it as its session's, or as a spare, follow its messages, send it `credentials`.
   * `key`: the session it was launched for; a verified runner names it in its first report, and one with no session is a spare.
   * `first`: the delivery's credentials, sent instead of the welcome ones, since the runner starts its harness with the first it gets. */
  function adopt(id: string, sock: net.Socket, o: { key?: string; verify?: boolean; first?: HostCredentials; harness?: HarnessName; sandbox?: Sandboxed } = {}): Promise<Runner> {
    const r: Runner = { id, key: o.sandbox?.record.key ?? o.key ?? '', sock, lastDelivery: Date.now(), connectedAt: Date.now(), calls: new Map(), harness: o.harness, sandbox: o.sandbox };
    // Its own token socket names the session it serves now (work 080). A container's is open since before its start (the same one: idempotent).
    const tokens = d.serveTokens(o.sandbox?.run ?? d.run, id, () => r.key);
    sock.once('close', () => tokens.close()); // gone with the runner
    return new Promise((resolve, reject) => {
      const take = (m?: First) => {
        if (m?.t === 'report') (r.key = m.report.key), (r.harness ??= m.report.harness);
        if (m?.t === 'spare') r.spare = m.spare;
        if (r.key) d.register(r);
        else {
          d.pool.add(r);
          d.pool.changed(r);
        }
        sock.on('close', () => d.closed(r));
        const c = o.first ?? d.forRunner(r.key, d.creds(), r.harness);
        if (c) send(sock, { t: 'credentials', credentials: c } satisfies HostToRunner);
        resolve(r);
      };
      const stopped = (why: string) => {
        log.warn(`runner ${id}: ${why}; stopping it`);
        d.exit(sock);
      };
      const stop = (why: string) => {
        stopped(why);
        reject(new Error(why));
      };
      // A container's fork record is its sandbox record: complete once it has `repos`.
      const complete = o.sandbox ? () => !workspacesEnabled() || !!o.sandbox!.record.repos : forkComplete;
      const a = adoption({ verify: !!o.verify, complete, take, stop, gone: () => reject(new Error('runner gone')) });
      lines(sock, (m: RunnerToHost) => {
        // Which thread a container serves is the record's word, never the runner's.
        if (o.sandbox && m.t === 'report' && m.report.key !== o.sandbox.record.key) return stopped(`it reports ${m.report.key}, not its record's ${o.sandbox.record.key}`);
        return a.message(m) && void d.message(r, m);
      });
      sock.once('close', () => a.closed());
    });
  }

  /** Work 103: the thread's runner in its container; a new thread and a resume alike. Never the pool (until spares are containers). */
  async function startSandboxed(sandbox: SandboxStarts, spec: SessionSpec, f: Dimensions, first?: HostCredentials): Promise<Runner> {
    const s = await sandbox.start(spec, f);
    try {
      if (s.sock.destroyed) throw new Error('runner exited while it started');
      const r = await adopt(s.record.id, s.sock, { first, harness: spec.harness, sandbox: { record: s.record, run: s.run } });
      if (s.api) send(s.sock, { t: 'api', api: s.api } satisfies HostToRunner); // the token stays out of boot.env
      r.cold = { resumed: !!s.session.sdkSessionId };
      return r;
    } catch (e) {
      // Not taken on: nothing of the start stays (its container may still run, its token socket is open).
      s.sock.destroy();
      await s.abandon();
      throw e;
    }
  }

  async function startRunner(spec: SessionSpec, f: Dimensions, first?: HostCredentials): Promise<Runner> {
    if (d.sandbox) return startSandboxed(d.sandbox, spec, f, first);
    let existing = spec.forkPath && existsSync(spec.forkPath) && forkComplete(spec.forkPath) ? spec.forkPath : undefined;
    // A new session in a prepared workspace may take a spare (work 069); a resumed one starts cold, to resume.
    // Claude takes one on the managed route, whose credential spares park with; Codex (work 082) on its ChatGPT subscription.
    const codex = spec.harness === 'codex';
    if (d.pool.enabled && !spec.sdkSessionId && workspacesEnabled() && workspacePrepared(spec.owner)
      && d.routeMode(spec.key) === (codex ? 'subscription' : 'managed')) {
      const t0 = Date.now();
      const got = await claimSpare<Runner>({
        // Refill as soon as the spare is ours: the fork and the claim take seconds, in which another session may arrive.
        take: () => { const t = d.pool.take(credentialFingerprint(first) ?? credentialFingerprint(d.creds()), codex); d.fillPool(); return t; },
        fork: async () => existing ?? d.inFork(f, () => forkFor(tm, spec, f)),
        claim: async (r, forkPath) => {
          // Claude's credential goes first, as its parked Claude Code has it; a Codex claim drops the spare's, so the session's follow.
          const c = codex ? (first ?? d.forRunner(spec.key, d.creds(), 'codex')) : first;
          if (c && !codex) send(r.sock, { t: 'credentials', credentials: c } satisfies HostToRunner);
          await call(r, { t: 'claim', session: { ...spec, forkPath }, api: await d.mint(spec, r.id) }, 5000);
          if (c && codex) send(r.sock, { t: 'credentials', credentials: c } satisfies HostToRunner);
        },
        discard: (r) => d.exit(r.sock),
        release: (r) => r.sock.destroyed || d.pool.add(r),
      });
      if ('runner' in got) {
        const r = got.runner;
        r.key = spec.key;
        r.harness = spec.harness;
        r.lastDelivery = Date.now();
        d.register(r);
        if (r.report) d.toGateway({ t: 'session', report: r.report });
        r.cold = { resumed: false, prewarmed: true };
        tm.emit('runner.claimed', { ...f, duration_ms: Date.now() - t0 });
        log.info(`runner ${r.id} claimed for ${spec.key} in ${Date.now() - t0} ms`);
        return r;
      }
      tm.emit('pool.spare_missed', { ...f, data: { reason: got.missed } });
      existing ??= got.forkPath;
    }
    // A workspace fork's directory is known before forking: the runner boots in it while the worktrees are added.
    // Elsewhere (a laptop) the fork says where it is, so it comes first.
    const fork = () => d.inFork(f, () => forkFor(tm, spec, f));
    const dir = existing ?? (workspacesEnabled() ? forkDir(spec.owner, spec.key) : await fork());
    const forking = !existing && workspacesEnabled();
    if (forking) await mkdirAsRunner(dir);
    const id = newRunnerId();
    const runnerApi = await d.mint(spec, id); // work 084: the session's journal, socket and token; undefined off the API
    const rs = { id, session: { ...spec, forkPath: dir }, socket: socketFor(d.run, id), api: runnerApi && { ...runnerApi, token: '' }, version: d.version };
    let t0 = Date.now();
    let ready: Promise<net.Socket> | undefined;
    const sock = await coldStart({
      up: async () => void (t0 = await launchProcess(rs, { ...d.launch, f })),
      prepare: forking
        ? async () => {
            const at = await fork();
            if (at !== dir) throw new Error(`fork landed in ${at}, not in ${dir} where the runner was started`);
          }
        : undefined,
      ready: () => (ready = awaitRunner(rs, { tm, f, t0 })),
      // The fork failed: the runner goes once it is up (it only listens until then).
      abandon: async () => {
        const up = await ready?.catch(() => undefined);
        if (up) d.exit(up);
      },
    });
    if (sock.destroyed) throw new Error('runner exited while its fork was made');
    const r = await adopt(id, sock, { key: spec.key, first, harness: spec.harness });
    if (runnerApi) send(sock, { t: 'api', api: runnerApi } satisfies HostToRunner); // the token stays out of argv and env
    r.cold = { resumed: !!spec.sdkSessionId };
    return r;
  }

  /** Start a spare for the pool: a runner with no session, which parks a Claude Code once it has credentials (a Codex claim replaces it). */
  async function launchSpare() {
    const id = newRunnerId();
    await adopt(id, await launchRunner({ id, socket: socketFor(d.run, id), version: d.version }, d.launch));
    tm.emit('pool.spare_started', { data: { launch_mode: d.launch.mode } });
  }

  return { adopt, startRunner, launchSpare };
}
