// The runner's session writer (work 084): the API of the session this runner
// runs. Reads come from the journal's fold (api/read-methods.ts); writes act on
// the Session (send, interrupt, settings, prompts, subagents) and answer with
// the seq of the event they caused, which the tap (tap.ts) records as the
// session does it.
//
// Invariants:
// - one turn per message: a message to a busy session is queued (at most
//   QUEUE_MAX), steered into the running turn, or interrupts; queued ones
//   start in order as turns end. A steer while asks are open declines every
//   one, and reaches the agent as the person's words (work 084 A6); a queued
//   message leaves them open;
// - the queue is the journal's: a runner that attaches takes the turns it
//   holds `queued` (resume), so none outlive the runner that queued them;
// - an interrupting send is recorded and answered before the harness stops;
//   the stop and the send follow, in order with the API's other sends;
// - `sessions.interrupt` returns at once: the running turn is `cancelling`
//   until the harness stops, and is cancelled `forced` (the harness process
//   ended) when it has not after FORCE_CANCEL_MS of the first API interrupt,
//   whoever (a Slack `!!`) interrupted it before;
// - an API answer to an ask resolves its prompt exactly as a button would
//   (asks.ts, prompts.ts); a stop of a subagent is the panel's Stop button;
// - Slack sees what it saw before, plus the words: a message into a Slack
//   session from anywhere else (the dashboard, the CLI, the API) is posted
//   into its thread before the session takes it, so the thread reads as the
//   whole conversation: the owner's own words under their Slack name and photo
//   when the app has `chat:write.customize`, anyone else's quoted under their name. Nothing else here posts
//   to it beyond what the session's own commands (a model switch) say.
// - a Slack message is a `turns.send` with `slack` (work 118, section 40.11),
//   and a Slack button an `asks.answer` with `slack`, both only from an actor
//   `via: 'slack'`: the message goes through the runner's Slack handling
//   (commands, reactions, files, names) and starts, steers or answers as a
//   Slack message always has, in the turn the cloud named (`turnId`); the
//   button acts on its prompt as a click always has (prompts.ts).

import { log } from '../../log.js';
import { mintId } from '../../session-ids.js';
import { NOT_ASKED, type ApiActor, type ApiError, type Person, type SlackFile } from '../../protocol.js';
import type { Linked } from '../../links.js';
import type { Actor } from '../../api/schema-objects.js';
import type { SessionLog } from '../../api/session-log.js';
import { dispatch, type WriteHandlers } from '../../api/read-methods.js';
import { apiError, type CallOutcome, type SubscribeOptions, type Subscription, type Writer } from '../../api/writer.js';
import type { EffortLevel, PermissionMode } from '../../protocol.js';
import { switchEffort, switchModel, switchSpeed } from '../model-switch.js';
import type { Session } from '../session.js';
import type { AskAnswer } from './asks.js';
import { mayAnswer, prompts } from '../prompts.js';
import { type IfBusy, type SentFrom, Tap } from './tap.js';
import type { ApiWrite } from './write-events.js';
import { WRITES } from '../../api/schema-methods.js';

export const QUEUE_MAX = 20;
export const FORCE_CANCEL_MS = 10_000;

interface Waiting {
  turnId: string;
  text: string;
  actor: Actor;
}

/** `turns.send`'s `slack`: the Slack message the input is, as the Slack actor read it. `context`: the messages held for the thread since its last turn (none, or one `context` entry). */
export interface SlackTurn {
  userId: string;
  ts: string;
  files?: SlackFile[];
  mentioned?: boolean;
  mentionedInline?: boolean;
  context?: Linked[];
  linked?: Linked[];
}

export interface SessionApiOptions {
  /** The session's owner: a Slack message from them is theirs on the API. */
  owner: Person;
  /** `sessions.suspend` recorded: the runner ends. */
  suspend(): void;
  /** Runs API sends in order with the runner's Slack deliveries. */
  serial?<T>(job: () => Promise<T>): Promise<T>;
  /** A Slack message (`turns.send` with `slack`): the runner's Slack handling, in order with its others. Absent: sent as any other message. */
  slack?(text: string, m: SlackTurn, from: SentFrom): Promise<void>;
  now?: () => number;
  /** Each write call, once it returns (api.write telemetry: write-events.ts). Never awaited. */
  onWrite?(w: ApiWrite): void;
}

const fail = (code: string, message: string, status: number, extra: Record<string, unknown> = {}): CallOutcome => ({
  error: apiError(code, message, status, { retryable: status >= 500, ...extra }),
});
const actorOf = (a: ApiActor): Actor => ({ ...a, name: a.name ?? a.id });
/** A person's name for the API: their own, else their git author name without the " via Computer" commits carry. */
export const personName = (p: Person): string => p.name ?? p.gitName.replace(/ via Computer$/, '');

/** Longest echo of a message into Slack; the rest is cut. */
export const ECHO_MAX = 3_000;
const VIA: Record<string, string> = { dashboard: 'the web', opc: 'the CLI', api: 'the API' };

/** A message from outside Slack as posted under its sender's own name: the words, cut, mentions inert. */
export function echoPlain(text: string): string {
  const cut = text.length > ECHO_MAX ? `${text.slice(0, ECHO_MAX)}…` : text;
  return cut.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A message from outside Slack as its thread shows it: the sender, where from, and the words quoted (mentions inert). */
export function echoText(text: string, actor: Actor): string {
  const quoted = echoPlain(text).split('\n').map((l) => `> ${l}`).join('\n');
  return `*${actor.name}* from ${VIA[actor.via] ?? actor.via}:\n${quoted}`;
}

export class SessionApi implements Writer {
  readonly tap: Tap;
  readonly call: Writer['call'];
  private queue: Waiting[] = [];
  /** Every turn this runner queued or started from the queue. */
  private taken = new Set<string>();
  private forceTimer?: NodeJS.Timeout;
  private forcing?: string;
  /** The API's session sends, one after another; `inflight` counts those not done (an interrupt's stop and send run behind its answer). */
  private sending: Promise<unknown> = Promise.resolve();
  private inflight = 0;

  constructor(
    readonly log: SessionLog,
    readonly session: Session,
    private o: SessionApiOptions,
  ) {
    this.tap = new Tap(log, {
      cwd: () => session.info.cwd,
      settings: () => ({ model: session.model ?? null, effort: session.info.effort ?? null, mode: session.info.mode, speed: session.info.speed ?? null }),
      actorOf: (u) => this.slackActor(u),
      idle: () => this.idle(),
      now: o.now,
    });
    session.hooks.api = this.tap;
    const call = dispatch(log, this.handlers());
    const onWrite = o.onWrite;
    this.call = async (method, params, ctx) => {
      if (!WRITES.has(method as never)) return call(method, params, ctx);
      const t0 = performance.now();
      const out = await call(method, params, ctx);
      try {
        onWrite?.({ method, params, ctx, ms: performance.now() - t0, out });
      } catch {} // telemetry never fails a call
      // A suspend ends the runner once its call is over (its idempotency kept); the socket writes the reply before it closes.
      if (method === 'sessions.suspend' && !out.error && log.fold.status === 'suspended') this.o.suspend();
      return out;
    };
  }

  /** A person set the title over the API (kept in the session's info, across restarts): the computer's naming (work 093) leaves it alone. */
  get renamed(): boolean {
    return !!this.session.info.renamed;
  }

  /** The computer named the session (work 093): the journal says so, and the session list follows. */
  named(from: string, to: string) {
    this.log.append('session.updated', { changes: { title: { from, to } } }, { actor: null });
  }

  get sessionId() {
    return this.log.sessionId;
  }

  subscribe(o: SubscribeOptions): Subscription | { error: ApiError } {
    return this.log.subscribe(o);
  }

  /** The runner ends: stop timers, hand the journal back. */
  async close() {
    clearTimeout(this.forceTimer);
    this.tap.asks.closeAll();
    await this.log.release('moved');
  }

  /** A Slack user as the API names people: the owner by their member id, anyone else by their Slack id. */
  private slackActor(u: string | undefined): Actor {
    const owner = this.o.owner;
    if (!u || u === owner.slackUserId) return { id: owner.userId ?? owner.slackUserId ?? 'owner', name: personName(owner), via: 'slack', client: null };
    return { id: u, name: u, via: 'slack', client: null };
  }

  private get busy() {
    return !!this.tap.cur || this.session.isBusy || this.inflight > 0;
  }

  /** A session send, after the API's earlier ones; what waits starts once it is done. */
  private run(job: () => Promise<void>): Promise<void> {
    this.inflight++;
    const p = this.sending.then(() => (this.o.serial ? this.o.serial(job) : job()));
    this.sending = p.catch(() => {});
    return p.finally(() => {
      this.inflight--;
      this.idle();
    });
  }

  /**
   * The runner serves the session: a journal that left it `suspended` or `starting` (a resume, a send, a wake)
   * says the agent is up (`runtime.connected`) and idle until a turn runs.
   */
  connected() {
    const was = this.log.fold.status;
    if (was !== 'suspended' && was !== 'starting') return;
    const resumed = was === 'suspended' || this.log.fold.turns().some((t) => t.status !== 'queued');
    this.log.append('runtime.connected', { warm: false, resumed, durationMs: null }, { actor: null });
    this.tap.setStatus('idle');
  }

  /**
   * The runner attached: the turns the journal holds `queued` (a runner that
   * died left them, or the host's writer recorded them while none ran) wait
   * here in order, and the first starts when the session is idle.
   */
  resume() {
    for (const t of this.log.fold.liveTurns()) {
      // A turn without an author was started by the harness (a subagent ended), not by a message to resend.
      if (t.status !== 'queued' || this.taken.has(t.id) || !t.author) continue;
      this.taken.add(t.id);
      this.queue.push({ turnId: t.id, text: t.input ?? '', actor: t.author });
    }
    this.idle();
  }

  private sent(turnId: string, delivery: string): CallOutcome {
    return { result: { turn: this.log.fold.turn(turnId), delivery, duplicate: false, seq: this.log.lastSeq } };
  }

  private sessionResult(): CallOutcome {
    return { result: { session: this.log.fold.session(), seq: this.log.lastSeq } };
  }

  // ---------------------------------------------------------------- sending

  /** A message into the session, as `turns.send` has it; `turnId`: the turn it starts, when the caller named one (the cloud's inbox). */
  async send(text: string, actor: Actor, ifBusy: IfBusy, turnId: string = mintId('tn')): Promise<CallOutcome> {
    // The wire carries only the member id: the owner's own name is known here, and the model is told it (names.ts `typedIn`).
    if (actor.name === actor.id && actor.id === this.o.owner.userId) actor = { ...actor, name: personName(this.o.owner) };
    await this.echo(text, actor);
    if (!this.busy && !this.queue.length) return this.start({ turnId, text, actor }, { ifBusy });
    const cur = this.tap.cur;
    if (ifBusy === 'interrupt') return this.interruptWith(text, actor, turnId);
    if (ifBusy === 'steer' && cur) {
      await this.run(() => this.session.send(text, undefined, [], undefined, { actor, ifBusy, turnId }));
      return this.sent(cur.id, 'steered');
    }
    if (this.queue.length >= QUEUE_MAX) return fail('queue_full', `at most ${QUEUE_MAX} turns may wait`, 409, { retryable: true, retryAfterMs: 5000 });
    const w = { turnId, text, actor };
    this.log.append('message.received', { input: text, ifBusy, delivery: 'queued', interruptedTurnIds: [], declinedAskIds: [] }, { turnId: w.turnId, actor });
    this.log.append('turn.queued', { position: this.queue.length + 1, trigger: 'message', subagentId: null }, { turnId: w.turnId, actor });
    this.queue.push(w);
    this.taken.add(w.turnId);
    return this.sent(w.turnId, 'queued');
  }

  /** A Slack message: the runner's Slack handling takes it; the turn it started, if it started one (a command, a steer and an answer to a prompt start none). */
  private async slackTurn(text: string, m: SlackTurn, actor: Actor, turnId: string): Promise<CallOutcome> {
    const cur = this.tap.cur?.id;
    await this.run(() => this.o.slack!(text, m, { actor, turnId }));
    const t = this.log.fold.turn(turnId);
    return { result: { turn: t ?? (cur && this.log.fold.turn(cur)) ?? null, delivery: t ? 'started' : cur ? 'steered' : 'none', duplicate: false, seq: this.log.lastSeq } };
  }

  /** A Slack button: it acts on its prompt as a click does, for the person who pressed it. */
  private async button(askId: string, b: { userId: string; value: string }): Promise<CallOutcome> {
    const p = prompts.get(askId);
    const folded = this.log.fold.ask(askId);
    if (!p) return folded ? fail('ask_closed', `the ask is ${folded.status}`, 409, { ask: folded }) : fail('ask_not_found', `no ask ${askId}`, 404);
    const owner = this.o.owner.slackUserId;
    if (!mayAnswer(p, !owner || b.userId === owner ? 'owner' : 'driver', b.userId)) return fail(NOT_ASKED, 'the prompt waits on someone else', 403);
    await p.onAction(b.value, b.userId);
    return { result: { ask: this.log.fold.ask(askId) ?? folded, seq: this.log.lastSeq } };
  }

  /** A message from outside Slack, into a Slack session's thread (never throws: `say` logs Slack's refusals). The owner's
   * own words post under their Slack name and photo when the app may (`chat:write.customize`); anyone else's, quoted. */
  private async echo(text: string, actor: Actor) {
    if (actor.via === 'slack' || !this.session.thread.slack) return;
    const { owner } = this.o;
    if (owner.slackUserId && actor.id === owner.userId && (await this.session.thread.sayAs(owner.slackUserId, echoPlain(text)))) return;
    // `send` named the owner; anyone else the wire named only by id is not known here.
    await this.session.thread.say(echoText(text, { ...actor, name: actor.name === actor.id ? 'Someone' : actor.name }));
  }

  private async start(w: Waiting, from: Omit<SentFrom, 'actor' | 'turnId'>): Promise<CallOutcome> {
    await this.run(() => this.session.send(w.text, undefined, [], undefined, { actor: w.actor, turnId: w.turnId, ...from }));
    return this.sent(w.turnId, from.recorded ? 'queued' : 'started');
  }

  /** A turn ended: the next queued one starts. */
  private idle() {
    if (this.busy) return;
    const w = this.queue.shift();
    if (w) void this.start(w, { recorded: true, ifBusy: 'queue' });
  }

  /**
   * `ifBusy: 'interrupt'`: the message is recorded and answered now; the
   * harness stop and the send follow in the background, in order with the
   * API's other sends (Slack's `!!` path, as a person typing it).
   */
  private interruptWith(text: string, actor: Actor, turnId: string): CallOutcome {
    this.cancelQueued(actor);
    const cur = this.tap.cur;
    if (cur) this.cancelling(cur.id, 'interrupted', actor);
    const from: SentFrom = { actor, turnId, ifBusy: 'interrupt', interrupts: cur?.id };
    this.tap.sent(text, undefined, false, from);
    const asks = this.tap.asks.openIds().length > 0;
    void this.run(async () => {
      if (asks) await this.session.interrupt(); // a prompt would take the text as its answer
      await this.session.send(`!! ${text}`, undefined, [], undefined, { ...from, recorded: true });
    }).catch((e) => log.error('api interrupt send', e));
    return this.sent(turnId, 'started');
  }

  private cancelQueued(actor: Actor, only?: string) {
    for (const w of [...this.queue]) {
      if (only && w.turnId !== only) continue;
      this.queue.splice(this.queue.indexOf(w), 1);
      this.log.append('turn.cancelled', { reason: only ? 'withdrawn' : 'interrupted', forced: false, input: w.text }, { turnId: w.turnId, actor });
    }
  }

  /** The running turn is stopping: `cancelling` now, cancelled `forced` if the harness has not stopped in FORCE_CANCEL_MS. */
  private cancelling(turnId: string, reason: 'interrupted' | 'withdrawn', actor: Actor) {
    this.tap.cancelling ??= reason; // a Slack `!!` may have set it: the turn still goes `cancelling` and is forced
    if (this.log.fold.turn(turnId)?.status !== 'cancelling') this.log.append('turn.status_changed', { from: 'running', to: 'cancelling' }, { turnId, actor });
    if (this.forcing === turnId) return; // armed by an earlier interrupt: its 10 s stand
    this.forcing = turnId;
    clearTimeout(this.forceTimer);
    this.forceTimer = setTimeout(() => {
      if (this.tap.cur?.id !== turnId) return;
      this.tap.forceCancel();
      this.session.kill();
    }, FORCE_CANCEL_MS);
    this.forceTimer.unref?.();
  }

  // ---------------------------------------------------------------- the methods

  private handlers(): WriteHandlers {
    const fold = this.log.fold;
    const s = this.session;
    return {
      'turns.send': (p, ctx) =>
        p.slack && this.o.slack && ctx.actor.via === 'slack'
          ? this.slackTurn(p.input, p.slack as SlackTurn, actorOf(ctx.actor), p.turnId ?? mintId('tn'))
          : this.send(p.input, actorOf(ctx.actor), p.ifBusy ?? 'queue', p.turnId),
      'sessions.compact': (p, ctx) => this.send(`/compact${p.instructions ? ` ${p.instructions}` : ''}`, actorOf(ctx.actor), 'queue'),
      'sessions.interrupt': (p, ctx) => {
        const actor = actorOf(ctx.actor);
        const cur = this.tap.cur;
        if (p.turnId && p.turnId !== cur?.id && !this.queue.some((w) => w.turnId === p.turnId)) return this.sessionResult();
        this.cancelQueued(actor);
        if (cur) this.cancelling(cur.id, 'interrupted', actor);
        void s.interrupt(); // prompts close `interrupted` now; the turn ends when the harness stops
        return this.sessionResult();
      },
      'turns.cancel': (p, ctx) => {
        if (this.queue.some((w) => w.turnId === p.turnId)) {
          this.cancelQueued(actorOf(ctx.actor), p.turnId);
          return { result: { turn: fold.turn(p.turnId), seq: this.log.lastSeq } };
        }
        const t = fold.turn(p.turnId);
        if (!t) return fail('turn_not_found', `no turn ${p.turnId}`, 404);
        return fail('turn_not_cancellable', `the turn is ${t.status}`, 409, { turn: t });
      },
      'sessions.update': async (p, ctx) => {
        const actor = actorOf(ctx.actor);
        if (p.mode !== undefined && p.mode !== s.info.mode) await s.setMode(p.mode as PermissionMode);
        if (p.model !== undefined && p.model !== s.model) await switchModel(s, p.model);
        if (p.effort !== undefined && p.effort !== s.info.effort) await switchEffort(s, p.effort as EffortLevel);
        if (p.speed !== undefined && p.speed !== s.info.speed) await switchSpeed(s, p.speed);
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        if (p.title !== undefined && p.title !== s.info.title) (changes.title = { from: s.info.title, to: p.title }), (s.info.title = p.title), (s.info.renamed = true), s.persist();
        const cur = fold.session();
        if (p.archived !== undefined && p.archived !== cur.archived) changes.archived = { from: cur.archived, to: p.archived };
        for (const [k, v] of Object.entries(p.metadata ?? {})) if ((cur.metadata[k] ?? null) !== v) changes[`metadata.${k}`] = { from: cur.metadata[k] ?? null, to: v };
        if (Object.keys(changes).length) this.log.append('session.updated', { changes }, { actor });
        this.tap.syncSettings(actor);
        if (p.model !== undefined && p.model !== s.model && s.info.model !== p.model)
          return fail('invalid_request', `the model ${p.model} was not accepted; still on ${s.model}`, 400, { field: 'model' });
        return this.sessionResult();
      },
      'sessions.suspend': async (p, ctx) => {
        const actor = actorOf(ctx.actor);
        const status = fold.status;
        const subagents = this.tap.subagents.running();
        if (status === 'suspended' || (p.ifIdle && (status !== 'idle' || subagents.length || this.queue.length))) return this.sessionResult();
        const waiting = this.tap.asks.openIds().length > 0;
        if (this.busy && !waiting) return fail('session_busy', 'a turn is running; interrupt it first', 409);
        if (waiting) {
          if (this.tap.cur) this.cancelling(this.tap.cur.id, 'interrupted', actor);
          await s.interrupt();
        }
        this.cancelQueued(actor);
        for (const a of subagents) await this.stopSubagent(a.id, actorOf(ctx.actor), true);
        this.tap.asks.closeAll();
        this.log.append('runtime.suspended', { reason: 'requested' }, { actor });
        this.tap.setStatus('suspended');
        return this.sessionResult(); // the runner ends after the reply (`call`)
      },
      // The host started this runner for the call (NEEDS_AGENT): the session is not suspended, so it is returned unchanged.
      'sessions.resume': () => this.sessionResult(),
      'subagents.stop': async (p, ctx) => {
        const a = this.tap.subagents.get(p.subagentId) ?? fold.subagent(p.subagentId);
        if (!a) return fail('subagent_not_found', `no subagent ${p.subagentId}`, 404);
        if (a.status !== 'running') {
          if (a.status === 'stopped' && a.stoppedBy?.id === ctx.actor.id) return { result: { subagent: fold.subagent(a.id) ?? a, seq: this.log.lastSeq } };
          return fail('subagent_ended', `the subagent is ${a.status}`, 409, { subagent: fold.subagent(a.id) ?? a });
        }
        await this.stopSubagent(a.id, actorOf(ctx.actor));
        return { result: { subagent: fold.subagent(a.id) ?? a, seq: this.log.lastSeq } };
      },
      'asks.answer': (p, ctx) => {
        if (p.slack && ctx.actor.via === 'slack') return this.button(p.askId, p.slack);
        if (!p.answer) return fail('invalid_request', 'answer is required', 400, { field: 'answer' });
        return this.ask(p.askId, (asks) => asks.answer(p.askId, p.answer as AskAnswer, actorOf(ctx.actor)));
      },
      'asks.dismiss': (p, ctx) => this.ask(p.askId, (asks) => asks.dismiss(p.askId, p.message, actorOf(ctx.actor))),
    };
  }

  /** Stop one subagent as the panel's Stop button does; `now`: record it ended without waiting for the harness (the runner is going). */
  private async stopSubagent(id: string, by: Actor, now = false) {
    const task = this.tap.subagents.taskOf(id);
    if (!task) return;
    this.tap.subagents.stopping(id, by);
    await this.session.stopTask(task).catch(() => {});
    if (now) this.tap.event({ t: 'task', id: task, state: 'stopped' });
  }

  private ask(id: string, act: (asks: Tap['asks']) => ReturnType<Tap['asks']['answer']>): CallOutcome {
    const known = this.tap.asks.get(id);
    const folded = this.log.fold.ask(id);
    if (!known && folded) return fail('ask_closed', `the ask is ${folded.status}`, 409, { ask: folded });
    const r = act(this.tap.asks);
    return 'error' in r ? { error: r.error } : { result: { ask: this.log.fold.ask(id) ?? r.ask, seq: r.seq } };
  }
}
