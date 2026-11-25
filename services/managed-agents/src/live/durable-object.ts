// LiveDurableObject (tracks and threads, spec sections 18.8, 36.4 and 38): the fan-out actor, one
// per organization (`liveOf`). It owns nothing: who is connected and what they watch is in each
// socket's attachment, so a Live woken from hibernation keeps pushing, and losing one loses no
// fact. Publishers call `publish`; the edge passes socket upgrades, `wait` and `revoke`.

import { DurableObject } from "cloudflare:workers";

import {
  CLOSE_FORBIDDEN,
  CLOSE_PROTOCOL,
  CLOSE_UNAUTHENTICATED,
  CORE_KINDS,
  type ClientFrame,
  type ComputerWatch,
  type DeltaPush,
  EDGE_CREDENTIALS_URL,
  type EventPush,
  type FeedPush,
  LEASE_MS,
  LEASE_RENEW_MS,
  LIVE_PROTOCOL,
  LIVE_SUBPROTOCOL,
  type LiveAttachment,
  type LiveRpc,
  MAX_ATTACHMENT_BYTES,
  MAX_FRAME_BYTES,
  MAX_WAIT_MS,
  MAX_WATCHED_SESSIONS,
  PRINCIPAL_HEADER,
  type Principal,
  type Push,
  REVALIDATE_MS,
  type ServerFrame,
  type SessionLogWatch,
  cursorKind,
  feedStream,
  verifyPrincipal,
} from "./contract.js";

export interface LiveEnv {
  SESSION_LOG: { getByName(name: string): SessionLogWatch };
  COMPUTERS: { getByName(name: string): ComputerWatch };
  /** api-edge, for the credential check. Unbound: credentials end at their expiry only. */
  EDGE?: { fetch(request: Request): Promise<Response> };
  /** Signs the principal on an upgrade and authenticates Live to the edge. */
  LIVE_KEY: string;
}

const EVENTS = 1;
const DELTAS = 2;
const encoder = new TextEncoder();

/** `events:<id>` or `deltas:<id>`. */
function sessionStream(stream: string): { bit: 1 | 2; sessionId: string } | null {
  const at = stream.indexOf(":");
  const sessionId = stream.slice(at + 1);
  if (at < 0 || !sessionId) return null;
  const name = stream.slice(0, at);
  return name === "events" ? { bit: EVENTS, sessionId } : name === "deltas" ? { bit: DELTAS, sessionId } : null;
}

function streamsOf(a: LiveAttachment): string[] {
  const streams = a.f ? [feedStream] : [];
  for (const [sessionId, bits] of Object.entries(a.w)) {
    if (bits & EVENTS) streams.push(`events:${sessionId}`);
    if (bits & DELTAS) streams.push(`deltas:${sessionId}`);
  }
  return streams;
}

/** The principal a lease is taken as: what the attachment kept of the one the edge verified. */
function principalOf(a: LiveAttachment): Principal {
  return {
    org: a.p.org,
    subject: a.p.subject,
    kind: a.p.kind,
    via: a.p.kind === "agent" ? "agent" : "api",
    scopes: a.p.read ? ["sessions:read", "work:read"] : ["sessions:read"],
    audiences: a.p.aud,
    ...(a.p.kind === "agent" ? { session: a.p.subject } : {}),
    admin: false,
    credential: { id: a.p.cred, expiresAt: a.p.exp || null },
  };
}

export class LiveDurableObject extends DurableObject<LiveEnv> implements LiveRpc {
  // All of it rebuilt from attachments or relearned from pushes: a cache, never a fact.
  private readonly sockets = new Map<WebSocket, LiveAttachment>();
  private readonly subscribers = new Map<string, Set<WebSocket>>();
  private readonly heads = new Map<string, string>();
  private readonly machines = new Map<string, string>();
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(ctx: DurableObjectState, env: LiveEnv) {
    super(ctx, env);
    for (const socket of ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as LiveAttachment | null;
      if (attachment) this.index(socket, attachment);
    }
    // A bare ping never wakes a hibernating Live.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  // ---------------------------------------------------------------- the edge

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("Expected a WebSocket upgrade.", { status: 426 });
    const principal = await verifyPrincipal(this.env.LIVE_KEY, request.headers.get(PRINCIPAL_HEADER));
    if (!principal) return new Response("Unauthenticated.", { status: 401 });
    if (this.ctx.id.name && this.ctx.id.name !== principal.org) return new Response("Forbidden.", { status: 403 });
    const offered = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((s) => s.trim());
    if (!offered.includes(LIVE_SUBPROTOCOL)) return new Response(`Expected the ${LIVE_SUBPROTOCOL} subprotocol.`, { status: 400 });

    const attachment: LiveAttachment = {
      c: `cn_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
      p: {
        org: principal.org,
        subject: principal.subject,
        kind: principal.kind,
        read: principal.scopes.includes("work:read"),
        aud: principal.audiences,
        cred: principal.credential.id,
        exp: principal.credential.expiresAt ?? 0,
      },
      cl: "",
      f: false,
      w: {},
      v: Math.floor(Date.now() / 1000),
    };
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    if (!this.save(server, attachment)) {
      server.close(CLOSE_PROTOCOL, "The principal does not fit a connection.");
      return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": LIVE_SUBPROTOCOL } });
    }
    await this.arm();
    return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": LIVE_SUBPROTOCOL } });
  }

  async wait(p: Principal, stream: string, after: string, timeoutMs: number): Promise<{ moved: boolean; head: string | null }> {
    const timeout = Math.max(0, Math.min(timeoutMs, MAX_WAIT_MS));
    const watched = sessionStream(stream);
    if (watched?.bit === EVENTS) {
      // The same lease a subscription takes, or SessionLog would not be publishing (section 37.1).
      const before = this.heads.get(stream);
      const lease = await this.env.SESSION_LOG.getByName(watched.sessionId).watch(p, Date.now() + Math.max(LEASE_MS, timeout + 5_000));
      if (!lease) return { moved: false, head: null };
      if (this.heads.get(stream) === before) this.heads.set(stream, lease.head);
    }
    const head = this.heads.get(stream) ?? null;
    if (head !== null && head !== after) return { moved: true, head };
    if (timeout === 0) return { moved: false, head };
    return new Promise((resolve) => {
      const waiters = this.waiters.get(stream) ?? new Set();
      this.waiters.set(stream, waiters);
      const moved = (): void => {
        clearTimeout(timer);
        resolve({ moved: true, head: this.heads.get(stream) ?? null });
      };
      const timer = setTimeout(() => {
        waiters.delete(moved);
        resolve({ moved: false, head: this.heads.get(stream) ?? null });
      }, timeout);
      waiters.add(moved);
    });
  }

  async revoke(credentialId: string): Promise<void> {
    for (const [socket, a] of [...this.sockets]) {
      if (a.p.cred === credentialId) this.close(socket, CLOSE_UNAUTHENTICATED, "The credential was revoked.");
    }
  }

  // ---------------------------------------------------------------- publishers

  async publish(stream: string, frame: Push): Promise<{ head: string }> {
    if ("head" in frame) {
      this.moved(stream, frame.head);
      this.fanOut(stream, () => ({ t: "behind", stream, head: frame.head }));
      return { head: frame.head };
    }
    if (stream === feedStream) return this.publishFeed(frame as FeedPush);
    const watched = sessionStream(stream);
    if (!watched) return { head: this.heads.get(stream) ?? "" };
    if (watched.bit === DELTAS) {
      for (const delta of (frame as DeltaPush).deltas) {
        this.fanOut(stream, () => ({
          t: "delta",
          session: watched.sessionId,
          type: delta.type,
          turnId: delta.turnId,
          data: delta.data,
          offset: delta.offset,
          ...(delta.whole ? { whole: true } : {}),
        }));
      }
      return { head: "" };
    }
    const push = frame as EventPush;
    this.moved(stream, push.to);
    const text = JSON.stringify({ t: "events", session: watched.sessionId, from: push.from, to: push.to, events: push.events } satisfies ServerFrame);
    // Too large for a frame: the readers are told the head and read over HTTP.
    const sent = encoder.encode(text).length <= MAX_FRAME_BYTES ? text : JSON.stringify({ t: "behind", stream, head: push.to } satisfies ServerFrame);
    for (const socket of this.subscribers.get(stream) ?? []) this.sendText(socket, sent);
    return { head: push.to };
  }

  private publishFeed(push: FeedPush): { head: string } {
    this.moved(feedStream, push.to);
    for (const socket of this.subscribers.get(feedStream) ?? []) {
      const a = this.sockets.get(socket);
      if (!a) continue;
      const sees = (row: { kind: string; audience: string }): boolean => a.p.aud.includes(row.audience) && (!a.k || a.k.includes(row.kind));
      const mine = a.cl ? (push.mutations ?? []).filter((m) => m.clientId === a.cl) : [];
      // Every range goes to every subscriber, with no rows when none is theirs, so a filtered
      // reader can still tell a gap from nothing (section 18.4).
      const frame: ServerFrame = {
        t: "feed",
        from: push.from,
        to: push.to,
        rows: push.rows.filter(sees),
        gone: push.gone.filter(sees).map(({ kind, id }) => ({ kind, id })),
        ...(mine.length > 0
          ? { lastMutation: Math.max(...mine.map((m) => m.n)), errors: mine.flatMap((m) => m.errors ?? []) }
          : {}),
      };
      const text = JSON.stringify(frame);
      this.sendText(socket, encoder.encode(text).length <= MAX_FRAME_BYTES ? text : JSON.stringify({ t: "behind", stream: feedStream, head: push.to } satisfies ServerFrame));
    }
    return { head: push.to };
  }

  /** Records a stream's head and releases the long-polls waiting on it. */
  private moved(stream: string, head: string): void {
    this.heads.set(stream, head);
    const waiters = this.waiters.get(stream);
    if (!waiters) return;
    this.waiters.delete(stream);
    for (const wake of waiters) wake();
  }

  // ---------------------------------------------------------------- sockets

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > MAX_FRAME_BYTES) return this.close(socket, CLOSE_PROTOCOL, "Frames are JSON text of at most 64 kB.");
    let frame: ClientFrame;
    try {
      frame = JSON.parse(message) as ClientFrame;
    } catch {
      return this.close(socket, CLOSE_PROTOCOL, "Frames are JSON text.");
    }
    const a = this.attachment(socket);
    if (!a || !frame || typeof frame !== "object") return this.close(socket, CLOSE_PROTOCOL, "Not a frame.");
    if (frame.t === "ping") return this.send(socket, { t: "pong" });
    if (frame.t === "hello") {
      if (frame.protocol !== LIVE_PROTOCOL || typeof frame.clientId !== "string" || !frame.clientId) {
        return this.close(socket, CLOSE_PROTOCOL, `This is protocol ${LIVE_PROTOCOL}.`);
      }
      if (!this.save(socket, { ...a, cl: frame.clientId })) return this.close(socket, CLOSE_PROTOCOL, "The client id is too long.");
      return this.send(socket, {
        t: "ready",
        connectionId: a.c,
        protocol: LIVE_PROTOCOL,
        org: a.p.org,
        subject: a.p.subject,
        expiresAt: a.p.exp ? new Date(a.p.exp).toISOString() : null,
        limits: { sessions: MAX_WATCHED_SESSIONS, frameBytes: MAX_FRAME_BYTES },
      });
    }
    if (!a.cl) return this.close(socket, CLOSE_PROTOCOL, "The first frame is hello.");
    switch (frame.t) {
      case "sub":
        return this.subscribe(socket, a, frame);
      case "unsub":
        return this.unsubscribe(socket, frame.stream);
      case "block": {
        if (typeof frame.session !== "string" || typeof frame.blockId !== "string" || !((a.w[frame.session] ?? 0) & DELTAS)) return;
        this.ctx.waitUntil(this.computer(a.p.org, frame.session).block(frame.session, frame.blockId).catch(() => undefined));
        return;
      }
      case "auth":
        return this.renew(socket, frame.token);
      default:
        return this.send(socket, { t: "error", code: "unknown_frame", message: "Unknown frame." });
    }
  }

  override async webSocketClose(socket: WebSocket): Promise<void> {
    this.forget(socket);
  }

  override async webSocketError(socket: WebSocket): Promise<void> {
    this.forget(socket);
  }

  private async subscribe(socket: WebSocket, a: LiveAttachment, frame: Extract<ClientFrame, { t: "sub" }>): Promise<void> {
    const stream = frame.stream;
    const watched = typeof stream === "string" ? sessionStream(stream) : null;
    if (stream !== feedStream && !watched) return this.send(socket, { t: "error", code: "unknown_stream", message: "Unknown stream." });
    if (frame.after !== undefined && (!watched || watched.bit === EVENTS)) {
      // A cursor that cannot be read, or of another stream: its position does not exist.
      if (cursorKind(frame.after) !== (watched ? "e" : "f")) return this.send(socket, { t: "reset", stream, cursor: null });
    }

    if (!watched) {
      const asked = Array.isArray(frame.kinds) ? frame.kinds.filter((k) => typeof k === "string") : null;
      const kinds = a.p.read ? asked : (asked ?? CORE_KINDS).filter((k) => CORE_KINDS.includes(k));
      const next: LiveAttachment = { ...a, f: true };
      if (kinds) next.k = kinds;
      else delete next.k;
      if (!this.save(socket, next)) return this.send(socket, { t: "error", code: "too_many_subscriptions", message: "Too many subscriptions." });
      return this.send(socket, { t: "subd", stream, head: this.heads.get(feedStream) ?? null });
    }

    const { bit, sessionId } = watched;
    const held = a.w[sessionId] ?? 0;
    const fits = held !== 0 || Object.keys(a.w).length < MAX_WATCHED_SESSIONS;
    // Subscribe, then read (section 18.2): registered before the lease is asked for, so nothing
    // published meanwhile falls between them.
    if (!fits || !this.save(socket, { ...a, w: { ...a.w, [sessionId]: (held | bit) as 1 | 2 | 3 } })) {
      return this.send(socket, { t: "error", code: "too_many_subscriptions", message: `A connection watches at most ${MAX_WATCHED_SESSIONS} sessions.` });
    }
    const until = Date.now() + LEASE_MS;
    const before = this.heads.get(`events:${sessionId}`);
    let lease: { head: string; machine?: string } | null;
    try {
      lease = await this.env.SESSION_LOG.getByName(sessionId).watch(principalOf(a), until);
    } catch {
      this.drop(socket, sessionId, bit);
      return this.send(socket, { t: "detached", stream, reason: "unavailable" });
    }
    if (!lease) {
      this.drop(socket, sessionId, bit);
      return this.send(socket, { t: "detached", stream, reason: "forbidden" });
    }
    if (lease.machine) this.machines.set(sessionId, lease.machine);
    if (this.heads.get(`events:${sessionId}`) === before) this.heads.set(`events:${sessionId}`, lease.head);
    if (bit === DELTAS) this.ctx.waitUntil(this.computer(a.p.org, sessionId).watch(sessionId, until).catch(() => undefined));
    this.send(socket, { t: "subd", stream, head: this.heads.get(`events:${sessionId}`) ?? lease.head });
    await this.arm();
  }

  private unsubscribe(socket: WebSocket, stream: string): void {
    const a = this.attachment(socket);
    if (!a) return;
    if (stream === feedStream) {
      const next: LiveAttachment = { ...a, f: false };
      delete next.k;
      this.save(socket, next);
      return;
    }
    const watched = typeof stream === "string" ? sessionStream(stream) : null;
    if (watched) this.drop(socket, watched.sessionId, watched.bit);
  }

  /** Removes one stream of a session from a socket's attachment, as it is now. */
  private drop(socket: WebSocket, sessionId: string, bit: 1 | 2): void {
    const a = this.attachment(socket);
    if (!a || !a.w[sessionId]) return;
    const w = { ...a.w };
    const left = w[sessionId]! & ~bit;
    if (left) w[sessionId] = left as 1 | 2;
    else delete w[sessionId];
    this.save(socket, { ...a, w });
  }

  /** An `auth` frame: renews the credential, never widens it (section 18.7). */
  private async renew(socket: WebSocket, token: string): Promise<void> {
    const principal = typeof token === "string" ? await this.edge<{ principal: Principal | null }>({ token }) : null;
    if (principal === null) return this.send(socket, { t: "error", code: "unavailable", message: "The credential could not be checked." });
    const a = this.attachment(socket);
    if (!a) return;
    const p = principal.principal;
    if (!p) return this.close(socket, CLOSE_UNAUTHENTICATED, "The credential does not verify.");
    if (p.org !== a.p.org || p.subject !== a.p.subject) return this.close(socket, CLOSE_FORBIDDEN, "A connection keeps its principal.");
    this.save(socket, { ...a, p: { ...a.p, cred: p.credential.id, exp: p.credential.expiresAt ?? 0 }, v: Math.floor(Date.now() / 1000) });
    await this.arm();
  }

  // ---------------------------------------------------------------- the alarm: leases, expiry, revalidation

  override async alarm(): Promise<void> {
    const now = Date.now();
    for (const [socket, a] of [...this.sockets]) {
      if (a.p.exp && a.p.exp <= now) this.close(socket, CLOSE_UNAUTHENTICATED, "The credential expired.");
    }
    await Promise.all([this.renewLeases(now), this.revalidate(now)]);
    await this.arm();
  }

  /** Each subscriber's lease is renewed as that subscriber, so one who lost the right to a session stops receiving it. */
  private async renewLeases(now: number): Promise<void> {
    const until = now + LEASE_MS;
    const deltas = new Map<string, string>();
    const renewals: Promise<void>[] = [];
    for (const [socket, a] of [...this.sockets]) {
      for (const [sessionId, bits] of Object.entries(a.w)) {
        if (bits & DELTAS) deltas.set(sessionId, a.p.org);
        renewals.push(
          this.env.SESSION_LOG.getByName(sessionId)
            .watch(principalOf(a), until)
            .then((lease) => {
              if (lease) return;
              for (const bit of [EVENTS, DELTAS] as const) {
                if (!(bits & bit)) continue;
                this.drop(socket, sessionId, bit);
                this.send(socket, { t: "detached", stream: `${bit === EVENTS ? "events" : "deltas"}:${sessionId}`, reason: "forbidden" });
              }
            })
            // An owner that cannot be reached: the lease lapses and the next renewal takes it again.
            .catch(() => undefined),
        );
      }
    }
    for (const [sessionId, org] of deltas) renewals.push(this.computer(org, sessionId).watch(sessionId, until).catch(() => undefined));
    await Promise.all(renewals);
  }

  private async revalidate(now: number): Promise<void> {
    const due = new Set<string>();
    for (const a of this.sockets.values()) {
      if (a.v * 1000 + REVALIDATE_MS <= now) due.add(a.p.cred);
    }
    if (due.size === 0) return;
    const answer = await this.edge<{ revoked: string[] }>({ check: [...due] });
    if (!answer) return;
    const seconds = Math.floor(now / 1000);
    for (const [socket, a] of [...this.sockets]) {
      if (!due.has(a.p.cred)) continue;
      if (answer.revoked.includes(a.p.cred)) this.close(socket, CLOSE_UNAUTHENTICATED, "The credential was revoked.");
      else this.save(socket, { ...a, v: seconds });
    }
  }

  /** One alarm for the nearest of: a lease renewal, a credential's expiry, the next revalidation. */
  private async arm(): Promise<void> {
    if (this.sockets.size === 0) return this.ctx.storage.deleteAlarm();
    const now = Date.now();
    let next = Infinity;
    for (const a of this.sockets.values()) {
      if (Object.keys(a.w).length > 0) next = Math.min(next, now + LEASE_RENEW_MS);
      if (a.p.exp) next = Math.min(next, a.p.exp);
      if (this.env.EDGE) next = Math.min(next, a.v * 1000 + REVALIDATE_MS);
    }
    if (next === Infinity) return this.ctx.storage.deleteAlarm();
    const armed = await this.ctx.storage.getAlarm();
    if (armed === null || armed > next || armed < now) await this.ctx.storage.setAlarm(Math.max(next, now + 1_000));
  }

  // ---------------------------------------------------------------- mechanics

  private computer(org: string, sessionId: string): ComputerWatch {
    // The organization's first machine is named by the organization's id (section 34.1).
    return this.env.COMPUTERS.getByName(this.machines.get(sessionId) ?? org);
  }

  /** The edge's credential check; null when it cannot be asked. */
  private async edge<T>(body: unknown): Promise<T | null> {
    if (!this.env.EDGE) return null;
    try {
      const response = await this.env.EDGE.fetch(
        new Request(EDGE_CREDENTIALS_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${this.env.LIVE_KEY}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      return response.ok ? ((await response.json()) as T) : null;
    } catch {
      return null;
    }
  }

  private attachment(socket: WebSocket): LiveAttachment | null {
    return this.sockets.get(socket) ?? null;
  }

  /** Writes a socket's attachment and re-indexes it; false when it would pass the attachment's limit. */
  private save(socket: WebSocket, next: LiveAttachment): boolean {
    // JSON is no shorter than the runtime's own serialization of the same value, so this errs low.
    if (encoder.encode(JSON.stringify(next)).length >= MAX_ATTACHMENT_BYTES) return false;
    try {
      socket.serializeAttachment(next);
    } catch {
      return false;
    }
    this.forget(socket);
    this.index(socket, next);
    return true;
  }

  private index(socket: WebSocket, a: LiveAttachment): void {
    this.sockets.set(socket, a);
    for (const stream of streamsOf(a)) {
      const set = this.subscribers.get(stream) ?? new Set();
      this.subscribers.set(stream, set);
      set.add(socket);
    }
  }

  private forget(socket: WebSocket): void {
    const a = this.sockets.get(socket);
    if (!a) return;
    this.sockets.delete(socket);
    for (const stream of streamsOf(a)) {
      const set = this.subscribers.get(stream);
      set?.delete(socket);
      if (set?.size === 0) this.subscribers.delete(stream);
    }
  }

  private fanOut(stream: string, frame: () => ServerFrame): void {
    const sockets = this.subscribers.get(stream);
    if (!sockets || sockets.size === 0) return;
    const text = JSON.stringify(frame());
    for (const socket of sockets) this.sendText(socket, text);
  }

  private send(socket: WebSocket, frame: ServerFrame): void {
    this.sendText(socket, JSON.stringify(frame));
  }

  private sendText(socket: WebSocket, text: string): void {
    try {
      socket.send(text);
    } catch {
      // A socket that cannot take a frame is gone; its reader resumes from its cursor.
      this.forget(socket);
    }
  }

  private close(socket: WebSocket, code: number, reason: string): void {
    this.forget(socket);
    try {
      socket.close(code, reason);
    } catch {
      // Already closed.
    }
  }
}
