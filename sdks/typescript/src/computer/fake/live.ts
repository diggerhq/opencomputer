// Live: the sockets of section 38. Every frame, in either direction, is delivered from a timer,
// never inside `send`, `fetch` or the call that published it.

import type { ApiEvent, Channel, ClientFrame, Delta, ServerFrame } from "../types.js";
import type { Chaos } from "./api.js";
import { clone, mulberry, Refusal, type Ctx } from "./ctx.js";
import { feedCursor, parseFeedCursor, type Published } from "./org.js";

const MAX_WATCHED = 32;
/** Send order within a socket: feed (and the answers to the client's own frames), events, deltas. */
const RANK: Record<string, number> = { events: 1, delta: 2 };

class Sock implements Channel {
  state: "connecting" | "open" | "closed" = "connecting";
  feed: { kinds: Set<string> | null } | null = null;
  events = new Set<string>();
  deltas = new Set<string>();
  inbox: ClientFrame[] = [];
  out: ServerFrame[] = [];
  /** A pushed frame chaos holds until the next one. */
  held: ServerFrame | null = null;
  scheduled = false;
  private frameCbs: ((f: ServerFrame) => void)[] = [];
  private stateCbs: ((s: "open" | "closed") => void)[] = [];

  constructor(private live: Live) {}

  send(frame: ClientFrame): void {
    if (this.state === "closed") return;
    this.inbox.push(clone(frame));
    this.live.schedule(this);
  }
  onFrame(cb: (frame: ServerFrame) => void): void {
    this.frameCbs.push(cb);
  }
  onState(cb: (state: "open" | "closed") => void): void {
    this.stateCbs.push(cb);
  }
  close(): void {
    this.live.close(this);
  }
  emit(frame: ServerFrame): void {
    for (const cb of this.frameCbs) cb(clone(frame));
  }
  emitState(state: "open" | "closed"): void {
    for (const cb of this.stateCbs) cb(state);
  }
}

export class Live {
  offline = false;
  private socks = new Set<Sock>();
  private chaos: Chaos = {};
  private draw: () => number = mulberry(1);
  private n = 0;

  constructor(private ctx: Ctx) {}

  setChaos(c: Chaos): void {
    this.chaos = c;
    this.draw = mulberry(c.seed ?? 1);
  }

  /** The generator the chaos probabilities draw from; HTTP failures use it too. */
  chance(p: number | undefined): boolean {
    const x = this.draw();
    return !!p && x < p;
  }

  connect(): Channel {
    const s = new Sock(this);
    if (this.offline) {
      s.state = "closed";
      this.ctx.later(() => s.emitState("closed"), 0);
      return s;
    }
    this.socks.add(s);
    this.ctx.later(() => {
      if (s.state !== "connecting") return;
      s.state = "open";
      s.emitState("open");
      this.schedule(s);
    }, 0);
    return s;
  }

  close(s: Sock): void {
    if (s.state === "closed") return;
    s.state = "closed";
    this.socks.delete(s);
    this.ctx.later(() => s.emitState("closed"), 0);
  }

  dropAll(): void {
    for (const s of [...this.socks]) this.close(s);
  }

  schedule(s: Sock): void {
    if (s.scheduled || s.state === "closed") return;
    s.scheduled = true;
    this.ctx.later(() => {
      s.scheduled = false;
      this.flush(s);
    }, 0);
  }

  private flush(s: Sock): void {
    if (s.state !== "open") return;
    const inbox = s.inbox;
    s.inbox = [];
    for (const f of inbox) this.handle(s, f);
    const out = s.out;
    s.out = [];
    const rank = (f: ServerFrame) => RANK[f.t] ?? 0;
    out
      .map((f, i) => ({ f, i }))
      .sort((a, b) => rank(a.f) - rank(b.f) || a.i - b.i)
      .forEach(({ f }) => this.deliver(s, f));
  }

  private deliver(s: Sock, f: ServerFrame): void {
    if (s.state !== "open") return;
    const pushed = f.t === "feed" || f.t === "events" || f.t === "delta";
    if (!pushed) return s.emit(f);
    // Three draws a pushed frame, whatever the probabilities, so a seed gives one run.
    const drop = this.chance(this.chaos.drop);
    const twice = this.chance(this.chaos.duplicate);
    const hold = this.chance(this.chaos.reorder);
    if (drop) return;
    if (hold && !s.held) {
      s.held = f;
      return;
    }
    s.emit(f);
    if (twice) s.emit(f);
    if (s.held) {
      const h = s.held;
      s.held = null;
      s.emit(h);
    }
  }

  private push(s: Sock, f: ServerFrame): void {
    if (s.state === "closed") return;
    s.out.push(f);
    this.schedule(s);
  }

  private handle(s: Sock, f: ClientFrame): void {
    const { org, log, principal } = this.ctx;
    switch (f.t) {
      case "hello":
        return this.push(s, { t: "ready", connectionId: `conn_${++this.n}`, protocol: 1, org: principal.org, subject: principal.subject, expiresAt: this.ctx.iso(this.ctx.now() + 3_600_000), limits: { sessions: MAX_WATCHED } });
      case "ping":
        return this.push(s, { t: "pong" });
      case "auth":
        return;
      case "unsub":
        if (f.stream === "feed") s.feed = null;
        else if (f.stream.startsWith("events:")) s.events.delete(f.stream.slice(7));
        else if (f.stream.startsWith("deltas:")) s.deltas.delete(f.stream.slice(7));
        return;
      case "block": {
        const text = log.turn(f.session)?.blocks.get(f.blockId);
        const turn = log.turn(f.session);
        if (text != null && turn) this.publishDelta({ session: f.session, type: "message.delta", turnId: turn.id, data: { blockId: f.blockId, text }, offset: 0, whole: true });
        return;
      }
      case "sub": {
        if (f.stream === "feed") {
          // As Live (38.4): an `after` it cannot read is answered `reset`, and nothing is subscribed.
          if (f.after !== undefined) {
            const v = typeof f.after === "string" ? parseFeedCursor(f.after) : null;
            if (v == null || v < org.floor || v > org.version) return this.push(s, { t: "reset", stream: "feed", cursor: null });
          }
          s.feed = { kinds: f.kinds ? new Set(f.kinds) : null };
          return this.push(s, { t: "subd", stream: "feed", head: feedCursor(org.version) });
        }
        const [kind, sid] = [f.stream.slice(0, 6), f.stream.slice(7)];
        if ((kind !== "events" && kind !== "deltas") || f.stream[6] !== ":") return this.push(s, { t: "error", code: "invalid_request", message: `no stream ${f.stream}` });
        const watched = new Set([...s.events, ...s.deltas]);
        if (!watched.has(sid) && watched.size >= MAX_WATCHED) return this.push(s, { t: "error", code: "too_many_subscriptions", message: `at most ${MAX_WATCHED} sessions` });
        if (!org.get("session", sid)) return this.push(s, { t: "detached", stream: f.stream, reason: "gone" });
        if (kind === "deltas") {
          s.deltas.add(sid);
          return this.push(s, { t: "subd", stream: f.stream, head: null });
        }
        if (f.after !== undefined) {
          if (typeof f.after !== "string") return this.push(s, { t: "reset", stream: f.stream, cursor: null });
          try {
            log.read(sid, { after: f.after, tailTurns: null, limit: 0 });
          } catch (e) {
            if (!(e instanceof Refusal)) throw e;
            const d = e.detail as { cursor: string | null; seq?: number };
            return this.push(s, { t: "reset", stream: f.stream, cursor: d.cursor, ...(d.seq == null ? {} : { seq: d.seq }) });
          }
        }
        s.events.add(sid);
        return this.push(s, { t: "subd", stream: f.stream, head: log.head(sid) });
      }
    }
  }

  // ---------- publishing (section 38.4)

  publishFeed(p: Published): void {
    const { org } = this.ctx;
    for (const s of this.socks) {
      if (!s.feed) continue;
      const kinds = s.feed.kinds;
      this.push(s, {
        t: "feed",
        from: feedCursor(p.from),
        to: feedCursor(p.to),
        rows: clone(p.rows.filter((r) => (!kinds || kinds.has(r.kind)) && org.visible(org.audience(r)))),
        gone: p.gone.filter((g) => (!kinds || kinds.has(g.kind)) && org.visible(g.audience)).map((g) => ({ kind: g.kind, id: g.id })),
        version: p.to,
      });
    }
  }

  publishEvents(sid: string, from: string, to: string, events: ApiEvent[]): void {
    for (const s of this.socks) if (s.events.has(sid)) this.push(s, { t: "events", session: sid, from, to, events });
  }

  publishDelta(d: Delta): void {
    for (const s of this.socks) if (s.deltas.has(d.session)) this.push(s, { t: "delta", ...d });
  }

  resetEvents(sid: string, cursor: string, seq: number): void {
    for (const s of this.socks) if (s.events.has(sid)) this.push(s, { t: "reset", stream: `events:${sid}`, cursor, seq });
  }

  /** The session is gone. */
  detach(sid: string): void {
    for (const s of this.socks) {
      if (s.events.delete(sid)) this.push(s, { t: "detached", stream: `events:${sid}`, reason: "gone" });
      if (s.deltas.delete(sid)) this.push(s, { t: "detached", stream: `deltas:${sid}`, reason: "gone" });
    }
  }
}
