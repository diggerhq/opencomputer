// Every session's log (SessionLog) and what a host does with a turn: events by `seq` in an epoch,
// the inbox, the summary Org's `session` row carries, and the events read of section 37.1.

import type { Actor, Answer, ApiEvent, Ask, EventPage, IfBusy, InboxEntry, PlaceRow, SessionRow, TurnSummary } from "../types.js";
import { clone, isPerson, Refusal, type Ctx } from "./ctx.js";
import type { FakeAsk } from "./api.js";

export interface Entry {
  id: string;
  kind: "turn" | "answer" | "dismiss";
  input?: string;
  ifBusy?: IfBusy;
  askId?: string;
  answer?: Answer;
}

export interface Turn {
  id: string;
  input: string;
  by: string;
  actor: Actor;
  /** The text of each block so far, for `block` frames. */
  blocks: Map<string, string>;
}

interface Sess {
  id: string;
  events: ApiEvent[];
  epoch: number;
  epochStart: number;
  formerTitles: string[];
  writers: unknown;
  turn: Turn | null;
  queue: { entry: Entry; by: string; actor: Actor }[];
  /** Every entry id accepted, for idempotency. */
  seen: Set<string>;
  turnCount: number;
  blockN: number;
}

/** The event types an agent writes: they move `lastAgentSeq`. */
const AGENT = new Set(["message.completed", "ask.opened", "turn.completed", "turn.failed", "track.note"]);
/** The events after which Org's `session` row is republished (section 40.3). */
const QUIET = new Set(["tool.started", "tool.completed", "tool.failed"]);

export const eventCursor = (epoch: number, seq: number): string => `e1.${epoch}.${seq}`;

export class Log {
  private sessions = new Map<string, Sess>();

  constructor(private ctx: Ctx) {}

  sess(sid: string): Sess {
    let s = this.sessions.get(sid);
    if (!s) this.sessions.set(sid, (s = { id: sid, events: [], epoch: 0, epochStart: 1, formerTitles: [], writers: "members", turn: null, queue: [], seen: new Set(), turnCount: 0, blockN: 0 }));
    return s;
  }

  revive(sid: string): void {
    this.sess(sid);
  }

  destroy(sid: string): void {
    this.sessions.delete(sid);
    this.ctx.live.detach(sid);
  }

  row(sid: string): SessionRow {
    return this.ctx.org.need("session", sid);
  }

  head(sid: string): string {
    const s = this.sess(sid);
    return eventCursor(s.epoch, this.ctx.org.get("session", sid)?.lastSeq ?? 0);
  }

  // ---------- making sessions

  /** Org's `session` row, and a `place` row unless the session is a track's agent. */
  insert(sid: string, o: { role?: SessionRow["role"]; title?: string; createdBy: string; trackId?: string | null; parent?: string | null; at?: number }): SessionRow {
    const { org, principal } = this.ctx;
    const at = this.ctx.iso(o.at);
    this.sess(sid);
    const row = org.put<SessionRow>({
      kind: "session",
      id: sid,
      version: 0,
      title: o.title ?? "",
      titleBy: null,
      agentTitle: null,
      status: "idle",
      archived: false,
      owner: { id: principal.subject, name: "Igor", email: "igor@example.com" },
      origin: { type: "app", client: null, slack: null },
      settings: { model: null, effort: null, mode: "default", speed: null },
      metadata: {},
      activeTurnId: null,
      queued: [],
      asks: [],
      subagents: [],
      lastTurn: null,
      lastText: null,
      context: { usedTokens: null, windowTokens: null },
      lastSeq: 0,
      logEpoch: 0,
      epochStartSeq: 1,
      createdAt: at,
      lastActiveAt: at,
      syncedAt: at,
      urls: { dashboard: null },
      lastAgentSeq: 0,
      blocked: false,
      inbox: [],
      machine: "m_1",
      role: o.role ?? null,
    });
    if (o.role !== "track")
      org.put<PlaceRow>({
        kind: "place",
        id: sid,
        version: 0,
        sessionId: sid,
        trackId: o.trackId ?? null,
        position: o.at ?? this.ctx.now(),
        placedBy: o.createdBy,
        parentSession: o.parent ?? null,
        doneAt: null,
        outcome: null,
        doneBy: null,
        keep: false,
        broughtBackAt: null,
        earlierAt: null,
        readySeq: null,
        readyWhat: null,
        readyResult: null,
        attention: null,
      });
    return row;
  }

  /** `Org.createSession` (section 40.1): idempotent on `id`. */
  create(body: { id?: string; input?: string; turnId?: string; trackId?: string | null; role?: string; model?: string; effort?: string; mode?: string }, by: string, actor: Actor, parent: string | null = null): { status: number; body: unknown } {
    const { org, ctx } = { org: this.ctx.org, ctx: this.ctx };
    const sid = body.id ?? ctx.id("cs");
    const turnId = body.turnId ?? ctx.id("tn", 12);
    const existing = org.get("session", sid);
    const reply = (duplicate: boolean) => {
      const s = this.row(sid);
      return { status: duplicate ? 200 : 201, body: { session: clone(s), turn: { id: turnId, status: s.activeTurnId === turnId ? "running" : "queued" }, delivery: "queued", duplicate, seq: s.lastSeq } };
    };
    if (existing) return reply(true);
    if (typeof body.input !== "string" || !body.input) throw new Refusal("invalid_request", "input is required");
    if (body.trackId) org.need("track", body.trackId);
    org.tx(() => {
      const row = this.insert(sid, { role: body.role === "start" ? "start" : null, createdBy: by, trackId: body.trackId ?? null, parent });
      if (body.model || body.effort || body.mode)
        row.settings = { ...row.settings, model: body.model ?? null, effort: body.effort ?? null, ...(body.mode ? { mode: body.mode } : {}) };
      this.accept(sid, { id: turnId, kind: "turn", input: body.input! }, by, actor);
    });
    return reply(false);
  }

  // ---------- events

  append(sid: string, type: string, data: unknown, o: { turnId?: string | null; actor?: Actor | null; at?: number } = {}): ApiEvent {
    const { org } = this.ctx;
    const s = this.sess(sid);
    const row = this.row(sid);
    const seq = row.lastSeq + 1;
    const ev: ApiEvent = { id: `ev_${sid.slice(-6)}_${s.epoch}_${seq}`, seq, createdAt: this.ctx.iso(o.at), sessionId: sid, turnId: o.turnId === undefined ? (s.turn?.id ?? null) : o.turnId, type, actor: o.actor ?? null, data };
    s.events.push(ev);
    row.lastSeq = seq;
    row.lastActiveAt = ev.createdAt;
    if (AGENT.has(type)) row.lastAgentSeq = seq;
    if (!QUIET.has(type)) org.touch(row);
    this.ctx.live.publishEvents(sid, eventCursor(s.epoch, seq - 1), eventCursor(s.epoch, seq), [clone(ev)]);
    return ev;
  }

  events(sid: string): ApiEvent[] {
    return clone(this.sessions.get(sid)?.events ?? []);
  }

  /** The events read. Throws `Refusal('reset', …, { cursor, seq })`. */
  read(sid: string, q: { after: string | null; tailTurns: number | null; limit: number }): EventPage {
    const row = this.row(sid);
    const s = this.sess(sid);
    let from = 0;
    let earlierTurns: unknown[] | null = null;
    if (q.after != null) {
      const m = /^e1\.(\d+)\.(\d+)$/.exec(q.after);
      if (!m) throw new Refusal("reset", "the cursor does not parse", { cursor: null });
      const epoch = Number(m[1]);
      from = Number(m[2]);
      const firstKept = eventCursor(s.epoch, s.epochStart - 1);
      if (epoch > s.epoch) throw new Refusal("reset", "an epoch this log never had", { cursor: firstKept, seq: s.epochStart - 1 });
      if (epoch < s.epoch && from >= s.epochStart) throw new Refusal("reset", "the log lost its tail", { cursor: firstKept, seq: s.epochStart - 1 });
      if (from > row.lastSeq) throw new Refusal("reset", "past the log's end", { cursor: eventCursor(s.epoch, row.lastSeq), seq: row.lastSeq });
    } else if (q.tailTurns != null) {
      const starts = s.events.filter((e) => e.type === "message.received");
      const cut = starts.length - q.tailTurns;
      if (cut > 0) {
        from = starts[cut].seq - 1;
        earlierTurns = starts.slice(0, cut).map((e) => ({ id: e.turnId, seq: e.seq, createdAt: e.createdAt }));
      }
    }
    const rest = s.events.filter((e) => e.seq > from);
    const events = rest.slice(0, q.limit);
    const last = events.length ? events[events.length - 1].seq : from;
    return { events: clone(events), lastSeq: row.lastSeq, hasMore: rest.length > events.length, cursor: eventCursor(s.epoch, last), earlierTurns };
  }

  /** Section 40.10. */
  loseTail(sid: string, keepSeq: number): void {
    const { org } = this.ctx;
    const s = this.sess(sid);
    const row = this.row(sid);
    org.tx(() => {
      s.events = s.events.filter((e) => e.seq <= keepSeq);
      s.epoch += 1;
      s.epochStart = keepSeq + 1;
      s.turn = null;
      s.queue = [];
      row.lastSeq = keepSeq;
      row.lastAgentSeq = Math.min(row.lastAgentSeq, keepSeq);
      row.logEpoch = s.epoch;
      row.epochStartSeq = s.epochStart;
      row.activeTurnId = null;
      row.asks = [];
      row.inbox = [];
      row.status = "idle";
      org.touch(row);
      org.sync(sid);
    });
    this.ctx.live.resetEvents(sid, eventCursor(s.epoch, keepSeq), keepSeq);
  }

  // ---------- the inbox

  /** Section 40.2: the entry is in Org's row at once and reaches the host a step later. */
  accept(sid: string, entry: Entry, by: string, actor: Actor): { duplicate: boolean } {
    const { org } = this.ctx;
    const s = this.sess(sid);
    const row = this.row(sid);
    if (s.seen.has(entry.id)) return { duplicate: true };
    s.seen.add(entry.id);
    const inbox: InboxEntry = { id: entry.id, kind: entry.kind, by, at: this.ctx.iso(), text: entry.input ?? null, error: null };
    row.inbox = [...row.inbox, inbox];
    org.touch(row);
    this.ctx.later(() => this.deliver(sid, entry, by, actor), this.ctx.pace);
    return { duplicate: false };
  }

  private unbox(row: SessionRow, id: string): void {
    row.inbox = row.inbox.filter((e) => e.id !== id);
    this.ctx.org.touch(row);
  }

  private deliver(sid: string, entry: Entry, by: string, actor: Actor): void {
    const { org } = this.ctx;
    const row = org.get("session", sid);
    if (!row) return;
    const s = this.sess(sid);
    org.tx(() => {
      if (entry.kind === "turn") {
        if (s.turn && entry.ifBusy === "queue") {
          s.queue.push({ entry, by, actor });
          row.queued = s.queue.map((q) => ({ id: q.entry.id, input: q.entry.input }));
          org.touch(row);
          return;
        }
        if (s.turn) this.cancel(sid, by);
        this.start(sid, entry, by, actor);
        return;
      }
      this.unbox(row, entry.id);
      const ask = row.asks.find((a) => a.id === entry.askId);
      if (!ask || ask.status !== "open") return;
      const answer = entry.answer as { decision?: string } | undefined;
      this.closeAsk(sid, ask, entry.kind === "dismiss" ? "dismissed" : answer?.decision === "deny" ? "declined" : "answered", actor, entry.answer ?? null);
      if (s.turn && !row.asks.some((a) => a.status === "open")) {
        row.status = "running";
        org.touch(row);
      }
      if (this.ctx.auto && s.turn) this.ctx.agents.afterAnswer(sid, s.turn, clone(ask));
    });
  }

  private start(sid: string, entry: Entry, by: string, actor: Actor): void {
    const { org } = this.ctx;
    const s = this.sess(sid);
    const row = this.row(sid);
    const turn: Turn = { id: entry.id, input: entry.input ?? "", by, actor, blocks: new Map() };
    s.turn = turn;
    s.turnCount += 1;
    this.unbox(row, entry.id);
    row.status = "running";
    row.activeTurnId = turn.id;
    if (!row.title) row.title = turn.input.replace(/\s+/g, " ").slice(0, 80);
    this.append(sid, "message.received", { input: turn.input }, { turnId: turn.id, actor });
    if (isPerson(by)) this.ctx.mutations.replied(sid);
    else this.ctx.mutations.active(sid);
    org.sync(sid);
    if (this.ctx.auto) this.ctx.agents.respond(sid, turn, s.turnCount);
  }

  private closeAsk(sid: string, ask: Ask, status: Ask["status"], by: Actor | null, answer: unknown): void {
    ask.status = status;
    ask.closedAt = this.ctx.iso();
    ask.closedBy = by;
    ask.answer = answer;
    this.append(sid, "ask.closed", { ask: clone(ask) }, { turnId: ask.turnId, actor: by });
    const row = this.row(sid);
    row.asks = row.asks.filter((a) => a.id !== ask.id);
    this.ctx.org.sync(sid);
  }

  private finish(sid: string, status: TurnSummary["status"], error: string | null, reason: string | null): void {
    const { org } = this.ctx;
    const s = this.sess(sid);
    const row = this.row(sid);
    const turn = s.turn;
    if (!turn) return;
    for (const a of [...row.asks]) if (a.status === "open") this.closeAsk(sid, a, "interrupted", null, null);
    const err = error ? { code: "agent_error", message: error } : null;
    this.append(sid, status === "completed" ? "turn.completed" : status === "failed" ? "turn.failed" : "turn.cancelled", err ? { error: err } : reason ? { reason } : {}, { turnId: turn.id });
    row.lastTurn = { id: turn.id, status, endedAt: this.ctx.iso(), text: row.lastText, error: err, reason, forced: null };
    row.status = "idle";
    row.activeTurnId = null;
    s.turn = null;
    org.touch(row);
    org.sync(sid);
    org.occur(`turn.${status}`, `${sid}:${s.epoch}:${row.lastSeq}`, { sessionId: sid });
    const next = s.queue.shift();
    if (next) {
      row.queued = s.queue.map((q) => ({ id: q.entry.id, input: q.entry.input }));
      this.start(sid, next.entry, next.by, next.actor);
    }
    this.ctx.agents.poke(sid, status === "failed" ? "blocked" : "turn", `agent:${sid}`);
  }

  private cancel(sid: string, by: string): void {
    this.ctx.org.tx(() => this.finish(sid, "cancelled", null, `interrupted by ${by}`));
  }

  /** Stops the turn in progress, if any. Queued turns then run. */
  interrupt(sid: string, by: string): void {
    if (this.sessions.get(sid)?.turn && this.ctx.org.get("session", sid)) this.cancel(sid, by);
  }

  // ---------- what a session's agent does (FakeAgent)

  /** The turn in progress, or null: a scripted agent stops when its turn is no longer the one. */
  turn(sid: string): Turn | null {
    return this.sessions.get(sid)?.turn ?? null;
  }

  async say(sid: string, text: string, o: { chunk?: number } = {}): Promise<void> {
    const s = this.sess(sid);
    const turn = s.turn;
    if (!turn) return;
    const blockId = `b${++s.blockN}`;
    const size = o.chunk ?? 24;
    for (let at = 0; at < text.length; at += size) {
      if (s.turn !== turn) return;
      const piece = text.slice(at, at + size);
      turn.blocks.set(blockId, text.slice(0, at + size));
      this.ctx.live.publishDelta({ session: sid, type: "message.delta", turnId: turn.id, data: { blockId, text: piece }, offset: at });
      if (this.ctx.pace > 0) await this.ctx.sleep(this.ctx.pace);
    }
    if (s.turn !== turn) return;
    this.ctx.org.tx(() => {
      const row = this.row(sid);
      row.lastText = text;
      this.append(sid, "message.completed", { text, blockId }, { turnId: turn.id });
    });
  }

  /** A line of the log outside a turn's text: the track agent's Activity notes. */
  note(sid: string, type: string, data: unknown): void {
    if (this.ctx.org.get("session", sid)) this.ctx.org.tx(() => void this.append(sid, type, data, { turnId: this.turn(sid)?.id ?? null }));
  }

  tool(sid: string, title: string, o: { toolName?: string; fail?: boolean } = {}): void {
    const s = this.sess(sid);
    if (!s.turn) return;
    const data = { callId: this.ctx.id("call", 8), title, toolName: o.toolName ?? "Bash" };
    this.ctx.org.tx(() => {
      this.append(sid, "tool.started", data);
      this.append(sid, o.fail ? "tool.failed" : "tool.completed", o.fail ? { ...data, error: { message: "exit 1" } } : data);
    });
  }

  ask(sid: string, a: FakeAsk, at?: number): string {
    const { org } = this.ctx;
    const s = this.sess(sid);
    const turn = s.turn;
    if (!turn) return "";
    const row = this.row(sid);
    const ask: Ask = {
      id: this.ctx.id("ask", 12),
      sessionId: sid,
      turnId: turn.id,
      kind: a.kind,
      status: "open",
      createdAt: this.ctx.iso(at),
      closedAt: null,
      closedBy: null,
      answer: null,
      approval:
        a.kind === "approval"
          ? {
              toolName: a.toolName ?? "Bash",
              title: a.title,
              command: a.command ?? null,
              input: a.input ?? (a.command ? { command: a.command } : {}),
              ...(a.alwaysAllows ? { alwaysAllows: a.alwaysAllows } : {}),
            }
          : null,
      question:
        a.kind === "question"
          ? { questions: [{ id: "q1", header: "Question", text: a.question, multiSelect: false, options: a.options.map((label) => ({ label, description: "" })) }] }
          : null,
      secret: a.kind === "secret" ? { name: a.name, purpose: a.purpose ?? null, file: a.file ?? false } : null,
    };
    org.tx(() => {
      row.asks = [...row.asks, ask];
      row.status = "waiting";
      this.append(sid, "ask.opened", { ask: clone(ask) }, { turnId: turn.id, at });
      org.sync(sid);
      org.occur("ask.opened", `${sid}:${s.epoch}:${row.lastSeq}`, { sessionId: sid });
    });
    this.ctx.agents.poke(sid, "blocked", `agent:${sid}`);
    return ask.id;
  }

  endTurn(sid: string, o: { failed?: string } = {}): void {
    if (!this.turn(sid) || !this.ctx.org.get("session", sid)) return;
    this.ctx.org.tx(() => this.finish(sid, o.failed ? "failed" : "completed", o.failed ?? null, null));
  }
}
