// The host's side of the Computer's session API (work 084): which process is
// each session's writer (its runner, or the host's session-writer when none
// runs), the v4 gateway frames (`start`, `api`, `journal-ack`, `access`,
// `revoked`, `welcome.wire`), the mirror (api-bridge.ts), what the relay is
// told (api-relay.ts), and the RunnerApi of every runner start.
// host/main.ts calls it at a few points and keeps everything else.
//
// Invariants:
// - Off unless the gateway's welcome says protocol ≥ 4: before that (and with
//   a v3 gateway) no RunnerApi is minted, no `journal` frame is sent, no
//   socket of the API or the relay is created, and every frame main handled
//   before reaches main unchanged. Only `cs_` sessions have a writer.
// - One writer per session: the host's session-writer is handed off (lock
//   released) before a runner is started or claimed for its session, and is
//   opened only when no runner serves it and none is starting.
// - Calvin never writes recovery events for a lost runner (the DO does, under
//   epoch + 1); the boot scan settles only journals no process holds.
// - Only the gateway's `epoch` frame moves a session's epoch (recovery-fix):
//   the session's runner is stopped (or the host's writer handed off), the
//   journal is cut at the epoch's first seq and gets the DO's events verbatim,
//   and the mirror restarts under it. An epoch ahead of the host's in `start`,
//   `deliver` or `api` is logged, never adopted. Writers wait for an adoption.
// - A runner is not idle-suspended while a terminal of its session is open or
//   it reports running subagents (`subagents`, 084 subagents; background ones
//   outlive the turn that launched them, so `status` alone says idle).
// - Host session-writers stay open until a runner takes their session over
//   (v1: never released for idleness; a few fds per suspended session).

import { existsSync } from 'node:fs';
import path from 'node:path';
import type {
  ApiSessionStatus, Delivery, GatewayToHost, HostCredentials, HostToGateway, JournalReport, ModelRoute, Person,
  RunnerApi, SessionAccess, SessionSecret, SessionSpec, SessionStatus,
} from '../protocol.js';
import { HOST_RUN } from '../protocol.js';
import { apiError, RECORD_METHOD } from '../api/writer.js';
import { createdOf } from '../api/created.js';
import { ensureJournalDir, ensureSessionJournalDir, forgetJournalFile, Journal, journalPath, readJournalFile } from '../api/journal.js';
import { moveFlatJournals, moveFlatSessionLogged } from './journal-flat-move.js';
import { journalReports } from './journal-reports.js';
import { type HostWriterOptions, HostSessionWriter, scanJournals } from './session-writer.js';
import { isSessionId } from '../session-ids.js';
import { type RunRoot, runnersDir as runnersDirOf } from '../ipc.js';
import { log } from '../log.js';
import { apiBridge, localPort, type WriterPort } from './api-bridge.js';
import { mirrorAcks } from './mirror-acks.js';
import { type Dial, remotePort } from './remote-port.js';
import { apiSocketFor, mintToken, runnerApis, subagentsRunning } from './runner-api.js';
import { apiWake } from './api-wake.js';
import { apiRelay, type WireHooks, type WireLinkLike } from './api-relay.js';
import { type ApiMeter, apiMeter } from './api-meter.js';
import type { Telemetry } from '../telemetry/emitter.js';
import type { SandboxPlace } from './sandbox/scripts.js';

export interface StartOptions {
  /** A message to deliver once it runs (a send recorded by the host's writer); absent: only start it. */
  msg?: Delivery;
  credentials?: HostCredentials;
  secrets?: SessionSecret[];
  model?: ModelRoute;
}

export type { WireHooks, WireLinkLike };

type HostWriter = Pick<HostSessionWriter, 'sessionId' | 'call' | 'subscribe' | 'handOff' | 'failQueued'>;

export interface ApiHostDeps {
  /** HOST_DATA: journals go in `<dataDir>/journals`. */
  dataDir: string;
  /** The host's own state (0700): the DO's acks, kept across reboots. */
  stateDir: string;
  /** The host's own run state (0700, tmpfs): the live runners' tokens, which die with them. */
  runDir: string;
  runnersDir?: string;
  /** Send to the gateway; false while the link is not open. */
  send(m: HostToGateway): boolean;
  /** The gateway socket's unwritten bytes (gateway-link.ts `buffered`). */
  buffered?(): number;
  /** Stop runner `runnerId` now (its session's epoch moved on): interrupt it, tell it to exit within 8 s, kill it after 10 s. */
  retire?(runnerId: string): Promise<unknown>;
  /** Start the session's runner (or find it running), then deliver `msg`; resolves with its status. */
  start(spec: SessionSpec, o: StartOptions): Promise<SessionStatus | undefined>;
  /** The fork of the session's runner, if it reported one. */
  forkPath?(key: string): string | undefined;
  /** Present where sessions run in containers (work 103): the session's sandbox, undefined when it has none yet. Its terminal and files are reached only there. */
  sandbox?(spec: SessionSpec): Promise<SandboxPlace | undefined>;
  /** Serve the relay's local socket (api-wire.ts); absent: no relay on this host. */
  wire?(hooks: WireHooks): Promise<WireLinkLike>;
  /** The host's emitter: the API side's telemetry (api-meter.ts: the relay's frames, the mirror's turns, adoptions, api.sample). */
  telemetry?: Telemetry;
  meter?: ApiMeter;
  // Seams for tests.
  openHostWriter?(o: HostWriterOptions): Promise<HostWriter>;
  dial?: Dial;
  scan?: typeof scanJournals;
  flushMs?: number;
  now?: () => number;
  /** How long an adoption waits for the journal's lock (10 s). */
  lockWaitMs?: number;
  /** A frame held this long (and every this long after) asks the gateway for the `epoch` frame (10 s). */
  holdAskMs?: number;
}

/** A runner's status as the API names it. */
/** A failed adoption is retried no sooner than this, doubling to the max (the gateway resends `epoch` every 5 s). */
const ADOPT_BACKOFF_MS = 10_000;
const ADOPT_BACKOFF_MAX_MS = 300_000;

export const apiStatus = (s: SessionStatus | undefined): ApiSessionStatus =>
  s === 'idle' ? 'idle' : s === 'busy' ? 'running' : s === 'stopped' || s === 'error' ? 'suspended' : 'starting';

const ownerOf = (p: Person | undefined) => ({ id: p?.userId ?? p?.slackUserId ?? '', name: p?.name ?? p?.gitName ?? '', email: p?.email ?? null });

export function apiHost(d: ApiHostDeps) {
  const runnersDir = d.runnersDir ?? runnersDirOf(HOST_RUN);
  const journals = path.join(d.dataDir, 'journals');
  moveFlatJournals(d.dataDir); // before anything below lists or reads a journal (work 103 C8; goes in its step 12)
  const tokens = runnerApis(path.join(d.runDir, 'runners.json'));
  const acks = mirrorAcks(path.join(d.stateDir, 'mirror-acks.json'));
  const meter = d.meter ?? (d.telemetry && apiMeter(d.telemetry, { journals }));
  const openHostWriter = d.openHostWriter ?? ((o: HostWriterOptions) => HostSessionWriter.open(o));
  let v4 = false;
  /** Sessions as the gateway last sent them, by `cs_` id. */
  const specs = new Map<string, SessionSpec>();
  /** The log's epoch and the DO's lastSeq, as the last frame said. */
  const logs = new Map<string, { epoch: number; lastSeq: number }>();
  const reports = journalReports(journals, (sessionId) => logs.get(sessionId)?.epoch);
  /** The runner serving each session (its RunnerApi), and a port to it. */
  const live = new Map<string, { runnerId: string; api: RunnerApi; port: ReturnType<typeof remotePort> }>();
  const hostWriters = new Map<string, { w: Promise<HostWriter>; socket: string; token: string; epoch: number }>();
  /** A runner is being started for the session: its writer is neither the host's nor known yet. */
  const pending = new Map<string, { done: Promise<void>; resolve(): void }>();
  /** `start` frames being served (a session created with no message, being forked): its `workspace` waits for them. */
  const forking = new Map<string, Promise<unknown>>();
  /** `epoch` frames being adopted: the session's writer, `where` and `mint` wait for them. */
  const adopting = new Map<string, Promise<void>>();
  /** Adoptions that failed, per session: retried no sooner than `next`. Runners already told to go (retired once). */
  const failed = new Map<string, { epoch: number; next: number; delay: number }>();
  const retired = new Set<string>();
  /** Frames whose epoch is ahead of the host's, held per session until that epoch's adoption commits (review r2 P1-1). */
  const held = new Map<string, { epoch: number; go(): void }[]>();
  const heldSaid = new Set<string>();
  /** Per session with held frames: the timer asking the gateway for its `epoch` frame (review r3 P1-1). */
  const asking = new Map<string, ReturnType<typeof setInterval>>();
  /** The latest `epoch` frame per session not yet adopted: `down()` reruns it once a failed adoption's writer let go. */
  const kept = new Map<string, Extract<GatewayToHost, { t: 'epoch' }>>();
  const now = d.now ?? Date.now;
  const terminals = new Map<string, number>();

  const bridge = apiBridge({
    send: (m) => v4 && d.send(m),
    buffered: d.buffered,
    writer,
    disk: (sessionId, after, limit) => readJournalFile(journalPath(d.dataDir, sessionId), after, limit).events,
    acks,
    flushMs: d.flushMs,
    meter: meter?.mirror,
  });

  /** The journal's epoch; 0 for events with no epoch line (an adoption into a new file torn before it: review r3 P2-4); undefined: no journal. */
  const fileEpoch = (sessionId: string) => {
    const f = readJournalFile(journalPath(d.dataDir, sessionId), Number.MAX_SAFE_INTEGER, 0);
    return f.epoch || (f.lastSeq ? 0 : undefined);
  };
  const logOf = (sessionId: string) => logs.get(sessionId) ?? { epoch: fileEpoch(sessionId) || 1, lastSeq: 0 };

  function starting(sessionId: string) {
    if (pending.has(sessionId)) return;
    let resolve = () => {};
    const done = new Promise<void>((r) => (resolve = r));
    const t = setTimeout(() => settle(sessionId), 60_000); // a launch that failed before its runner registered
    t.unref?.();
    pending.set(sessionId, { done, resolve: () => (clearTimeout(t), resolve()) });
  }
  function settle(sessionId: string) {
    pending.get(sessionId)?.resolve();
    pending.delete(sessionId);
  }

  /** The session's writer now: its runner's, else the host's (opened only when `open`). */
  async function writer(sessionId: string, open: boolean): Promise<WriterPort | undefined> {
    await adopting.get(sessionId);
    await pending.get(sessionId)?.done;
    const r = live.get(sessionId);
    if (r) return r.port;
    const h = hostWriters.get(sessionId) ?? (open ? openHost(sessionId) : undefined);
    return h && localPort(await h.w);
  }

  function openHost(sessionId: string) {
    if (!v4 || !isSessionId(sessionId)) return undefined;
    const spec = specs.get(sessionId);
    const journal = journalPath(d.dataDir, sessionId);
    if (!spec && !existsSync(journal)) return undefined;
    ensureSessionJournalDir(d.dataDir, sessionId);
    moveFlatSessionLogged(d.dataDir, sessionId); // what a runner from before the move left flat (goes in step 12 of work 103)
    const { epoch, lastSeq } = logOf(sessionId);
    const h = { socket: apiSocketFor(sessionId, runnersDir), token: mintToken(), epoch, w: undefined as unknown as Promise<HostWriter> };
    h.w = openHostWriter({
      sessionId, journal, epoch, lastSeq, waitMs: 2000, wake,
      seed: { sessionId, owner: ownerOf(spec?.owner) }, created: spec && createdOf(spec),
      socket: { path: h.socket, token: h.token },
    });
    hostWriters.set(sessionId, h);
    h.w.then(
      () => {
        relay.moved(sessionId);
        void bridge.follow(sessionId);
      },
      (e) => {
        if (hostWriters.get(sessionId) === h) hostWriters.delete(sessionId);
        log.warn(`host writer for ${sessionId}: ${e?.message ?? e}`);
      },
    );
    return h;
  }

  /** The host's writer lets go of the session (a runner takes it). */
  async function handOff(sessionId: string) {
    const h = hostWriters.get(sessionId);
    if (!h) return;
    hostWriters.delete(sessionId);
    await h.w.then((w) => w.handOff()).catch((e) => log.warn(`host writer ${sessionId} hand-off: ${e?.message ?? e}`));
  }

  const waker = apiWake({
    spec: (sessionId) => specs.get(sessionId),
    send: (m) => d.send(m),
    start: d.start,
    failQueued: (sessionId, message) => void hostWriters.get(sessionId)?.w.then((w) => w.failQueued(message), () => {}),
  });
  const wake = waker.wake;

  /** Record the session and its log's position from a gateway frame; start mirroring it. */
  function seed(spec: SessionSpec | undefined, sessionId: string | undefined, epoch?: number, lastSeq?: number) {
    if (!isSessionId(sessionId)) return;
    if (spec) specs.set(sessionId, spec);
    if (!v4 || (epoch === undefined && logs.has(sessionId))) return;
    const known = logs.get(sessionId)?.epoch ?? fileEpoch(sessionId);
    const l = { epoch: epoch ?? known ?? 1, lastSeq: lastSeq ?? 0 };
    if (known !== undefined && l.epoch < known) return void meter?.staleDrop(sessionId, l.epoch, known); // a lower epoch is the past: the writer refuses it too
    if (known !== undefined && l.epoch > known) {
      // Only `epoch` moves it (with the DO's events): the gateway sends one on our next stale batch.
      if (!logs.has(sessionId) && known) logs.set(sessionId, { epoch: known, lastSeq: 0 });
      return log.warn(`${sessionId}: epoch ${l.epoch} ahead without an epoch frame (host at ${known}); not adopted`);
    }
    logs.set(sessionId, l);
    bridge.open(sessionId, l.epoch, l.lastSeq);
  }

  const hooks: WireHooks = {
    async where(sessionId) {
      await adopting.get(sessionId);
      await pending.get(sessionId)?.done;
      const r = live.get(sessionId);
      const epochStartSeq = () => readJournalFile(journalPath(d.dataDir, sessionId), Number.MAX_SAFE_INTEGER, 0).startSeq || undefined;
      if (r) return { socket: r.api.socket, token: r.api.token, writer: 'runner', epoch: r.api.epoch, epochStartSeq: epochStartSeq() };
      const h = hostWriters.get(sessionId) ?? openHost(sessionId);
      if (!h) return undefined;
      return h.w.then(
        () => ({ socket: h.socket, token: h.token, writer: 'host' as const, epoch: h.epoch, epochStartSeq: epochStartSeq() }),
        () => undefined,
      );
    },
    async resume(sessionId) {
      const spec = specs.get(sessionId);
      if (!spec) return { error: apiError('session_not_found', `no session ${sessionId} on this computer`, 404) };
      return d.start(spec, {}).then(
        (s) => ({ status: apiStatus(s) }),
        (e) => ({ error: apiError('internal', String(e?.message ?? e), 500, { retryable: true }) }),
      );
    },
    async workspace(sessionId) {
      await forking.get(sessionId); // a push right after the create: the fork it goes to is being made
      const spec = specs.get(sessionId);
      const forkPath = spec && (d.forkPath?.(spec.key) ?? spec.forkPath);
      const owner = spec?.owner.userId;
      if (d.sandbox) {
        const sandbox = spec && (await d.sandbox(spec));
        return sandbox && owner ? { forkPath: sandbox.workspace, owner, sandbox } : undefined;
      }
      return forkPath && owner ? { forkPath, owner } : undefined;
    },
    async record(sessionId, type, data, actor) {
      const w = await writer(sessionId, false);
      const r = await w?.call(RECORD_METHOD, { sessionId, type, data }, { actor, member: actor.id });
      if (r?.error) log.warn(`${type} not recorded in ${sessionId}: ${r.error.code}`);
      return (r?.result as { seq?: number } | undefined)?.seq;
    },
    terminalsChanged(sessionId, open) {
      if (open > 0) terminals.set(sessionId, open);
      else terminals.delete(sessionId);
    },
    telemetry: (name, fields) => meter?.wire(name, fields),
  };
  meter?.setGauges(() => ({
    v4, runnerWriters: live.size, hostWriters: hostWriters.size, mirrorSpooledBytes: bridge.spooledBytes,
    heldFrames: [...held.values()].reduce((n, q) => n + q.length, 0),
  }));

  const relay = apiRelay(d.wire, hooks);

  /**
   * The log moved to `m.epoch` (a recovery): stop the session's writer, take the DO's events, mirror from there. At the
   * same epoch, a journal that lacks the log's events (an adoption torn before they landed) takes them (review r2 P1-2).
   * A runner is retired once; an adoption that fails (a runner that will not die, a held lock) is said once and retried
   * on the gateway's resends with backoff, and tells the relay nothing moved (r2 P2-3).
   */
  async function adopt(m: Extract<GatewayToHost, { t: 'epoch' }>) {
    const { sessionId } = m;
    if (!v4 || !isSessionId(sessionId)) return;
    await adopting.get(sessionId);
    const file = journalPath(d.dataDir, sessionId);
    const f = readJournalFile(file, Number.MAX_SAFE_INTEGER, 0);
    const at = Math.max(logs.get(sessionId)?.epoch ?? 0, f.epoch);
    // Torn: events missing at the epoch, or (a new file) events with no epoch line, whatever `logs` says (r3 P2-4).
    const torn = at === m.epoch && !live.has(sessionId) && ((f.epoch === m.epoch && f.lastSeq < m.lastSeq) || (!f.epoch && f.lastSeq > 0));
    if (at > m.epoch || (at === m.epoch && !torn)) return void (kept.get(sessionId)?.epoch === m.epoch && kept.delete(sessionId)); // already there
    if ((kept.get(sessionId)?.epoch ?? 0) <= m.epoch) kept.set(sessionId, m);
    const fail = failed.get(sessionId);
    if (fail?.epoch === m.epoch && now() < fail.next) return; // backing off
    let done = () => {};
    adopting.set(sessionId, new Promise<void>((r) => (done = r)));
    let ok = false;
    const t0 = now();
    let retiredRunner = false;
    const attempt = fail?.epoch === m.epoch ? Math.round(Math.log2(fail.delay / ADOPT_BACKOFF_MS)) + 2 : 1; // the delay doubles per failure (capped)
    try {
      await pending.get(sessionId)?.done; // a runner being started: let it register, then stop it
      const r = live.get(sessionId);
      if (r && !retired.has(r.runnerId)) retired.add(r.runnerId), (retiredRunner = true), await d.retire?.(r.runnerId);
      await handOff(sessionId);
      ensureSessionJournalDir(d.dataDir, sessionId);
      moveFlatSessionLogged(d.dataDir, sessionId); // what a runner from before the move left flat (goes in step 12 of work 103)
      const j = await Journal.open(file, { sessionId, epoch: m.epoch, lastSeq: m.lastSeq, epochStartSeq: m.startSeq, tail: m.tail, waitMs: fail ? 0 : (d.lockWaitMs ?? 10_000) });
      await j.release();
      forgetJournalFile(file);
      logs.set(sessionId, { epoch: m.epoch, lastSeq: m.lastSeq });
      bridge.open(sessionId, m.epoch, m.lastSeq);
      (ok = true), failed.delete(sessionId);
      if (kept.get(sessionId)?.epoch === m.epoch) kept.delete(sessionId);
      log.info(`${sessionId}: ${torn ? 'repaired' : 'adopted'} epoch ${m.epoch} (from seq ${m.startSeq}, ${m.tail.length} event(s) of the log's)`);
    } catch (e) {
      const delay = fail?.epoch === m.epoch ? Math.min(fail.delay * 2, ADOPT_BACKOFF_MAX_MS) : ADOPT_BACKOFF_MS;
      failed.set(sessionId, { epoch: m.epoch, next: now() + delay, delay });
      const n = held.get(sessionId)?.length ?? 0;
      if (fail?.epoch !== m.epoch)
        log.warn(`${sessionId}: epoch ${m.epoch} not adopted: ${(e as Error)?.message ?? e}; waiting for its writer to let go (retried with backoff${n ? `; ${n} frame(s) held` : ''})`);
    } finally {
      meter?.adopted({ sessionId, epoch: m.epoch, startSeq: m.startSeq, tailEvents: m.tail.length, torn, heldFrames: held.get(sessionId)?.length ?? 0,
        retiredRunner, attempt, ms: now() - t0, ok });
      adopting.delete(sessionId);
      done();
      release(sessionId);
      if (ok) relay.moved(sessionId);
      void bridge.follow(sessionId);
    }
  }

  /** The frame's epoch is ahead of the host's journal, or an adoption is under way: it waits for it. */
  const ahead = (sessionId: string | undefined, epoch: number | undefined): sessionId is string => {
    if (!v4 || epoch === undefined || !isSessionId(sessionId)) return false;
    if (adopting.has(sessionId)) return true;
    const known = logs.get(sessionId)?.epoch ?? fileEpoch(sessionId);
    return known !== undefined && epoch > known;
  };

  /** Resolves once `epoch` is the host's (never under the old one): a `deliver`, `start` or `api` behind an `epoch` frame. */
  function hold(sessionId: string, epoch: number, what: string): Promise<void> {
    const key = `${sessionId}:${epoch}`;
    if (!heldSaid.has(key)) heldSaid.add(key), log.info(`${sessionId}: ${what} at epoch ${epoch} held until the epoch is adopted`);
    if (!asking.has(sessionId)) asking.set(sessionId, setInterval(() => ask(sessionId), d.holdAskMs ?? 10_000));
    const went = meter?.held(sessionId);
    return new Promise((go) => held.set(sessionId, [...(held.get(sessionId) ?? []), { epoch, go: () => (went?.(), go()) }]));
  }

  /**
   * A frame has been held past the deadline and no adoption is running: ask the gateway for the `epoch` frame with an
   * empty batch at the host's epoch (its rule 3: a batch under an older epoch gets `epoch` back; review r3 P1-1).
   */
  function ask(sessionId: string) {
    if (adopting.has(sessionId)) return;
    const k = kept.get(sessionId);
    const fail = failed.get(sessionId);
    if (k && fail?.epoch === k.epoch && now() >= fail.next) return void adopt(k); // the backoff is over: retry it ourselves
    meter?.asked(sessionId);
    d.send({ t: 'journal', sessionId, epoch: logs.get(sessionId)?.epoch ?? fileEpoch(sessionId) ?? 0, events: [] });
  }

  /** After an adoption ends: run, in order, what no longer waits; a failed one keeps the rest held under its backoff. */
  function release(sessionId: string) {
    const q = held.get(sessionId) ?? [];
    const go = q.filter((h) => !ahead(sessionId, h.epoch));
    const wait = q.filter((h) => ahead(sessionId, h.epoch));
    wait.length ? held.set(sessionId, wait) : (held.delete(sessionId), clearInterval(asking.get(sessionId)), asking.delete(sessionId));
    for (const h of go) h.go();
    for (const k of heldSaid) if (k.startsWith(`${sessionId}:`) && !wait.some((h) => k === `${sessionId}:${h.epoch}`)) heldSaid.delete(k);
  }

  async function start(m: Extract<GatewayToHost, { t: 'start' }>) {
    const sessionId = m.session.sessionId ?? m.session.key;
    seed(m.session, m.session.sessionId, m.epoch, m.lastSeq);
    const started = d.start(m.session, { credentials: m.credentials, secrets: m.secrets, model: m.model });
    if (isSessionId(sessionId)) {
      const done = started.catch(() => {});
      forking.set(sessionId, done);
      void done.then(() => forking.get(sessionId) === done && forking.delete(sessionId));
    }
    try {
      const s = await started;
      d.send({ t: 'started', id: m.id, sessionId, status: apiStatus(s) });
    } catch (e) {
      if (isSessionId(sessionId)) waker.failed(sessionId);
      d.send({ t: 'started', id: m.id, sessionId, status: 'suspended', error: apiError('internal', e instanceof Error ? e.message : String(e), 500, { retryable: true }) });
    }
  }

  return {
    /**
     * A gateway frame. Returns true when it was the API's alone (main does nothing more); `welcome`, `people`, `previews` and `deliver` are
     * seen here and then go on to main. A `deliver`, `start` or `api` whose epoch is ahead of the host's returns a promise, settled once its
     * `epoch` frame's adoption commits (main awaits it, so the turn runs under it).
     */
    onGateway(m: GatewayToHost): boolean | Promise<boolean> {
      const sid = m.t === 'api' ? m.sessionId : m.t === 'deliver' || m.t === 'start' ? m.session.sessionId : undefined;
      if ((m.t === 'deliver' || m.t === 'start' || m.t === 'api') && ahead(sid, m.epoch))
        return hold(sid, m.epoch!, m.t).then(() => this.onGateway(m));
      switch (m.t) {
        case 'welcome':
          v4 = m.protocol >= 4;
          relay.people(m.people);
          if (!v4) return false;
          ensureJournalDir(d.dataDir);
          relay.welcome(m.wire?.key);
          relay.start();
          bridge.relinked(); // a new socket: everything the DO has not acked goes again
          return false;
        case 'people':
          relay.people(m.people);
          return false;
        case 'previews':
          if (v4) relay.previews(m.preview.key);
          return false;
        case 'deliver':
          seed(m.session, m.session.sessionId, m.epoch, m.lastSeq);
          return false;
        case 'start':
          void start(m);
          return true;
        case 'api':
          seed(m.session, m.sessionId, m.epoch, m.lastSeq);
          void bridge.api(m);
          return true;
        case 'journal-ack':
          bridge.ack(m);
          return true;
        case 'epoch':
          void adopt(m);
          return true;
        case 'access':
          relay.access(m.access);
          return true;
        case 'revoked':
          relay.revoked(m.keyId);
          return true;
        default:
          return false;
      }
    },

    /** Before a runner is launched or claimed for `spec`: its RunnerApi, with the host's writer handed off; undefined off the API. `run`: the runner's own run root, when it has one (work 103). */
    async mint(spec: SessionSpec, runnerId: string, run?: RunRoot): Promise<RunnerApi | undefined> {
      const sessionId = spec.sessionId;
      if (!v4 || !isSessionId(sessionId)) return undefined;
      specs.set(sessionId, spec);
      waker.woken(sessionId);
      await adopting.get(sessionId);
      starting(sessionId);
      await handOff(sessionId);
      relay.moved(sessionId);
      const { epoch, lastSeq } = logOf(sessionId);
      ensureSessionJournalDir(d.dataDir, sessionId); // the runner opens the journal there and cannot make the directory itself
      moveFlatSessionLogged(d.dataDir, sessionId); // what a runner from before the move left flat (goes in step 12 of work 103)
      const api: RunnerApi = { sessionId, journal: journalPath(d.dataDir, sessionId), epoch, lastSeq, socket: apiSocketFor(runnerId, run ? runnersDirOf(run) : runnersDir), token: mintToken() };
      tokens.set(runnerId, api);
      return api;
    },

    /** A runner now serves its session (launched, claimed, or found after a restart). */
    up(runnerId: string) {
      const api = tokens.get(runnerId);
      if (!api) return;
      const sessionId = api.sessionId;
      live.get(sessionId)?.port.close();
      live.set(sessionId, { runnerId, api, port: remotePort(api.socket, api.token, { dial: d.dial }) });
      settle(sessionId);
      relay.moved(sessionId);
      void bridge.follow(sessionId);
    },

    /** The runner's socket closed (not the host stopping): its session has no writer until one is opened. */
    down(runnerId: string) {
      const api = tokens.get(runnerId);
      tokens.delete(runnerId);
      retired.delete(runnerId);
      if (!api) return;
      const sessionId = api.sessionId;
      const r = live.get(sessionId);
      if (r?.runnerId !== runnerId) return;
      live.delete(sessionId);
      const f = failed.get(sessionId);
      if (f) f.next = 0; // the writer that held the adoption let go: adopt the kept frame now (review r3 P1-1)
      const k = kept.get(sessionId);
      if (f && k) void adopt(k);
      r.port.close();
      relay.moved(sessionId);
      void bridge.follow(sessionId); // finds the host's writer if one opened meanwhile, else stops following
    },

    /** Boot: settle the journals no runner holds (session-writer.ts), and mirror what they hold. */
    async boot() {
      const found = await (d.scan ?? scanJournals)(journals).catch((e) => (log.warn(`boot scan: ${e?.message ?? e}`), []));
      for (const s of found) {
        if (s.skipped) continue;
        if (s.closedTurns.length) log.info(`boot scan: ${s.sessionId} closed ${s.closedTurns.length} turn(s)`);
        bridge.backlog(s.sessionId, s.epoch, s.lastSeq);
      }
      return found;
    },

    /** For the gateway hello: every journal on disk, its epoch and last seq (so the gateway sends `epoch` where it is ahead). */
    journals: (): JournalReport[] => reports(),

    /** After rediscovery: forget the tokens of runners that did not come back. */
    rediscovered(liveRunners: Set<string>) {
      tokens.retain(liveRunners);
    },

    /** A terminal is open in the session: it is not suspended for idleness. */
    terminalsOpen: (sessionId: string | undefined) => !!sessionId && (terminals.get(sessionId) ?? 0) > 0,
    /** Subagents run in the runner (its report says so): it is not idle, whatever `status` says. */
    subagentsRunning,
    /** The session id of a runner's session, if it is an API writer. */
    sessionOf: (runnerId: string) => tokens.get(runnerId)?.sessionId,
    get spooledBytes() {
      return bridge.spooledBytes;
    },
    get enabled() {
      return v4;
    },
    /** For tests. */
    bridge,
    hooks,

    async stop() {
      waker.stop();
      meter?.stop();
      for (const t of asking.values()) clearInterval(t);
      bridge.stop();
      acks.close();
      for (const r of live.values()) r.port.close();
      await relay.close();
    },
  };
}

export type ApiHost = ReturnType<typeof apiHost>;

