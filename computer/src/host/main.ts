// Host agent (work 045): one per machine. Dials the gateway over one
// WebSocket, forks sessions, starts runners outside its own process tree,
// forwards deliveries, relays GitHub tokens, and finds its runners again by
// their sockets after a restart. Restarting it never ends a turn.
//
//   SP_GATEWAY_URL=ws://…/host SP_HOST_TOKEN=… [SP_HOST_ID] [SP_DATA] [SP_RUN]
//   [SP_DEFINITION]            workspace definition: fork with src/workspaces (VM); unset: ensureWorkdir (laptop).
//                              A definition in the gateway's welcome replaces it (<SP_DATA>/definition.json).
//   [SP_IDLE_MS=7200000]       tell a runner to exit after this long without deliveries
//   [SP_LAUNCH=systemd|detached]  default systemd on Linux, detached elsewhere
//   [SP_SYSTEMD_RUN="systemd-run --user --slice=slack-presence-runners.slice -p MemoryHigh=12G -p MemoryMax=16G"]
//                              prefix for the transient unit (--unit, --collect, --setenv are added); the
//                              default sizes MemoryHigh/MemoryMax from the machine (runner-limits.ts)
//   [SP_POOL_SIZE=2]           spare runners kept parked for new sessions (work 069, pool.ts); 0: off
//   [SP_VERSION]               code version (the release's commit); else `git rev-parse`
//   [SP_TELEMETRY_URL]         telemetry collector (work 054); unset: telemetry is validated and discarded
//   [SP_TELEMETRY_CREDENTIAL]  the collector credential the gateway signed for this host; a `welcome` renews it
//   [SP_REGION] [SP_SUBSTRATE] telemetry dimensions (`westus2`, `vm`)
//   SP_MODEL_PROXY             the model proxy's control socket (work 097, model-access.ts); unset: the proxy is down, no session starts
//   [SP_MODEL_SOCKET=/run/oc-modelproxy/api.sock]  where runners reach the proxy's API (sent to them, C4)
//   [SP_RUNNER_USER=agent]     run runners as this user, through sudo (work 077, runner-user.ts); the host then runs as another
//   [SP_RUNNER_PATH=...]       the PATH runners and workspace commands get then (the host's own has no agent-owned directory)
//   node --import tsx src/host/main.ts
//
// Code paths come only from import.meta.dirname, so a versioned release
// (/opt/slack-presence/releases/<sha>, reached through the `current` symlink)
// starts its runners from its own files.
//
// Credentials from the gateway's `welcome` live in memory only and reach
// runners over their sockets, as do the secrets people give sessions (046):
// with each delivery, and when they change; never to a runner whose fork is
// incomplete (cold-start.ts, adoption.ts).

import { AsyncLocalStorage } from 'node:async_hooks';
import type net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { HOST_DATA, HOST_RUN, HOST_TOKEN_SOCKET, PROTOCOL_VERSION, RUNNER_TOKEN_DIR } from '../protocol.js';
import { codexBin } from '../runner-env.js';
import { prereadCodex } from './codex-preread.js';
import type { Delivery, GatewayToHost, HarnessName, HostCredentials, HostToGateway, ModelRoute, HostToRunner, Person,
  RunnerToHost, SessionReport, SessionSecret, SessionSpec, SpareReport, TraceContext } from '../protocol.js';
import {
  applyGatewayDefinition,
  checkoutRepos,
  configureAsRunner,
  fetchRepo,
  forkDir,
  forkInfo,
  mkdirAsRunner,
  prepareInBackground,
  observeWorkspaces,
  oldestFetchAgeS,
  startHousekeeping,
  touchFork,
  workspacePrepared,
  workspacesEnabled,
} from '../workspaces/index.js';
import { lines, send, socketFor } from '../ipc.js';
import { log } from '../log.js';
import { coldStart, forkFor } from './cold-start.js';
import { closed, launchRunner, rediscover, retire } from './runner-sockets.js';
import { adoption, type First } from './adoption.js';
import { Pool } from './pool.js';
import { claimSpare } from './claim.js';
import { tokenRelay } from './tokens.js';
import { hostPreviews } from './previews.js';
import { startHostTelemetry, workspaceTelemetry } from './telemetry.js';
import { diskReport, hostSampler } from './sample.js';
import { type ColdStart, decidePath, type Forwarded, forwardTrace, loadForwarded, runnerGone, saveForwarded, traceFields } from './trace.js';
import type { Dimensions } from '../telemetry/envelope.js';
import { assignedIdentity, codeVersion, identityFile, loadIdentity, saveIdentity } from './identity.js';
import { hostModelAccess, PROXY_DOWN } from './model-access.js';
import { unitExists } from './launch.js';
import { runnerUser } from './runner-user.js';
import { gatewayLink } from './gateway-link.js';
import { gatewayUpdates } from './gateway-updates.js';
import { callRunner as call } from './runner-call.js';
import { apiHost, type StartOptions } from './api-host.js';
import { wireFor } from './api-wire.js';

const env = process.env;
const IDENTITY_FILE = identityFile(HOST_DATA);
// The gateway URL, token and id; replaced when a pool host is assigned (052).
let identity = loadIdentity(env, IDENTITY_FILE, os.hostname());
const IDLE_MS = Number(env.SP_IDLE_MS ?? 2 * 3600_000);
const POOL_SIZE = Number(env.SP_POOL_SIZE ?? 2);
const LAUNCH = env.SP_LAUNCH ?? (process.platform === 'linux' ? 'systemd' : 'detached');
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const VERSION = codeVersion(env.SP_VERSION, ROOT);

// Workspace writes as the runners' user (077): `people` stays theirs on a computer whose host is sp-host.
configureAsRunner(runnerUser(env), env);

// ---------------------------------------------------------------- telemetry (work 054)

const telemetryBase: Dimensions = { host_id: identity.hostId, substrate: env.SP_SUBSTRATE || undefined };
const telemetry = startHostTelemetry({ dataDir: HOST_DATA, url: env.SP_TELEMETRY_URL || undefined, credential: env.SP_TELEMETRY_CREDENTIAL,
  version: VERSION, region: env.SP_REGION || 'unknown', base: telemetryBase });
const tm = telemetry.t;
/** The delivery a cold start is for, so workspace events join its trace. */
type Fields = ReturnType<typeof traceFields>;
const forkContext = new AsyncLocalStorage<Fields>();
observeWorkspaces(workspaceTelemetry(tm, () => forkContext.getStore()));

/** The organization's credentials and people, as the gateway last sent them. */
const org = gatewayUpdates({ runners: () => runners.values(), spares: () => pool.spares, forRunner: (key, c) => subs.forRunner(key, c),
  fillPool: () => fillPool(), prepare: (p) => workspacesEnabled() && prepareInBackground(p) });
const subs = hostModelAccess({ controlSocket: env.SP_MODEL_PROXY || undefined, modelSocket: env.SP_MODEL_SOCKET || undefined, single: LAUNCH !== 'systemd',
  toGateway, tm, runner: (key) => runners.get(key), creds: () => org.creds, exit: switchRunner, unitExists: (id) => unitExists(id, LAUNCH, env),
  rehello: () => link.redial(), codexBin: codexBin(env) });

// ---------------------------------------------------------------- runners

interface Runner {
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
  /** Told to exit for its session's new route (model-access.ts): a delivery waits for it to go and starts another. */
  switching?: boolean;
  /** Set by a launch, taken by the delivery that caused it: the path is not `warm`. */
  cold?: ColdStart;
  /** The last trace forwarded (also in `<key>.trace.json`), for `turn.abandoned`. */
  forwarded?: Forwarded;
  calls: Map<string, (r: { ok: boolean; error?: string }) => void>;
}
const runners = new Map<string, Runner>();
const pool = new Pool<Runner>({
  size: POOL_SIZE,
  version: VERSION,
  launch: launchSpare,
  failed: () => tm.emit('pool.spare_failed', {}),
  evict: (r, reason) => {
    tm.emit('pool.spare_evicted', { data: { reason } });
    exitRunner(r.sock);
  },
});
/** Every connected runner: the sessions' and the spares. */
const allRunners = () => [...runners.values(), ...pool.spares];
const fillPool = () => !stopping && pool.fill(subs.canSpare());
function exitRunner(sock: net.Socket) {
  send(sock, { t: 'exit' } satisfies HostToRunner);
  sock.end();
}
/** A busy one is only told to go (its turn ends at its next model call); an idle one is closed as well. */
function switchRunner(key: string, r = runners.get(key)) {
  if (r) (r.switching = true), r.report?.status === 'busy' ? send(r.sock, { t: 'exit' } satisfies HostToRunner) : exitRunner(r.sock);
}
/** Its session's epoch moved on (api-host `epoch`): end its turn now, then exit; killed after 10 s. */
const retireRunner = async (id: string, r = [...runners.values()].find((x) => x.id === id)) =>
  r && ((r.exiting = true), retire(r.sock, socketFor(r.id), () => void call(r, { t: 'stop' }, 10_000).catch(() => {})));
const newRunnerId = () => randomBytes(8).toString('hex');
const launchOpts = { tm, mode: LAUNCH, env, root: ROOT };
/** spawn, secret and thread requests in flight to the gateway, by id: the runner that asked. */
const spawning = new Map<string, Runner>();
const starting = new Map<string, Promise<Runner>>();
/** Set on SIGTERM: runner sockets closing then are the host leaving, not the runners. */
let stopping = false;

/** A workspace fork is complete once .fork.json is written (the last step of forkSession). */
const forkComplete = (forkPath: string | undefined) => !workspacesEnabled() || !forkPath || !!forkInfo(forkPath);

/** Take a connected runner on (adoption.ts): register it as its session's, or as a spare, follow its messages, send it `credentials`.
 * `key`: the session it was launched for; a verified runner names it in its first report, and one with no session is a spare.
 * `first`: the delivery's credentials, sent instead of the welcome ones, since the runner starts its harness with the first it gets. */
function adopt(id: string, sock: net.Socket, o: { key?: string; verify?: boolean; first?: HostCredentials; harness?: HarnessName } = {}): Promise<Runner> {
  const r: Runner = { id, key: o.key ?? '', sock, lastDelivery: Date.now(), connectedAt: Date.now(), calls: new Map(), harness: o.harness };
  tokens.serveRunner(id, sock, () => r.key); // its own token socket names the session it serves now (work 080)
  return new Promise((resolve, reject) => {
    const take = (m?: First) => {
      if (m?.t === 'report') (r.key = m.report.key), (r.harness ??= m.report.harness);
      if (m?.t === 'spare') r.spare = m.spare;
      if (r.key) register(r, !!o.verify);
      else {
        pool.add(r);
        pool.changed(r);
      }
      sock.on('close', () => runnerClosed(r));
      const c = o.first ?? subs.forRunner(r.key, org.creds, r.harness);
      if (c) send(sock, { t: 'credentials', credentials: c } satisfies HostToRunner);
      resolve(r);
    };
    const stop = (why: string) => {
      log.warn(`runner ${id}: ${why}; stopping it`);
      exitRunner(sock);
      reject(new Error(why));
    };
    const a = adoption({ verify: !!o.verify, complete: forkComplete, take, stop, gone: () => reject(new Error('runner gone')) });
    lines(sock, (m: RunnerToHost) => a.message(m) && void onRunner(r, m));
    sock.once('close', () => a.closed());
  });
}

/** The runner serves its session from now on; one already there for it (found twice after a restart) is told to go. */
function register(r: Runner, found = false) {
  const old = runners.get(r.key);
  if (old && old !== r) exitRunner(old.sock);
  runners.set(r.key, r);
  subs.registered(r.key, r.id, r.harness, found);
  r.forwarded ??= loadForwarded(r.key);
  api.up(r.id);
}

function runnerClosed(r: Runner) {
  for (const c of r.calls.values()) c({ ok: false, error: 'runner gone' });
  if (!stopping) api.down(r.id), subs.closed(r.key, r.id);
  if (!r.key) {
    pool.gone(r);
    fillPool();
    return;
  }
  if (runners.get(r.key) !== r) return;
  if (!stopping) runnerGone(tm, r);
  runners.delete(r.key);
  if (r.report && r.report.status !== 'stopped') toGateway({ t: 'session', report: { ...r.report, status: 'error', error: 'runner exited' } });
}

async function onRunner(r: Runner, m: RunnerToHost) {
  switch (m.t) {
    case 'telemetry':
      return telemetry.relay(m.batch);
    case 'report':
      r.report = m.report;
      // A spare reports as it is claimed, before the host has it as the session's runner (startRunner forwards it then).
      return runners.get(r.key) === r && toGateway({ t: 'session', report: m.report });
    case 'spare':
      r.spare = m.spare;
      return pool.changed(r);
    case 'reply':
      return r.calls.get(m.id)?.(m);
    case 'spawn':
    case 'read':
    case 'post':
    case 'secret-request': {
      // The ids are UUIDs, so the runner's id carries through to the gateway and back.
      const answer = ({ spawn: 'spawned', read: 'thread', post: 'posted', 'secret-request': 'secret-asked' } as const)[m.t];
      if (!link.connected) return send(r.sock, { t: answer, id: m.id, error: 'gateway not connected' } satisfies HostToRunner);
      spawning.set(m.id, r);
      setTimeout(() => spawning.delete(m.id), 60_000).unref();
      return toGateway({ ...m, from: r.key });
    }
    case 'preview': // the host probes the port between the gateway's answer and the runner's (previews.ts)
    case 'unpreview': return previews.request(r.key, m).then((a) => send(r.sock, a satisfies HostToRunner));
    case 'out-of-credits': return runners.get(r.key) === r && toGateway({ t: 'out-of-credits', sessionKey: r.key });
    case 'model-denied': return toGateway({ t: 'model-denied', sessionKey: r.key, model: m.model, fallbackTo: m.fallbackTo });
    case 'checkout': {
      const forkPath = r.report?.forkPath;
      const fail = (error: string) => send(r.sock, { t: 'checked-out', id: m.id, error } satisfies HostToRunner);
      if (!workspacesEnabled()) return fail('this host has no workspace definition; there is nothing to check out');
      if (!forkPath) return fail('the session has not reported its fork yet');
      return checkoutRepos(forkPath, m.repos).then(
        (result) => send(r.sock, { t: 'checked-out', id: m.id, result } satisfies HostToRunner),
        (e) => fail(String(e?.message ?? e)),
      );
    }
    case 'token':
      return tokens.request(r.key, m.repos).then(
        (result) => send(r.sock, { t: 'token', id: m.id, result } satisfies HostToRunner),
        (e) => send(r.sock, { t: 'token', id: m.id, error: String(e?.message ?? e) } satisfies HostToRunner),
      );
  }
}

function ensureRunner(spec: SessionSpec, f: Fields, first?: HostCredentials): Promise<Runner> {
  const live = runners.get(spec.key);
  if (live) return Promise.resolve(live);
  let p = starting.get(spec.key);
  if (!p) {
    p = startRunner(spec, f, first).finally(() => starting.delete(spec.key));
    starting.set(spec.key, p);
  }
  return p;
}

async function startRunner(spec: SessionSpec, f: Fields, first?: HostCredentials): Promise<Runner> {
  if (!subs.up) throw new Error(PROXY_DOWN);
  let existing = spec.forkPath && existsSync(spec.forkPath) && forkComplete(spec.forkPath) ? spec.forkPath : undefined;
  // A new session in a prepared workspace may take a spare (work 069); a resumed one starts cold, to resume.
  // Claude takes one of its route's spare kind (C6); Codex (work 082) any.
  const codex = spec.harness === 'codex';
  if (pool.enabled && !spec.sdkSessionId && workspacesEnabled() && workspacePrepared(spec.owner) && subs.canSpare()) {
    const t0 = Date.now();
    const got = await claimSpare<Runner>({
      // Refill as soon as the spare is ours: the fork and the claim take seconds, in which another session may arrive.
      take: () => { const t = pool.take(subs.kind(spec.key, 'claude'), codex); fillPool(); return t; },
      fork: async () => existing ?? forkContext.run(f, () => forkFor(tm, spec, f)),
      claim: async (r, forkPath) => {
        // Bound to the session first (C6); Claude's credentials go before the claim, Codex's after (its claim drops the spare's).
        await subs.claim(r.id, spec.key, spec.harness ?? 'claude');
        const c = first ?? subs.forRunner(spec.key, org.creds, spec.harness ?? 'claude');
        if (c && !codex) send(r.sock, { t: 'credentials', credentials: c } satisfies HostToRunner);
        await call(r, { t: 'claim', session: { ...spec, forkPath }, api: await api.mint(spec, r.id) }, 5000);
        if (c && codex) send(r.sock, { t: 'credentials', credentials: c } satisfies HostToRunner);
      },
      discard: (r) => exitRunner(r.sock),
      release: (r) => r.sock.destroyed || pool.add(r),
    });
    if ('runner' in got) {
      const r = got.runner;
      r.key = spec.key;
      r.harness = spec.harness;
      r.lastDelivery = Date.now();
      register(r);
      if (r.report) toGateway({ t: 'session', report: r.report });
      r.cold = { resumed: false, prewarmed: true };
      tm.emit('runner.claimed', { ...f, duration_ms: Date.now() - t0 });
      log.info(`runner ${r.id} claimed for ${spec.key} in ${Date.now() - t0} ms`);
      return r;
    }
    tm.emit('pool.spare_missed', { ...f, data: { reason: got.missed } });
    existing ??= got.forkPath;
  }
  // A workspace fork's directory is known before forking: the runner boots in it while the worktrees are added.
  const dir = existing ?? (workspacesEnabled() ? forkDir(spec.owner, spec.key) : undefined);
  if (dir && !existing) await mkdirAsRunner(dir);
  const id = newRunnerId();
  const runnerApi = await api.mint(spec, id); // work 084: the session's journal, socket and token; undefined off the API
  const { ready: sock } = await coldStart({
    dir,
    fork: existing ? undefined : () => forkContext.run(f, () => forkFor(tm, spec, f)),
    start: (cwd) => launchRunner({ id, session: { ...spec, forkPath: cwd }, socket: socketFor(id), api: runnerApi && { ...runnerApi, token: '' }, version: VERSION }, { ...launchOpts, f }),
    abandon: exitRunner,
  });
  if (sock.destroyed) throw new Error('runner exited while its fork was made');
  const r = await adopt(id, sock, { key: spec.key, first, harness: spec.harness });
  if (runnerApi) send(sock, { t: 'api', api: runnerApi } satisfies HostToRunner); // the token stays out of argv and env
  r.cold = { resumed: !!spec.sdkSessionId };
  return r;
}

/** Start a spare for the pool, bound to `models.claude` first: a runner with no session, which parks a Claude Code once it has credentials. */
async function launchSpare() {
  const id = newRunnerId();
  await subs.spare(id);
  await launchRunner({ id, socket: socketFor(id), version: VERSION }, launchOpts).then((sock) => adopt(id, sock))
    .catch((e) => (subs.closed('', id), Promise.reject(e)));
  tm.emit('pool.spare_started', { data: { launch_mode: LAUNCH } });
}

setInterval(() => {
  for (const r of runners.values()) {
    if (api.subagentsRunning(r.report)) r.lastDelivery = Date.now(); // idle counts from the last subagent's end
    if (!r.exiting && r.report?.status !== 'busy' && Date.now() - r.lastDelivery > IDLE_MS && !api.terminalsOpen(api.sessionOf(r.id))) {
      log.info('idle, asking runner to exit', r.key);
      r.exiting = true;
      send(r.sock, { t: 'exit' } satisfies HostToRunner);
    }
  }
}, Math.min(60_000, Math.max(1000, IDLE_MS / 4))).unref();

// ---------------------------------------------------------------- gateway link (gateway-link.ts)

const link = gatewayLink({
  url: () => identity.gatewayUrl,
  token: () => identity.token,
  hello: () => ({ t: 'hello', protocol: PROTOCOL_VERSION, hostId: identity.hostId, version: VERSION,
    sessions: [...runners.values()].flatMap((r) => (r.report ? [r.report] : [])), profiles: subs.profiles(), journals: api.journals() }),
  message: (m) => void onGateway(m).catch((e) => log.error('gateway message', m.t, e)),
});
function toGateway(m: HostToGateway) {
  link.send(m);
}
const api = apiHost({ dataDir: HOST_DATA, stateDir: path.join(HOST_DATA, 'host-api'), runDir: path.join(HOST_RUN, 'host-api'),
  send: (m) => link.open && (link.send(m), true), buffered: () => link.buffered, start: startSession, retire: retireRunner, forkPath: (key) => runners.get(key)?.report?.forkPath,
  wire: wireFor({ launch: LAUNCH, user: runnerUser(env), systemdRun: env.SP_SYSTEMD_RUN || undefined, path: env.SP_RUNNER_PATH,
    stateDir: path.join(HOST_DATA, 'state', 'uploads') }), telemetry: tm });
setInterval(() => {
  const disk = diskReport(HOST_DATA);
  if (disk) toGateway(disk);
}, 5 * 60_000).unref(); // the gateway grows /data near capacity (work 071)

async function onGateway(m: GatewayToHost) {
  const reply = (id: string, p: Promise<unknown>) =>
    p.then(
      () => toGateway({ t: 'reply', id, ok: true }),
      (e) => toGateway({ t: 'reply', id, ok: false, error: String(e?.message ?? e) }),
    );
  if (subs.onGateway(m)) return; // `model`, `model-request` (work 097); reads `models` from `welcome` and `credentials`
  if (await api.onGateway(m)) return; // `start`, `api`, `journal-ack`, `access`, `revoked` (work 084, api-host.ts)
  switch (m.t) {
    case 'welcome':
      org.welcome(m);
      if (m.definition !== undefined && applyGatewayDefinition(m.definition)) housekeeper?.now();
      if (m.telemetryCredential) telemetry.renew(m.telemetryCredential, m.telemetryUrl);
      previews.configure(m.preview);
      return housekeeping();
    case 'previews': return previews.configure(m.preview);
    case 'previewed': return previews.answer(m);
    case 'credentials': return org.credentials(m);
    case 'assign': {
      const next = assignedIdentity(identity, m);
      if ('error' in next) {
        log.error(`refusing assign to ${m.organizationId}: ${next.error}`);
        return;
      }
      saveIdentity(IDENTITY_FILE, next);
      log.info(`assigned to ${next.hostId}; reconnecting as it`);
      identity = next;
      telemetryBase.host_id = next.hostId;
      return link.redial(); // the next dial is as the new identity
    }
    case 'people': return org.peopleChanged(m);
    case 'deliver': {
      const at = Date.now();
      const f = { ...traceFields(m.session.key, m.trace), dispatch_id: m.id };
      tm.emit('deliver.received', { ...f, duration_ms: m.trace?.dispatchedAt && at - m.trace.dispatchedAt });
      return reply(m.id, deliver(m.session, m.msg, m.credentials, m.secrets, { trace: m.trace, at, f, model: m.model }));
    }
    case 'secrets': {
      // A session without a runner gets them with its next delivery.
      const r = runners.get(m.sessionKey);
      if (r) send(r.sock, { t: 'secrets', secrets: m.secrets } satisfies HostToRunner);
      return;
    }
    case 'action': {
      const r = runners.get(m.sessionKey);
      return reply(m.id, r ? call(r, { t: 'action', promptId: m.promptId, value: m.value, userId: m.userId })
        : Promise.reject(new Error('no runner for this session (the prompt ended with it)')));
    }
    case 'stop': {
      const r = runners.get(m.sessionKey);
      return reply(m.id, r ? call(r, { t: 'stop' }) : Promise.resolve());
    }
    case 'pushed':
      // Only a push to the branch forks start from fetches (not sessions' own sp/* branches).
      if (!workspacesEnabled()) return;
      return void fetchRepo(m.repo, org.people, m.ref).then(
        (n) => n && log.info(`pushed ${m.repo} ${m.ref}: fetched ${n} clone(s)`),
        (e) => log.warn(`fetch ${m.repo}:`, e?.message ?? e),
      );
    case 'token':
      return tokens.answer(m);
    case 'spawned':
    case 'thread':
    case 'posted':
    case 'secret-asked': {
      const r = spawning.get(m.id);
      spawning.delete(m.id);
      if (r) send(r.sock, m satisfies HostToRunner);
      return;
    }
  }
}

/** The delivery's trace, when the host received it, and its envelope fields. */
interface Received {
  trace?: TraceContext;
  at: number;
  f: Fields;
  model?: ModelRoute;
}

async function deliver(spec: SessionSpec, msg: Delivery, delivered: HostCredentials | undefined, secrets: SessionSecret[] | undefined,
  rx: Received) {
  const deliveryCredentials = await subs.delivered(spec.key, delivered, rx.model, spec.harness);
  for (let attempt = 0; ; attempt++) {
    let r = await ensureRunner(spec, rx.f, deliveryCredentials);
    if (r.switching || (r.harness ?? 'claude') !== (spec.harness ?? 'claude')) {
      // On the other harness or route still (busy past the switch's wait, or started before it): never given this delivery.
      if (attempt) throw new Error(`session ${spec.key}: its runner is still on its previous agent or model; try again when its turn ends`);
      switchRunner(spec.key, r);
      await closed(r.sock); // at most 5 s
      continue;
    }
    // Reported `stopped` (idle exit, !restart): let it go, then start a new one from the current release.
    if (r.report?.status === 'stopped') {
      await closed(r.sock);
      r = await ensureRunner(spec, rx.f, deliveryCredentials);
    }
    await subs.ready(r.key); // its bind answered: its first model request finds it
    const cold = r.cold;
    r.cold = undefined;
    // A Cloudflare Durable Object gateway supplies the Slack installation for
    // this workspace with each delivery. The original single-workspace gateway
    // omits it and keeps using the credentials received in `welcome`.
    if (deliveryCredentials) {
      send(r.sock, { t: 'credentials', credentials: deliveryCredentials } satisfies HostToRunner);
    }
    // Ahead of the message on the same socket, so the turn starts with them.
    if (secrets) send(r.sock, { t: 'secrets', secrets } satisfies HostToRunner);
    r.lastDelivery = Date.now();
    r.owner = spec.owner;
    // Retention counts from the latest use; never awaited, so delivery doesn't wait on the disk.
    const forkPath = r.report?.forkPath ?? spec.forkPath;
    if (forkPath && workspacesEnabled()) void touchFork(forkPath);
    const wasExiting = r.exiting;
    r.exiting = false;
    const trace = rx.trace && forwardTrace(rx.trace, cold);
    r.forwarded = { trace, at: Date.now() };
    saveForwarded(r.key, r.forwarded);
    const answered = call(r, { t: 'deliver', msg, trace });
    tm.emit('deliver.forwarded', { ...rx.f, path: decidePath(cold), duration_ms: Date.now() - rx.at,
      data: { credentials_sent: !!delivered, secrets_count: secrets?.length ?? 0 } });
    try {
      return await answered;
    } catch (e: any) {
      // Raced an exit: start it again.
      if (attempt || !(wasExiting || r.report?.status === 'stopped') || e?.message !== 'runner gone') throw e;
    }
  }
}

/** Work 084: start the session's runner for the API (`start`, a wake, `resume`), with `msg` delivered when given; its status. */
async function startSession(spec: SessionSpec, o: StartOptions) {
  const f = traceFields(spec.key);
  if (o.msg) await deliver(spec, o.msg, o.credentials, o.secrets, { at: Date.now(), f, model: o.model });
  else {
    const c = await subs.delivered(spec.key, o.credentials, o.model, spec.harness);
    const r = await ensureRunner(spec, f, c);
    if (c) send(r.sock, { t: 'credentials', credentials: c } satisfies HostToRunner);
    if (o.secrets) send(r.sock, { t: 'secrets', secrets: o.secrets } satisfies HostToRunner);
  }
  return runners.get(spec.key)?.report?.status;
}

let housekeeper: { now(): void; stop(): void } | undefined;
function housekeeping() {
  if (!workspacesEnabled() || housekeeper) return;
  try {
    housekeeper = startHousekeeping(() => org.people, (status) => toGateway({ t: 'workspace', status }),
      () => new Set([...runners.values()].flatMap((r) => r.report?.forkPath ?? [])));
  } catch (e: any) {
    log.warn('housekeeping not started:', e?.message ?? e);
  }
}

// ---------------------------------------------------------------- GitHub tokens

const tokens = tokenRelay(link.ask, tm, path.join(HOST_RUN, RUNNER_TOKEN_DIR));
const previews = hostPreviews({ ask: link.ask });

// ---------------------------------------------------------------- start

mkdirSync(HOST_RUN, { recursive: true });
const tokenServer = tokens.serve(path.join(HOST_RUN, HOST_TOKEN_SOCKET));
await api.boot(); // settles the journals no runner holds (work 084); none on a host that never had a v4 gateway
api.rediscovered(await rediscover((id, sock) => adopt(id, sock, { verify: true }).then((r) => log.info('rediscovered runner', id, r.key || 'spare'))));
log.info(`host ${identity.hostId} (${VERSION}) run=${HOST_RUN} launch=${LAUNCH} ${workspacesEnabled() ? 'workspaces' : 'laptop'} mode, ${runners.size} live runner(s), pool ${POOL_SIZE}`);
link.dial();
setInterval(fillPool, 30_000).unref();
// The first Codex session after a boot would page in Codex's binaries as it starts (codex-preread.ts).
const t0Preread = Date.now();
void prereadCodex(codexBin(env)).then(
  (bytes) => bytes && log.info(`codex binaries read: ${Math.round(bytes / 2 ** 20)} MB in ${Date.now() - t0Preread} ms`),
  (e) => log.warn('codex pre-read:', e?.message ?? e),
);

// Every minute from every host, gateway or not: absence and `gateway_connected` are the signals.
const sample = hostSampler(HOST_DATA);
const emitSample = () =>
  tm.emit('host.sample', { data: sample({
    runners: runners.size,
    spares: pool.spares.size,
    busy_runners: [...runners.values()].filter((r) => r.report?.status === 'busy').length,
    oldest_fetch_age_s: oldestFetchAgeS(),
    gateway_connected: link.open,
    since_gateway_message_s: link.seenAt ? Math.round((Date.now() - link.seenAt) / 1000) : undefined,
    telemetry_spooled_bytes: telemetry.spooledBytes,
    telemetry_dropped: telemetry.dropped,
    model_proxy_down_s: subs.downS(),
  }) });
emitSample();
setInterval(emitSample, 60_000).unref();

const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  // Runners keep going; the next host finds them by their sockets.
  log.info('host stopping');
  for (const r of allRunners()) r.sock.destroy();
  tokenServer.close();
  previews.stop();
  subs.stop(); // tokenServer.close() unlinked the socket; the next host replaces it anyway
  await api.stop();
  // One last send within 5 s; what is left stays in the spool for the next start.
  await telemetry.close(5000);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
