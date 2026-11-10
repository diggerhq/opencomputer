// The session as a fold of its log (work 084, "A session is its event log"):
// events in, the public `Session`, `Turn`, `Ask` and `Subagent` objects out, so
// every read (`sessions.get`, `turns.get`, `asks.*`, `subagents.*`) and every
// writer's decision (is this turn queued, is this ask open) answers from the
// log alone, the same on the runner and on the host. `subagent.progress`
// deltas (never recorded) fold in through `progress`.
//
// Invariants: `apply` takes events in seq order and never throws on an unknown
// type or field (informational, as readers must); every object it returns has
// every field present (null when it does not apply) and is a fresh copy. What
// the log does not say comes from the seed (owner, dashboard url) and from the
// journal (`setLog`: lastSeq, logEpoch, epochStartSeq).
//
// `snapshot` / `Fold.restore` carry the fold's state through a journal
// checkpoint (journal-checkpoint.ts): restoring a snapshot taken after events
// 1..n and applying n+1.. gives the fold of the whole log. A change to what the
// fold keeps or how `apply` builds it bumps FOLD_STATE, so a checkpoint written
// by an older build is refolded from the journal instead.

import type { JournalEvent } from '../protocol.js';
import type { ApiEvent, EventDataOf } from './schema-events.js';
import type { Actor, Ask, Session, Subagent, Turn, TurnSummary, Usage } from './schema-objects.js';

export interface SessionSeed {
  sessionId: string;
  owner: { id: string; name: string; email: string | null };
  dashboardUrl?: string | null;
}

/** The actor of what the agent or the computer did: none (the docs' `actor: null`). */
export const SYSTEM_ACTOR = null;

export interface OpenCall {
  subagentId: string | null;
  toolName: string;
  callId: string;
  parentCallId: string | null;
  title: string;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends ReadonlyArray<infer U> ? U[] : T[K] };
type TurnState = Mutable<Turn>;
/** A message as the fold sees it: its author is null only for a message nobody sent (never a steer). */
type Steer = { input: string; author: Actor | null; createdAt: string };

/** The version of `snapshot`'s shape and of `apply`'s semantics it was built with. */
const FOLD_STATE = 1;

/** Session.lastText is the first this many characters (the docs; blue's fold cuts the same). */
const LAST_TEXT_CHARS = 200;
const ENDED = new Set(['completed', 'failed', 'cancelled']);
const isEnding = (t: string) => t === 'turn.completed' || t === 'turn.failed' || t === 'turn.cancelled';

function addUsage(u: Usage | null, d: EventDataOf<'usage.recorded'>): Usage {
  const n = (k: 'inputTokens' | 'outputTokens' | 'reasoningTokens' | 'cachedTokens' | 'cacheWriteTokens') => (typeof d[k] === 'number' ? d[k] : 0);
  const cost = (a: string | null, b: unknown): string | null => {
    if (typeof b !== 'string') return a;
    return String(Number(((a ? Number(a) : 0) + Number(b)).toFixed(6)));
  };
  return {
    inputTokens: (u?.inputTokens ?? 0) + n('inputTokens'),
    outputTokens: (u?.outputTokens ?? 0) + n('outputTokens'),
    reasoningTokens: (u?.reasoningTokens ?? 0) + n('reasoningTokens'),
    cachedTokens: (u?.cachedTokens ?? 0) + n('cachedTokens'),
    cacheWriteTokens: (u?.cacheWriteTokens ?? 0) + n('cacheWriteTokens'),
    costUsd: cost(u?.costUsd ?? null, d.costUsd),
  };
}

const asActor = (a: JournalEvent['actor']): Actor | null => (a ? { id: a.id, name: a.name ?? a.id, via: a.via, client: a.client } : null);

export class Fold {
  private title = '';
  private origin: Session['origin'] = { type: 'api', client: null, slack: null };
  private settings: Mutable<Session['settings']> = { model: null, effort: null, mode: 'default', speed: null };
  private archived = false;
  private metadata: Record<string, string> = {};
  private sessionStatus = 'starting';
  private createdAt: string | null = null;
  private lastActiveAt: string | null = null;
  private lastText: string | null = null;
  private context: { usedTokens: number | null; windowTokens: number | null } = { usedTokens: null, windowTokens: null };
  private log = { lastSeq: 0, logEpoch: 1, epochStartSeq: 1 };
  private turnMap = new Map<string, TurnState>();
  /** Turns not ended, in creation order. */
  private live = new Set<string>();
  private lastTurnId: string | null = null;
  private askMap = new Map<string, Ask>();
  private calls = new Map<string, Map<string, OpenCall>>();
  private subagentMap = new Map<string, Mutable<Subagent>>();
  /** Each ask's and subagent's first event's seq (list cursors, list-cursor.ts). */
  private firstSeq = new Map<string, number>();

  constructor(readonly seed: SessionSeed) {}

  /** Everything the fold knows from the log, as plain JSON (a checkpoint's fold line). Not a copy: serialize it at once. */
  snapshot(): FoldState {
    return {
      v: FOLD_STATE, title: this.title, origin: this.origin, settings: this.settings, archived: this.archived, metadata: this.metadata,
      status: this.sessionStatus, createdAt: this.createdAt, lastActiveAt: this.lastActiveAt, lastText: this.lastText, context: this.context,
      turns: [...this.turnMap.values()], live: [...this.live], lastTurnId: this.lastTurnId, asks: [...this.askMap.values()],
      calls: [...this.calls].map(([t, m]) => [t, [...m.values()]] as [string, OpenCall[]]), subagents: [...this.subagentMap.values()], firstSeq: [...this.firstSeq],
    };
  }

  /** A fold from a `snapshot` (parsed from JSON); undefined when it is not one this build wrote. */
  static restore(seed: SessionSeed, s: unknown): Fold | undefined {
    const x = s as FoldState | null;
    const arrays = x && [x.turns, x.live, x.asks, x.calls, x.subagents, x.firstSeq].every(Array.isArray);
    if (!arrays || x.v !== FOLD_STATE || !x.settings || !x.origin || !x.context || !x.metadata) return undefined;
    const f = new Fold(seed);
    f.title = x.title;
    f.origin = x.origin;
    f.settings = x.settings;
    f.archived = x.archived;
    f.metadata = x.metadata;
    f.sessionStatus = x.status;
    f.createdAt = x.createdAt;
    f.lastActiveAt = x.lastActiveAt;
    f.lastText = x.lastText;
    f.context = x.context;
    f.turnMap = new Map(x.turns.map((t) => [t.id, t]));
    f.live = new Set(x.live);
    f.lastTurnId = x.lastTurnId;
    f.askMap = new Map(x.asks.map((a) => [a.id, a]));
    f.calls = new Map(x.calls.map(([t, cs]) => [t, new Map(cs.map((c) => [c.callId, c]))]));
    f.subagentMap = new Map(x.subagents.map((a) => [a.id, a]));
    f.firstSeq = new Map(x.firstSeq);
    return f;
  }

  setLog(info: { lastSeq: number; logEpoch: number; epochStartSeq: number }): void {
    this.log = { ...info };
  }

  get status(): string {
    return this.sessionStatus;
  }

  apply(e: JournalEvent): void {
    if (e.seq > this.log.lastSeq) this.log.lastSeq = e.seq;
    this.createdAt ??= e.createdAt;
    this.lastActiveAt = e.createdAt;
    // Writers build `data` to EVENT_DATA; unknown types fall through.
    const ev = { ...e, data: e.data ?? {} } as ApiEvent;
    const tid = e.turnId;
    switch (ev.type) {
      case 'session.created':
        this.title = ev.data.title ?? this.title;
        if (ev.data.origin) this.origin = structuredClone(ev.data.origin) as Session['origin'];
        if (ev.data.settings) this.settings = { ...ev.data.settings, speed: ev.data.settings.speed ?? null }; // a journal from before `speed`: null
        this.createdAt = e.createdAt;
        return;
      case 'session.status_changed':
        if (typeof ev.data.to === 'string') this.sessionStatus = ev.data.to;
        return;
      case 'session.updated':
        this.update(ev.data.changes ?? {});
        return;
      case 'message.received':
        this.received(e, ev.data);
        return;
      case 'turn.queued':
      case 'turn.started': {
        if (!tid) return;
        // A turn the harness started for an ended background subagent names it (`trigger` `subagent`, `subagentId`).
        const by = ev.data.subagentId;
        const t = this.turnMap.get(tid) ?? this.newTurn(tid, e, undefined, 'queue', typeof by === 'string' ? by : undefined);
        if (e.type === 'turn.started') (t.status = 'running'), (t.startedAt = e.createdAt);
        return;
      }
      case 'turn.status_changed': {
        const t = tid ? this.turnMap.get(tid) : undefined;
        if (t && typeof ev.data.to === 'string' && !ENDED.has(t.status)) t.status = ev.data.to;
        return;
      }
      case 'turn.completed':
      case 'turn.failed':
      case 'turn.cancelled':
        this.ended(ev);
        return;
      case 'tool.started':
        if (tid) {
          const m = this.calls.get(tid) ?? new Map<string, OpenCall>();
          m.set(ev.data.callId, { subagentId: ev.data.subagentId ?? null, toolName: ev.data.toolName, callId: ev.data.callId, parentCallId: ev.data.parentCallId ?? null, title: ev.data.title ?? '' });
          this.calls.set(tid, m);
        }
        return;
      case 'tool.completed':
      case 'tool.failed':
        if (tid) this.calls.get(tid)?.delete(ev.data.callId);
        return;
      case 'message.completed':
        if (ev.data.parentCallId == null && typeof ev.data.text === 'string') this.lastText = ev.data.text.slice(0, LAST_TEXT_CHARS);
        return;
      case 'subagent.started':
      case 'subagent.ended': {
        const a = ev.data.subagent;
        if (!a?.id) return;
        this.subagentMap.set(a.id, structuredClone(a) as Mutable<Subagent>);
        if (!this.firstSeq.has(a.id)) this.firstSeq.set(a.id, e.seq);
        return;
      }
      case 'ask.opened':
      case 'ask.closed':
        if (!ev.data.ask?.id) return;
        this.askMap.set(ev.data.ask.id, structuredClone(ev.data.ask) as Ask);
        if (!this.firstSeq.has(ev.data.ask.id)) this.firstSeq.set(ev.data.ask.id, e.seq);
        return;
      case 'usage.recorded': {
        if (ev.data.usedTokens != null) this.context.usedTokens = ev.data.usedTokens;
        if (ev.data.windowTokens != null) this.context.windowTokens = ev.data.windowTokens;
        const t = tid ? this.turnMap.get(tid) : undefined;
        if (t) t.usage = addUsage(t.usage, ev.data);
        return;
      }
    }
  }

  private update(changes: EventDataOf<'session.updated'>['changes']) {
    for (const [field, c] of Object.entries(changes)) {
      const to = c?.to;
      if (field === 'title' && typeof to === 'string') this.title = to;
      else if (field === 'archived') this.archived = to === true;
      else if (field === 'model' || field === 'effort' || field === 'speed') this.settings[field] = typeof to === 'string' ? to : null;
      else if (field === 'mode' && typeof to === 'string') this.settings.mode = to;
      else if (field === 'metadata' && to && typeof to === 'object') this.metadata = { ...(to as Record<string, string>) };
      else if (field.startsWith('metadata.')) {
        const k = field.slice('metadata.'.length);
        if (typeof to === 'string') this.metadata[k] = to;
        else delete this.metadata[k];
      }
    }
  }

  private received(e: JournalEvent, d: EventDataOf<'message.received'>) {
    if (!e.turnId) return;
    const steer: Steer = { input: d.input ?? '', author: asActor(e.actor), createdAt: e.createdAt };
    const existing = this.turnMap.get(e.turnId);
    if (d.delivery === 'steered' && existing) {
      if (steer.author) existing.steering.push({ ...steer, author: steer.author });
    }
    else if (!existing) this.newTurn(e.turnId, e, steer, d.ifBusy);
  }

  /** `m` absent: no message started it (input null); `subagentId`: the ended subagent it was started for. */
  private newTurn(id: string, e: JournalEvent, m: Steer | undefined, ifBusy = 'queue', subagentId?: string): TurnState {
    const bySubagent = !m && !!subagentId;
    const t: TurnState = {
      id,
      sessionId: this.seed.sessionId,
      status: 'queued',
      trigger: bySubagent ? 'subagent' : 'message',
      subagentId: bySubagent ? subagentId! : null,
      ifBusy,
      input: m ? m.input : null,
      // The docs: null when `trigger` is `subagent` (the agent started it), else the message's author.
      author: bySubagent ? null : (m?.author ?? asActor(e.actor)),
      steering: [],
      createdAt: m?.createdAt ?? e.createdAt,
      startedAt: null,
      endedAt: null,
      text: null,
      error: null,
      reason: null,
      forced: null,
      usage: null,
    };
    this.turnMap.set(id, t);
    this.live.add(id);
    return t;
  }

  private ended(e: ApiEvent<'turn.completed' | 'turn.failed' | 'turn.cancelled'>) {
    const t = e.turnId ? this.turnMap.get(e.turnId) : undefined;
    if (!t || ENDED.has(t.status)) return;
    t.status = e.type.slice('turn.'.length);
    t.endedAt = e.createdAt;
    if (e.type === 'turn.completed') {
      t.text = e.data.text ?? null;
      if (t.text != null) this.lastText = t.text.slice(0, LAST_TEXT_CHARS);
    } else if (e.type === 'turn.failed') t.error = e.data.error ?? null;
    else (t.reason = e.data.reason ?? null), (t.forced = e.data.forced ?? false);
    this.live.delete(t.id);
    this.calls.delete(t.id);
    this.lastTurnId = t.id;
  }

  // ---------------------------------------------------------------- reads

  turn(id: string): Turn | undefined {
    const t = this.turnMap.get(id);
    return t && copyTurn(t);
  }

  turns(): Turn[] {
    return [...this.turnMap.values()].map(copyTurn);
  }

  /** Turns not ended, in creation order. */
  liveTurns(): Turn[] {
    return [...this.live].map((id) => copyTurn(this.turnMap.get(id)!));
  }

  /** Whether the turn has ended (completed, failed, cancelled). */
  isEnded(id: string): boolean {
    const t = this.turnMap.get(id);
    return !!t && ENDED.has(t.status);
  }

  ask(id: string): Ask | undefined {
    const a = this.askMap.get(id);
    return a && structuredClone(a);
  }

  asks(): Ask[] {
    return [...this.askMap.values()].map((a) => structuredClone(a));
  }

  /** The seq of the first event of ask or subagent `id` (0: unknown). */
  seqOf(id: string): number {
    return this.firstSeq.get(id) ?? 0;
  }

  openAsks(): Ask[] {
    return this.asks().filter((a) => a.status === 'open');
  }

  subagent(id: string): Subagent | undefined {
    const a = this.subagentMap.get(id);
    return a && { ...a, error: a.error && { ...a.error } };
  }

  /** All subagents, in start order. */
  subagents(): Subagent[] {
    return [...this.subagentMap.keys()].map((id) => this.subagent(id)!);
  }

  /** The subagents `turnId` launched (Result.subagents). */
  turnSubagents(turnId: string): Array<{ id: string; name: string; status: string; background: boolean }> {
    return [...this.subagentMap.values()].filter((a) => a.turnId === turnId).map((a) => ({ id: a.id, name: a.name, status: a.status, background: a.background }));
  }

  runningSubagents(): Subagent[] {
    return this.subagents().filter((a) => a.status === 'running');
  }

  /** A `subagent.progress` delta: its latest values, on a running subagent. */
  progress(d: { subagentId?: string; activity?: string | null; toolCalls?: number; tokens?: number }): void {
    const a = d.subagentId ? this.subagentMap.get(d.subagentId) : undefined;
    if (a?.status !== 'running') return;
    if (d.activity !== undefined) a.activity = d.activity;
    if (typeof d.toolCalls === 'number') a.toolCalls = d.toolCalls;
    if (typeof d.tokens === 'number') a.tokens = d.tokens;
  }

  /** The tool calls of `turnId` started and not yet completed or failed. */
  openCalls(turnId: string): OpenCall[] {
    return [...(this.calls.get(turnId)?.values() ?? [])];
  }

  session(): Session {
    let active: string | null = null;
    const queued: Turn[] = [];
    for (const id of this.live) {
      const t = this.turnMap.get(id)!;
      if (t.status === 'queued') queued.push(copyTurn(t));
      else active = id;
    }
    const last = this.lastTurnId ? this.turnMap.get(this.lastTurnId) : undefined;
    const lastTurn: TurnSummary | null = last
      ? { id: last.id, status: last.status, endedAt: last.endedAt!, text: last.text, error: last.error, reason: last.reason, forced: last.forced }
      : null;
    const now = new Date().toISOString();
    return {
      id: this.seed.sessionId,
      title: this.title,
      status: this.sessionStatus,
      archived: this.archived,
      owner: { ...this.seed.owner },
      origin: structuredClone(this.origin),
      settings: { ...this.settings },
      metadata: { ...this.metadata },
      activeTurnId: active,
      queued,
      asks: this.openAsks(),
      subagents: this.runningSubagents(),
      lastTurn,
      lastText: this.lastText,
      context: { ...this.context },
      lastSeq: this.log.lastSeq,
      logEpoch: this.log.logEpoch,
      epochStartSeq: this.log.epochStartSeq,
      createdAt: this.createdAt ?? now,
      lastActiveAt: this.lastActiveAt ?? this.createdAt ?? now,
      syncedAt: null,
      urls: { dashboard: this.seed.dashboardUrl ?? null },
    };
  }
}

/** What `snapshot` returns. */
interface FoldState {
  v: number; title: string; origin: Session['origin']; settings: Mutable<Session['settings']>; archived: boolean; metadata: Record<string, string>;
  status: string; createdAt: string | null; lastActiveAt: string | null; lastText: string | null; context: { usedTokens: number | null; windowTokens: number | null };
  turns: TurnState[]; live: string[]; lastTurnId: string | null; asks: Ask[]; calls: Array<[string, OpenCall[]]>; subagents: Mutable<Subagent>[];
  firstSeq: Array<[string, number]>;
}

function copyTurn(t: TurnState): Turn {
  return { ...t, steering: t.steering.map((s) => ({ ...s, author: { ...s.author } })), author: t.author && { ...t.author }, usage: t.usage && { ...t.usage } };
}

export { isEnding };
