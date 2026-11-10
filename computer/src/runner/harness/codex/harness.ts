// Codex behind the seam (../types.ts): one `codex app-server` per session,
// on a thread of its own, reaching the model through Calvin's loopback
// (work 082). Calvin's inputs become turns, one at a time; a steer goes into
// the running turn; Codex's notifications become records (translate.ts) and
// its requests gate asks (serve.ts).
//
// Invariants:
// - the process lives exactly as long as the scope: the scope's finalizer
//   (`close`) kills it, ends the records without a failure and aborts every
//   waiting ask; a process that dies on its own fails `events` once;
// - at most one turn of Calvin's is running or starting; queued inputs start
//   in order, each when the previous turn's `turn_ended` is out;
// - every input that was queued ends in a `turn_ended`: its turn's, or one
//   of ours when turn/start fails, so Session never waits on a lost turn;
// - nothing is sent to Codex before its thread exists: inputs wait for it;
// - `interrupt` never fails, and an interrupt asked while a turn is still
//   starting is sent as soon as its id is known.

import { existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Effect, Stream } from 'effect';
import { log } from '../../../log.js';
import { userContent } from '../../attachments.js';
import { SYSTEM_APPEND } from '../../system-prompt.js';
import {
  type Admission,
  type Capabilities,
  type Effort,
  type Harness,
  type HarnessEvent,
  HarnessFailed,
  type HarnessStartup,
  type Input,
  type Mode,
  type ModelInfo,
  type Speed,
  type StartSpec,
} from '../types.js';
import type { Naming } from '../title.js';
import { type Wire, AppServer, TIMED_OUT } from './app-server.js';
import { codexHome, configToml, PROVIDER, spawnEnv, writeHome } from './config.js';
import { codexPids, loopback, type PeerCheck } from './loopback.js';
import { Mailbox } from './mailbox.js';
import { Served } from './serve.js';
import { nameThread } from './title.js';
import { Translator } from './translate.js';

export const CODEX_CAPS: Capabilities = {
  prewarm: false,
  steer: true,
  compact: false,
  subagents: false,
  stopTask: false,
  thinking: true,
  effort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  modes: ['default', 'bypassPermissions'],
  costUsd: false,
  hooks: false,
};

/** What runs Codex on this machine: read once, in the runner's main.ts. */
export interface CodexOptions {
  /** The `codex` launcher (SP_CODEX_BIN). */
  bin: string;
  /** oc-modelproxy's socket (SP_MODEL_SOCKET); absent or missing, Codex has no model and fails to start. */
  socket?: string;
  /** Where sessions' CODEX_HOMEs live: a directory the runner's user owns (main.ts: under its HOME). */
  root: string;
  /** Attest each loopback peer's cgroup (loopback.ts); false only where runners are not systemd units (SP_CODEX_PEER_CHECK=off). */
  peerCheck: boolean;
  sessionKey: string;
  /** The runner's environment, which the child's is made from (config.ts). */
  env: NodeJS.ProcessEnv;
  /** The session's secrets, sourced before each command (session-secrets.ts). */
  envFile?: string;
  /** Calvin's default models, every harness's (tiers.ts): a session on one runs Codex's default without a note; any other unserved model, one a person picked, gets one. */
  defaults?: string[];
  /** Calvin's own version, as Codex's client name reports it. */
  version: string;
  /** A request of ours failed: its method and code (telemetry). */
  rpcFailed?(method: string, code: number): void;
  /** The loopback refused a peer, or was slow to attest one (telemetry). */
  peerChecked?(c: PeerCheck): void;
}

interface CodexModel {
  id: string;
  model?: string;
  displayName?: string;
  hidden?: boolean;
  isDefault?: boolean;
  supportedReasoningEfforts?: { reasoningEffort: string }[];
  serviceTiers?: { id: string; name: string }[];
}

/** Codex's Fast mode, the API's priority processing: on wherever the model offers it unless the speed is `standard`, as Claude's fastMode is (process.ts). */
const FAST = 'priority';

const TIMEOUT_INIT = 30_000;
/** Codex's notifications that something about its setup is wrong or going away (0.163.0's schema). */
const WARNINGS = new Set(['warning', 'deprecationNotice', 'configWarning', 'guardianWarning']);
const asFailed = (e: unknown) =>
  e instanceof HarnessFailed ? e : new HarnessFailed({ reason: 'exit', message: (e as Error)?.message ?? String(e) });
const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));
const ms = (from: number) => Math.round(performance.now() - from);

/** Codex's approval policy for Calvin's mode: ask as Claude Code's default mode does, or never. */
const policyOf = (m: Mode) => (m === 'bypassPermissions' ? 'never' : 'untrusted');

/** An input as Codex's UserInput list: the text with its attachment notes, and images by path. */
export function userInput(i: Input) {
  const content = userContent(i.text, i.attachments);
  const first = typeof content === 'string' ? undefined : content[0];
  const text = typeof content === 'string' ? content : first?.type === 'text' ? first.text : i.text;
  const images = i.attachments.filter((a) => a.image && a.path && !a.pending).map((a) => ({ type: 'localImage' as const, path: a.path! }));
  return [{ type: 'text' as const, text, text_elements: [] }, ...images];
}

interface Current {
  id?: string;
  stop?: boolean;
}

export class CodexHarness implements Harness {
  readonly id = 'codex' as const;
  readonly caps = CODEX_CAPS;
  readonly events: Stream.Stream<HarnessEvent, HarnessFailed>;
  readonly ready: Effect.Effect<void, HarnessFailed>;
  readonly interrupt: Effect.Effect<void>;
  readonly models: Effect.Effect<ModelInfo[], Error>;
  startup?: HarnessStartup;

  private srv?: AppServer;
  private box: Mailbox<HarnessEvent>;
  private t = new Translator();
  private served: Served;
  private thread?: string;
  private queue: Input[] = [];
  private current?: Current;
  private closed = false;
  private catalog: CodexModel[] = [];
  private model: string;
  private effort: Effort;
  private speed: Speed;
  private cwd: string;
  /** Threads of the harness's own (naming, title.ts), by id, and who reads their notifications. */
  private own = new Map<string, (method: string, p: Wire) => void>();
  mode: Mode;

  constructor(spec: StartSpec, o: CodexOptions) {
    this.model = spec.model;
    this.effort = spec.effort;
    this.speed = spec.speed;
    this.cwd = spec.cwd;
    this.mode = CODEX_CAPS.modes.includes(spec.mode) ? spec.mode : 'default';
    this.box = new Mailbox({ pause: () => this.srv?.pause(), resume: () => this.srv?.resume() });
    const mode = () => this.mode;
    this.served = new Served(spec.tools, {
      gate: spec.gate,
      get mode() {
        return mode();
      },
      setMode: (m) => (CODEX_CAPS.modes.includes(m) ? (this.mode = m) : log.info(`codex: mode ${m} is not Codex's; staying ${this.mode}`)),
      item: (id) => this.t.items.get(id),
    });
    this.events = Stream.fromAsyncIterable(this.box, asFailed);
    const booting = this.boot(spec, o);
    booting.catch((e) => this.fail(asFailed(e)));
    this.ready = Effect.tryPromise({ try: () => booting, catch: asFailed });
    this.interrupt = Effect.promise(() => this.stop());
    this.models = Effect.tryPromise({ try: () => this.list(), catch: asError }).pipe(
      Effect.map((ms) => ms.filter((m) => !m.hidden).map((m) => ({ id: m.model ?? m.id, label: m.displayName ?? m.id }))),
    );
  }

  private async boot(spec: StartSpec, o: CodexOptions) {
    const t0 = performance.now();
    // Codex reaches a model only through the proxy (no credential of its own): no socket, no Codex.
    if (!o.socket || !existsSync(o.socket)) throw new HarnessFailed({ reason: 'exit', message: 'harness unavailable: codex (this computer has no model proxy)' });
    const { port } = await loopback(o.socket, { peerCheck: o.peerCheck, checked: o.peerChecked });
    if (this.closed) throw new HarnessFailed({ reason: 'exit', message: 'closed before it started' });
    const home = codexHome(o.root, o.sessionKey);
    writeHome(home, configToml({ model: this.model, port, cwd: spec.cwd }));
    const srv = (this.srv = new AppServer({
      bin: o.bin,
      args: ['app-server'],
      cwd: spec.cwd,
      env: spawnEnv(o.env, { home, envFile: o.envFile }),
      onNotification: (m, p) => this.note(m, p),
      onRequest: (m, p, id) => this.served.request(m, p, id),
      onClose: (why) => {
        if (srv.pid) codexPids.delete(srv.pid);
        this.exited(why);
      },
      onFailed: o.rpcFailed,
    }));
    if (srv.pid) codexPids.add(srv.pid);
    const t1 = performance.now();
    const init = await srv.request<{ userAgent?: string }>(
      'initialize',
      { clientInfo: { name: 'calvin', title: null, version: o.version }, capabilities: { experimentalApi: true } },
      TIMEOUT_INIT,
    );
    srv.notify('initialized');
    const t2 = performance.now();
    await this.list();
    const note = this.pick(this.model, o.defaults);
    // dynamicTools on resume too: a resumed thread gets this runner's tools, not the ones it was started with.
    const common = {
      cwd: spec.cwd,
      model: this.model,
      approvalPolicy: policyOf(this.mode),
      sandbox: 'danger-full-access',
      developerInstructions: SYSTEM_APPEND,
      modelProvider: PROVIDER,
      dynamicTools: this.served.specs(),
    };
    let resumed = false;
    let thread: string | undefined;
    if (spec.resume) {
      // Not this harness's (a Claude session id) or gone: a new thread, as a lost Claude session starts over.
      thread = await srv
        .request<{ thread: { id: string } }>('thread/resume', { threadId: spec.resume, ...common })
        .then((r) => r.thread.id)
        .catch((e) => void log.warn(`codex: thread ${spec.resume} not resumed (${e.message}); starting a new one`));
      resumed = !!thread;
    }
    thread ??= (
      await srv.request<{ thread: { id: string } }>('thread/start', common)
    ).thread.id;
    this.thread = thread;
    this.t.follow(thread);
    const version = /\/(\d+\.\d+\.\d+\S*)/.exec(init.userAgent ?? '')?.[1];
    this.startup = { version, spawnMs: Math.round(t1 - t0), initializeMs: Math.round(t2 - t1), threadMs: ms(t2), resumed };
    log.info(`codex ${version ?? '?'} up: thread ${thread}${resumed ? ' (resumed)' : ''}, model ${this.model}${this.speedFor() ? ' (fast)' : ''}, ${ms(t0)} ms`);
    this.box.push({ t: 'session', ref: { harness: 'codex', id: thread }, model: this.model, startup: this.startup, ...(note && { note }) });
    this.next();
  }

  /** Codex's model catalog, fetched once. */
  private async list() {
    if (!this.catalog.length && this.srv) this.catalog = (await this.srv.request<{ data?: CodexModel[] }>('model/list', {})).data ?? [];
    return this.catalog;
  }

  /**
   * Run `want` if Codex serves it here, else Codex's own default. A session that never chose a
   * model asks for Calvin's default (tiers.ts; Claude's, for a thread that started on Claude):
   * that is Codex's default without a word; any other model Codex does not serve comes back as a
   * line for the person.
   */
  private pick(want: string, calvins: string[] = []) {
    if (!this.catalog.length || this.catalog.some((m) => (m.model ?? m.id) === want)) return undefined;
    const d = this.catalog.find((m) => m.isDefault) ?? this.catalog.find((m) => !m.hidden) ?? this.catalog[0];
    this.model = d.model ?? d.id;
    if (calvins.includes(want)) return void log.info(`codex: ${want} is Calvin's default; running Codex's default, ${this.model}`);
    log.warn(`codex: model ${want} is not served; using ${this.model}`);
    return `:information_source: Codex does not serve \`${want}\` here, so this session runs on \`${this.model}\`.`;
  }

  /** The effort for this turn: the session's, where the model supports it; else the model's default (null). */
  private effortFor() {
    const m = this.catalog.find((x) => (x.model ?? x.id) === this.model);
    const ok = !m?.supportedReasoningEfforts || m.supportedReasoningEfforts.some((e) => e.reasoningEffort === this.effort);
    return ok ? this.effort : null;
  }

  /** Fast where this model offers it and the session did not ask for `standard`; else null, the model's own. */
  private speedFor() {
    if (this.speed === 'standard') return null;
    const m = this.catalog.find((x) => (x.model ?? x.id) === this.model);
    return m?.serviceTiers?.some((t) => t.id === FAST) ? FAST : null;
  }

  private note(method: string, p: Wire) {
    const own = this.own.get(p?.threadId ?? p?.thread?.id);
    if (own) return own(method, p);
    if (method === 'serverRequest/resolved') return this.served.resolved(p?.requestId);
    if (WARNINGS.has(method)) return log.warn(`codex ${method}: ${JSON.stringify(p).slice(0, 2000)}`);
    const records = this.t.translate(method, p);
    if (!records.length) return;
    this.box.push(...records);
    if (records.some((r) => r.t === 'turn_ended')) {
      this.served.abortAll();
      this.current = undefined;
      this.next();
    }
  }

  /** The session's title after a turn (title.ts). */
  async name(): Promise<Naming | undefined> {
    const srv = this.srv;
    if (!srv || !this.thread) return undefined;
    return nameThread(
      {
        request: (method, params) => srv.request(method, params),
        listen: (thread, on) => (this.own.set(thread, on), () => this.own.delete(thread)),
        model: this.model,
        cwd: this.cwd,
      },
      this.thread,
    );
  }

  send(input: Input, how: Admission): Effect.Effect<void> {
    return Effect.sync(() => {
      const turn = this.current?.id;
      if (how === 'steer' && turn && this.thread) return void this.steer(input, turn);
      this.queue.push(input);
      this.next();
    });
  }

  /** Into the running turn; if it ended meanwhile, the input starts the next one. */
  private steer(input: Input, turn: string) {
    this.srv!.request('turn/steer', { threadId: this.thread, input: userInput(input), expectedTurnId: turn }).catch((e) => {
      log.info(`codex: steer not taken (${e.message}); queued`);
      this.queue.push(input);
      this.next();
    });
  }

  /** Start the next queued input's turn, when nothing is running. */
  private next() {
    if (this.closed || !this.thread || this.current || !this.queue.length) return;
    const input = this.queue.shift()!;
    const cur: Current = (this.current = {});
    this.srv!.request<{ turn: { id: string } }>('turn/start', {
      threadId: this.thread,
      input: userInput(input),
      model: this.model,
      effort: this.effortFor(),
      serviceTier: this.speedFor(),
      approvalPolicy: policyOf(this.mode),
      summary: 'auto',
    }).then(
      (r) => {
        cur.id = r.turn.id;
        if (cur.stop) void this.stop(cur);
      },
      (e: Error & { code?: number }) => {
        // No answer in time: Codex may still start this turn, and a second one would run beside it.
        if (e.code === TIMED_OUT) return this.fail(new HarnessFailed({ reason: 'exit', message: `codex app-server hung: ${e.message}` }));
        if (this.current !== cur) return;
        this.current = undefined;
        log.warn('codex: turn/start failed', e.message);
        this.box.push(
          { t: 'message' },
          { t: 'text', delta: `Codex could not start the turn: ${e.message}` },
          { t: 'turn_ended', reason: 'error', detail: 'turn_start_failed' },
        );
        this.next();
      },
    );
  }

  /** Interrupt turn `cur` (the running one by default); one whose id is not known yet is interrupted once it is. */
  private async stop(cur = this.current) {
    if (!cur || cur !== this.current || !this.srv) return;
    if (!cur.id) return void (cur.stop = true);
    await this.srv.request('turn/interrupt', { threadId: this.thread, turnId: cur.id }).catch((e) => log.warn('codex: interrupt', e.message));
  }

  setModel(model: string) {
    return Effect.tryPromise({
      try: async () => {
        const ms = await this.list();
        if (ms.length && !ms.some((m) => (m.model ?? m.id) === model)) {
          throw new Error(
            `Codex does not serve ${model} here; it serves ${ms
              .filter((m) => !m.hidden)
              .map((m) => m.model ?? m.id)
              .join(', ')}`,
          );
        }
        this.model = model; // from the next turn
      },
      catch: asError,
    });
  }

  setMode(mode: Mode) {
    return CODEX_CAPS.modes.includes(mode)
      ? Effect.sync(() => void (this.mode = mode))
      : Effect.fail(new Error(`Codex runs in ${CODEX_CAPS.modes.join(' or ')} mode, not ${mode}`));
  }

  setEffort(effort: Effort) {
    return Effect.sync(() => void (this.effort = effort));
  }

  setSpeed(speed: Speed) {
    return Effect.sync(() => void (this.speed = speed));
  }

  stopTask(_id: string) {
    return Effect.fail(new Error('Codex sessions have no background tasks to stop'));
  }

  /** The scope's finalizer: synchronous, and final. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.served.abortAll();
    this.srv?.kill();
    this.box.end();
  }

  private exited(why: string) {
    if (this.closed) return this.box.end();
    this.fail(new HarnessFailed({ reason: 'exit', message: `codex app-server exited (${why})` }));
  }

  private fail(e: HarnessFailed) {
    if (this.box.ended) return;
    log.error('codex:', e.message);
    this.served.abortAll();
    this.srv?.kill();
    this.box.end(e);
  }
}
