// One Slack conversation (a thread, or a whole code channel) driving one
// long-lived agent harness (harness/types.ts; Claude Code today).
//
// Presence mechanics:
// - every model token streams into the current Segment (one Slack message)
// - tool calls show up the moment the model starts writing them, then flip to
//   done/error with a short output tail (timeline.ts)
// - a user message mid-turn joins the running turn (priority 'next') and the
//   output rotates to a fresh message below it: a conversation, not a log
// - permission prompts and AskUserQuestion become buttons; a typed reply while
//   a prompt is open answers it (prompts.ts)
// - Slack's native stop button and `!stop` interrupt the turn (commands.ts)
//
// The Session owns the harness, the turn and the live message; it reads the
// harness's records, never its own messages, and talks to Slack through its
// Surface (api/surface.ts); the API tap (api/tap.ts) hears turns, changing none.

import { Effect, Stream } from 'effect';
import type { WebClient } from '@slack/web-api';
import type { AgentsPanel } from './agents.js';
import type { History, Segment, Task } from './segment.js';
import { bashDetails, editStats, HIDDEN_TOOLS, fmtStatus, summarizeOutput, todoDetails, toolTitle } from './format.js';
import { gitDiff } from '../workspace.js';
import { safeKey } from '../workspaces/index.js';
import type { Attachment } from './attachments.js';
import { labelled, type Mentioned } from './names.js';
import { log } from '../log.js';
import type { PromptGuard } from './prompt-guard.js';
import type { CheckoutResult, EffortLevel, PermissionMode, SecretRequest, Speed, SpawnRequest, SpawnResult } from '../protocol.js';
import type { ThreadHooks } from './threads.js';
import type { PreviewHooks } from './preview.js';
import { fileSender, type FileSender } from './send-file.js';
import { cardSender } from './post-card.js';
import type { SessionSecrets } from './session-secrets.js';
import { TIERS, takeTier } from '../tiers.js';
import { FIRST_THINKING_CARD_MS, OPENING_THINKING_CARD_MS, THINKING_CARD_MS, ThinkingCards } from './thinking.js';
import { ReminderFilter } from './stream.js';
import { SILENT } from './system-prompt.js';
import { close, type Compactor, type Gate, type Harness, type HarnessEvent, type HarnessKind, type Running, type StartSpec, type TaskRecord } from './harness/types.js';
import { claude } from './harness/claude/harness.js';
import type { SessionStatus, ThreadInfo } from './thread.js';
import { isSurface, SlackSurface, type Surface } from './api/surface.js';
import type { SentFrom, SessionTap } from './api/tap.js';
import { FOLD_AT, Timeline, tail } from './timeline.js';
import { replyToPrompts } from './prompt-replies.js';
import { permissionPrompt, prompts, questionPrompt } from './prompts.js';
import { runCommand } from './commands.js';
import type { TurnEvents } from './turn-events.js';
import { Compaction } from './compaction.js';
import { effortOf, speedOf, switchModel } from './model-switch.js';
import { TurnCloser } from './turn-close.js';

export { SILENT, prompts };

export interface SessionInfo {
  key: string;
  kind: 'thread' | 'channel'; // a session created over the API (work 084) is a 'thread' with no channel
  channel?: string;
  threadTs?: string;
  userId?: string;
  teamId?: string;
  cwd: string;
  title: string;
  mode: PermissionMode;
  model?: string;
  effort?: EffortLevel; // `!effort` (model-switch.ts); DEFAULT_EFFORT without
  speed?: Speed; // `!speed` (model-switch.ts); fast without
  sdkSessionId?: string;
}

const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Bash']);

/** Observers for a process that hosts the session (the runner reports these to its host). */
export interface SessionHooks {
  /** The turn started (true) or finished rendering (false). */
  busy?(busy: boolean): void;
  /** Model output for the current turn arrived (first stream event or assistant message). */
  output?(): void;
  /** Start a new thread through the gateway (work 047); offers the spawn_thread tool when set. */
  spawn?(req: SpawnRequest): Promise<SpawnResult>;
  /** Read and post Slack threads through the gateway (work 049 L3); offers read_thread and post_thread when set. */
  threads?: ThreadHooks;
  previews?: PreviewHooks; // public URLs for the session's servers (work 074); offers preview and unpreview
  /** The session's secrets (work 046): usable by commands, redacted from everything posted. */
  secrets?: SessionSecrets;
  /** Withholds copies of Calvin's own prompt from streamed text (Slack calls are guarded at the client). */
  guard?: PromptGuard;
  /** Ask the person for a secret through the gateway; offers the request_secret tool when set. */
  requestSecret?(req: SecretRequest): Promise<void>;
  /** Check out workspace repositories through the host (work 056); offers the checkout_repo tool when set. */
  checkout?(repos: string[]): Promise<CheckoutResult[]>;
  /** `!restart`: exit once the turn is over, so the next message starts on the deployed code and resumes. */
  restart?(): void;
  event?(e: HarnessEvent): void; // every harness record, as the runner watches for refusals (out of credits, a denied model)
  turns?: TurnEvents; // telemetry (work 054): reports turns as facts, never steers them
  api?: SessionTap; // the session's API journal (work 084, api/tap.ts): hears turns, never steers them
}

/** Where a harness compacts only inside a turn: nothing to do between them. */
const NO_COMPACTOR: Compactor = { running: false, cancel() {}, turnEnded() {} };

export class Session {
  readonly thread: Surface;
  private run?: Running;
  /** Subagent panels of this session; the last one takes new agents while any of its agents run. */
  private panels: AgentsPanel[] = [];
  private seg?: Segment;
  /** Folded earlier messages of this turn, once it outgrows FOLD_AT cards. */
  private history?: History;
  private busy = false;
  private turnStart = 0;
  /** A brand-new session (nothing to resume when it was created), and its thread-id header once started. */
  private readonly fresh: boolean;
  private introducing?: Promise<void>;
  private closer = new TurnCloser({
    busy: () => this.busy,
    setStatus: (s) => this.setStatus(s),
    closed: () => this.hooks.turns?.closed(),
    idle: () => this.hooks.busy?.(false),
  });
  /** A message went into the current harness; until then a credential change may replace it (prewarm). */
  private used = false;
  private touched = false;
  private timeline = new Timeline(
    () => this.out,
    () => this.seg,
    (s) => this.hooks.secrets?.redact(s) ?? s,
  );
  private tools = new Map<string, { name: string; input: any }>();
  private thinking = new ThinkingCards(this.timeline, () => this.hooks.turns?.thinkingShown());
  readonly compaction = new Compaction(this.timeline, (f) => this.hooks.turns?.compacted(f), () => this.busy);
  readonly shadow: Compactor;
  private ticker?: NodeJS.Timeout;
  private guard?: (text: string, end: boolean) => string;
  private textFilter = new ReminderFilter((t, end) => {
    this.guard ??= this.hooks.guard?.stream() ?? ((s) => s);
    const g = this.guard(t, end);
    return this.hooks.secrets?.filter(g, end) ?? g;
  });
  /** Start of the current text block, held back while it could still be SILENT. */
  private held?: string;
  /** This turn replied SILENT / showed something besides thinking. */
  private silent = false;
  private spoke = false;
  /** A message went into a running turn and no turn began since: the harness may start one on its own (shadow.ts). */
  private pending = false;
  /** The turn's message is addressed to the agent (not one it may stay silent on). */
  private addressed = true;
  /** The prompt a typed reply answers (prompts.ts), by prompt id. */
  openPrompt?: string;
  maxModel?: string; // the route's model ceiling (model-access.ts): `!model` stays at or below it
  private costUsd = 0;
  private ctxTokens = 0;
  /** Whether the current model message already arrived as deltas. */
  private streamedText = false;
  readonly sendFile: FileSender; // send_file and `calvin-send-file` (the runner serves it): one limit for both
  readonly postCard = cardSender((text, blocks) => this.below(async (b) => void (await b, await this.thread.post(text, blocks))), (b) => this.hooks.secrets?.foundIn(b));

  constructor(
    public info: SessionInfo,
    client: WebClient | Surface,
    public persist: () => void,
    public hooks: SessionHooks = {},
    /** What runs the model: the session spec's harness (work 082), Claude Code by default. */
    readonly kind: HarnessKind = claude,
  ) {
    this.shadow = kind.compactor?.(this) ?? NO_COMPACTOR;
    this.thread = isSurface(client) ? client : new SlackSurface(client, info as ThreadInfo);
    this.fresh = !info.sdkSessionId;
    this.sendFile = fileSender(info.cwd, (f) => this.below((b) => this.thread.upload(f, b)), (b) => this.hooks.secrets?.foundIn(b), (p) => this.hooks.turns?.filePosted(p));
  }

  /** The Slack client; the runner replaces it when the bot token rotates. */
  get client() { return this.thread.client; }
  set client(c: WebClient) { this.thread.client = c; }

  get isBusy() {
    return this.busy;
  }

  /** The thread's id in a copyable form: the fork directory and branch suffix (`sp/<id>`). */
  get threadId() {
    return safeKey(this.info.key);
  }

  private get out(): Segment {
    if (this.seg?.full) this.rotate();
    return (this.seg ??= this.segment());
  }

  /** A new live message; it streams only after the intro and the last turn's message, so the thread reads in order. */
  private segment() {
    return this.thread.segment(Promise.all([this.introducing, this.closer.settled]));
  }

  // ---------------------------------------------------------------- input

  /**
   * A person's message. The intro, the names lookup and the attachments run
   * side by side; the message goes to the model once names and attachments
   * are in, and output waits for the intro only to be posted below it.
   */
  async send(raw: string, userId: string | undefined, files: Attachment[] | Promise<Attachment[]> = [], mentioned?: Mentioned, from?: SentFrom) {
    this.shadow.cancel();
    this.info.userId = userId ?? this.info.userId;
    const urgent = raw.startsWith('!!');
    const { tier, rest: typed } = takeTier(urgent ? raw.slice(2).trim() : raw);
    const intro = this.intro();
    if (tier) {
      await intro; // the model switch answers below the intro
      await switchModel(this, tier);
      if (!typed && !(await files).length) return;
    }
    const named = mentioned === undefined ? typed : this.timed('names', labelled(this.thread, typed, userId ?? '', mentioned));
    const [text, atts] = await Promise.all([named, files]);
    if (await replyToPrompts(this, text, userId ?? '', from, (declined) => this.hooks.api?.replied(text, userId, declined, from) ?? 0)) return;
    // `!! text` is Esc + type: stop what's running, then redirect. The API records the message before the harness stops.
    const stopping = urgent && this.busy;
    if (stopping) this.hooks.api?.sent(text, userId, false, from);
    if (stopping) await (this.hooks.turns?.interrupting('interrupted'), this.stopTurn());
    else if (this.busy) this.rotate();
    const h = this.ensureHarness();
    this.used = true;
    if (this.busy) this.pending = true;
    if (!stopping) this.hooks.api?.sent(text, userId, this.busy && !urgent, from);
    // Mid-turn messages land at the next tool boundary, like Claude Code's queue.
    Effect.runSync(h.send({ text, attachments: atts }, this.busy && !urgent ? 'steer' : 'queue'));
    this.hooks.turns?.pushed(this.busy && !urgent);
    if (!this.busy) this.addressed = mentioned === undefined || mentioned === true;
    // An addressed turn's message opens now, before the model answers (work 068); a steer's output follows its turn's.
    if (!this.busy && this.addressed) this.timeline.open();
    this.beginTurn();
  }

  async command(raw: string, _userId: string) {
    this.shadow.cancel();
    const [cmd, ...rest] = raw.slice(1).trim().split(/\s+/);
    // A command that throws answers in the thread; otherwise the gateway would report it as "couldn't reach the session".
    return runCommand(this, cmd, rest.join(' ')).catch((e) => this.say(`:warning: \`!${cmd}\` failed: ${e?.message ?? e}`));
  }

  /** The session's model, else its harness's default tier (Claude's honours $MODEL). */
  get model() {
    return this.info.model ?? TIERS[this.kind.id].default;
  }

  async interrupt() {
    this.shadow.cancel();
    for (const p of [...prompts.values()]) if (p.session === this) await p.cancel();
    if (this.busy) await (this.hooks.turns?.interrupting('cancelled'), this.stopTurn());
  }

  /** The harness would not stop (the API's 10 s): its process ends, and the pump ends the turn `crashed`. */
  kill() { this.run && close(this.run); }
  get asks() { return this.hooks.api?.asks; }

  /** Stop the running turn; never fails. */
  private stopTurn() {
    return this.run && Effect.runPromise(this.run.harness.interrupt);
  }

  async setMode(mode: PermissionMode) {
    this.info.mode = mode;
    this.persist();
    if (this.run) await Effect.runPromise(this.run.harness.setMode(mode));
    if (this.info.kind === 'channel') void this.updateContextBar();
  }

  // ---------------------------------------------------------------- agent

  /**
   * Start the harness before the first message, so its start-up (230–450 ms)
   * is off the turn. It copies the environment at spawn, so call it once the
   * Claude credentials are in place; `renew` replaces a harness no message
   * went into yet (the credentials changed since it started).
   */
  prewarm(renew = false) {
    if (renew) this.shadow.cancel();
    if (renew && this.run && !this.used) {
      const run = this.run;
      this.run = undefined;
      close(run);
      this.hooks.turns?.harnessEnded(); // the replacement reports its own start
    }
    this.ensureHarness();
  }

  /** The runner is quitting: the harness's scope closes now (its finalizers end its process), not at exit. */
  end() {
    const run = this.run;
    (this.run = undefined), run && close(run);
  }

  /** The harness, started if it is not up. */
  ensureHarness(): Harness {
    if (this.run) return this.run.harness;
    this.used = false;
    const run = (this.run = this.kind.start(this.spec()));
    // Up once its start-up handshake answers, before any turn when prewarmed.
    Effect.runPromise(run.harness.ready).then(
      () => this.run === run && this.hooks.turns?.harnessStarted(run.harness.startup),
      () => {},
    );
    void this.pump(run);
    return run.harness;
  }

  /** What a harness for this session starts with, now. */
  spec(): StartSpec {
    const { cwd, sdkSessionId, mode } = this.info;
    return { cwd, resume: sdkSessionId, mode, model: this.model, effort: effortOf(this.info), speed: speedOf(this.info), gate: this.gate, tools: { cwd: () => cwd, hooks: this.hooks, sendFile: this.sendFile, postCard: this.postCard } };
  }

  /** A claimed spare's harness (work 069, harness/claude/spare.ts): already up, as a prewarmed one is. */
  claimed(run: Running, parkedMs?: number) {
    (this.run = run), (this.used = false), this.hooks.turns?.harnessStarted({ parkedMs }), void this.pump(run);
  }

  /** Continue on a compacted fork (harness/claude/shadow.ts): it replaces the harness as prewarm(true) does, and its id is persisted. */
  adopt(run: Running, sdkSessionId: string, ctxTokens: number) {
    const old = this.run;
    (this.run = run), (this.info.sdkSessionId = sdkSessionId), (this.ctxTokens = ctxTokens);
    old && close(old), this.persist();
    if (this.info.kind === 'channel') void this.updateContextBar();
    void this.pump(run);
  }

  readonly gate: Gate = async (name, input, ask) =>
    (this.shadow.cancel(), ask.kind === 'question') ? questionPrompt(this, input as any, ask.id, ask.signal) : permissionPrompt(this, name, input, ask);

  private async pump(run: Running) {
    const record = (e: HarnessEvent) => {
      this.hooks.turns?.event(e), this.hooks.event?.(e), this.hooks.api?.event(e), this.compaction.observe(e);
      try {
        this.onEvent(e);
      } catch (err) {
        log.error('onEvent', err);
      }
    };
    try {
      await Effect.runPromise(Stream.runForEach(run.harness.events, (e) => Effect.sync(() => record(e))));
    } catch (e: any) {
      if (this.run !== run) return void log.info('replaced harness ended', e?.message ?? e); // prewarm(true) closed it
      log.error('harness died', e);
      this.hooks.turns?.harnessDied();
      await this.say(`:warning: agent process ended: ${e?.message ?? e}`);
    } finally {
      // A harness replaced before its first message (prewarm) leaves the turn to its successor.
      if (this.run === run) {
        this.run = undefined;
        this.hooks.turns?.harnessEnded();
        if (this.busy) this.endTurn('crashed'); // a turn the harness took down: its card shows why
      }
    }
  }

  private beginTurn() {
    if (this.busy) return;
    this.shadow.cancel(); // a fork never swaps under a turn
    this.pending = false;
    this.busy = true;
    this.hooks.api?.began();
    this.turnStart = Date.now();
    this.touched = false;
    this.silent = this.spoke = false;
    void this.setStatus('processing');
    this.hooks.busy?.(true);
    this.ticker = setInterval(() => this.timeline.tick(), 3000);
  }

  private onEvent(e: HarnessEvent) {
    switch (e.t) {
      case 'session':
        this.info.sdkSessionId = e.ref.id;
        this.info.model = e.model;
        this.persist();
        if (e.note) void this.say(e.note);
        if (this.info.kind === 'channel') void this.updateContextBar();
        return;
      case 'request':
        if (e.phase === 'start') return this.requesting();
        this.output();
        if (e.phase === 'first_token') {
          this.timeline.abandonRunning();
          this.streamedText = false;
        }
        if (e.phase === 'first_token' || e.usage) { // this call's input, where reported (Claude: first token; Codex: the end); the turn's sums every call
          const u = e.usage ?? { input: 0 };
          this.ctxTokens = u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
        }
        return;
      case 'block':
        this.output();
        if (e.phase === 'end') return this.emit(this.textFilter.flush(), true), this.thinking.stop(e.id);
        if (e.kind === 'thinking')
          this.thinking.start(e.id, this.timeline.opening ? OPENING_THINKING_CARD_MS : this.addressed && !this.seg && !this.spoke ? FIRST_THINKING_CARD_MS : THINKING_CARD_MS);
        else if (e.kind === 'tool' && e.name) {
          if (HIDDEN_TOOLS.has(e.name)) this.timeline.hide(e.id);
          else {
            this.spoke = true;
            this.timeline.setTask({ id: e.id, name: e.name, title: `${e.name}…`, status: 'in_progress' });
          }
        } else if (e.kind === 'text') this.held = '';
        return;
      case 'live':
        this.output();
        if (e.kind === 'thinking') return this.thinking.delta(e.id, e.delta);
        if (e.delta) this.streamedText = true;
        return this.emit(this.textFilter.push(e.delta));
      case 'message':
        return this.output();
      // A message that never streamed (some SDK failures, notably external-auth
      // validation, arrive only whole): without it Slack showed an empty $0.00
      // completion and hid the actionable error from the person.
      case 'text':
        if (!this.streamedText && e.delta) this.emit(e.delta, true);
        return;
      case 'limit':
        if (e.kind === 'credits' && !this.streamedText) this.silent = true; // the gateway posts the paywall: no reply, no footer
        return;
      case 'tool':
        return this.onTool(e);
      case 'tool_result':
        return this.onToolResult(e);
      case 'task':
        return this.onTask(e);
      case 'turn_ended':
        this.costUsd = e.costTotalUsd ?? this.costUsd;
        return this.endTurn(e.reason === 'interrupted' ? 'interrupted' : e.detail);
    }
  }

  /** Model output for the turn: it is running, and the runner hears of it. */
  private output() {
    this.beginTurn();
    this.hooks.output?.();
  }

  /** The harness started a request with no turn open: a message it held over (a steer with no tool boundary left) starts one, unseen until its first token. */
  private requesting() {
    if (this.busy) return;
    this.shadow.cancel();
    if (this.pending) this.beginTurn();
  }

  /**
   * Model text → the live message. The start of each text block is held back
   * while it could still be SILENT; SILENT itself is never shown.
   */
  private emit(t: string, end = false) {
    if (this.held !== undefined) {
      const s = (this.held += t).trimStart();
      if (!end && SILENT.startsWith(s)) return;
      this.held = undefined;
      if (s.startsWith(SILENT)) {
        this.silent = true;
        t = s.slice(SILENT.length).trimStart();
      } else t = s;
      if (t && this.seg?.endsWithText()) this.out.text('\n\n');
    }
    if (!t) return;
    if (t.trim()) this.spoke = true;
    this.timeline.closeRun();
    this.maybeFold();
    this.out.text(t);
  }

  /** Subagent lifecycle → the agents panel. Arrives during and after turns. */
  private onTask(e: TaskRecord) {
    const owner = this.panels.find((p) => p.has(e.id));
    if (owner) return void owner.onEvent(e);
    if (e.state !== 'started') return;
    let panel = this.panels.at(-1);
    if (!panel?.running) {
      panel = this.thread.panel((id) => this.stopTask(id));
      // The panel is posted below what streamed so far; narration continues under it.
      if (panel.onEvent(e)) {
        this.panels.push(panel);
        if (this.busy) this.rotate();
      } else panel.dispose();
      return;
    }
    panel.onEvent(e);
  }

  /** Stop one subagent (the panel's Stop button and `subagents.stop` alike); its `stopped` record ends it. */
  async stopTask(id: string) {
    if (this.run) await Effect.runPromise(this.run.harness.stopTask(id));
  }

  /** A tool call, whole: a subagent's goes under the call that started it. */
  private onTool(e: Extract<HarnessEvent, { t: 'tool' }>) {
    if (HIDDEN_TOOLS.has(e.name)) return;
    const title = toolTitle(e.name, e.input, this.info.cwd);
    if (e.parent) return this.patchTask(e.parent, { details: `↳ ${title}` });
    const input = e.input as any;
    this.tools.set(e.id, { name: e.name, input });
    const details = e.name === 'TodoWrite' ? todoDetails(input) : e.name === 'Bash' ? bashDetails(input, this.info.cwd) : editStats(e.name, input);
    this.patchTask(e.id, { name: e.name, title, details, status: 'in_progress' });
  }

  private onToolResult(e: Extract<HarnessEvent, { t: 'tool_result' }>) {
    const tool = this.tools.get(e.id);
    if (!tool) return;
    if (FILE_TOOLS.has(tool.name) && e.ok) this.touched = true;
    const prev = this.timeline.get(e.id)?.details;
    const details = prev?.startsWith('running') ? undefined : prev;
    this.patchTask(e.id, { status: e.ok ? 'complete' : 'error', details, output: e.ok ? summarizeOutput(tool.name, e.output) : tail(e.output, 240) });
  }

  private endTurn(failure?: string) {
    if (!this.busy) return;
    // A stopped turn never sees its text block end: post what the filters still hold.
    const rest = this.textFilter.flush();
    if (rest) this.emit(rest, true);
    this.shadow.turnEnded(this.ctxTokens, !this.pending); // a held-over message may start the next turn at once
    const silent = this.silent && !this.spoke && !failure;
    const reason = failure && (failure === 'error_during_execution' ? 'interrupted' : failure); // Claude Code's word for a stop (or a failure)
    this.hooks.turns?.ended(silent, failure), this.hooks.api?.ended(failure);
    clearInterval(this.ticker);
    this.thinking.clear();
    this.timeline.endTurn(reason);
    this.history = this.held = undefined;
    const seg = this.seg;
    this.seg = undefined;
    this.busy = false;
    // Off the pump (turn-close.ts): the next turn's events don't wait for chat.stopStream.
    if (silent) return (log.info(`${this.info.key}: stayed silent`), this.closer.discard(seg));
    const footer = (reason ? `⏹ ${reason} · ` : '') + this.statusLine(Date.now() - this.turnStart, false);
    const touched = this.touched;
    this.closer.finish(seg ?? this.segment(), footer, () => {
      if (this.info.kind !== 'channel') return;
      void this.updateContextBar();
      if (touched) void gitDiff(this.info.cwd).then((d) => void (d && this.thread.setDiffView(d)));
    });
  }

  statusLine(durMs?: number, withCost = true) {
    return fmtStatus({ ...this.info, durMs, ctxTokens: this.ctxTokens, costUsd: withCost ? this.costUsd : undefined });
  }

  // ---------------------------------------------------------------- live message

  patchTask(id: string, patch: Partial<Task>) {
    this.timeline.patchTask(id, patch);
  }

  /**
   * New narration is starting after the live message already holds FOLD_AT
   * cards: fold that message into the turn's compact history and continue in
   * a fresh one, so a long turn never shows more than a few steps at once.
   */
  private maybeFold() {
    const seg = this.seg;
    if (!seg || seg.endsWithText() || seg.openTasks().length || seg.cards < FOLD_AT) return;
    this.seg = undefined;
    this.timeline.dropRun();
    (this.history ??= this.thread.history()).fold(seg);
  }

  /** send_file and post_card: `post` lands below the current message (after its last text, or a fresh session's intro) once `before` settles; output continues under it. */
  private async below(post: (before?: Promise<unknown>) => Promise<void>) {
    const seg = this.seg;
    this.rotate();
    await post((seg?.close() ?? this.introducing)?.catch(() => {}));
  }

  /** Finalize the current message; the next output starts a new one below. */
  rotate() {
    if (this.timeline.opening) this.timeline.closeRun(); // an unclaimed `Started` card is done, not "continues below"
    const seg = this.seg;
    this.seg = undefined;
    this.history = undefined; // what follows sits below a user message or prompt
    if (!seg || seg.empty) return;
    // Running steps continue in the next message; don't leave spinners behind.
    for (const t of seg.openTasks()) seg.task({ ...t, status: 'pending', details: 'continues below ↓', elapsed: undefined });
    this.timeline.dropRun(); // the run's card belongs to the old message
    void seg.close({ sessionStatus: 'processing' });
  }

  // ---------------------------------------------------------------- slack

  /** A brand-new session's first reply, above any output (thread.ts); posted once, never throws. */
  private intro() {
    if (this.fresh) this.introducing ??= this.timed('intro', this.thread.intro(this.threadId));
    return this.introducing;
  }

  private timed<T>(part: 'names' | 'intro', p: Promise<T>): Promise<T> {
    return this.hooks.turns?.timed(part, p) ?? p;
  }

  say(text: string) { return this.thread.say(text); }
  setStatus(status: SessionStatus) { return this.thread.setStatus(status); }

  updateContextBar() {
    return this.thread.showContext({ ...this.info, costUsd: this.costUsd, ctxTokens: this.ctxTokens });
  }
}
