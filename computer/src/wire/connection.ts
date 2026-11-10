// One client WebSocket (opc docs websocket/connect.mdx and methods.mdx): the
// `ready` greeting, JSON-RPC dispatch, scopes and access, the attached
// sessions, terminals, keepalive and the connection's own close codes.
//
// Invariants:
// - `ready` is the first frame; attaches named in the URL follow it as
//   `sessions.attached`, each before that session's events.
// - Every method is checked in this order: known, params, scope, the ticket's
//   sessions, the session's access list (an unknown id waits up to 2 s for its
//   create), read-only, then run. A refusal never reaches a writer.
// - A write's response is queued before any event of its session that arrived
//   while it was in flight (the outbox holds the session).
// - The connection closes with 1001 after two missed pings, 4001 when its
//   credential's `until` passes or its key is revoked, 4008 when more than
//   16 MiB wait to be sent; closing hangs up its terminals and links.
// - Telemetry (catalog v2): one event per unit (attach, write batch, detach,
//   error response, opc telemetry frame), sent as it happens; never per frame
//   or per event. Error events are capped per connection (a flood of refused
//   requests is not a flood of events). opc's `telemetry` notification is
//   checked against api/cli-telemetry.ts, rate limited, never answered; a
//   frame refused for its size or rate is only counted into the connection's
//   `wire.flush` (084 perf fix 3), so a flood of them writes no events.

import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { SessionAccess } from '../protocol.js';
import { checkCliFrame, CLI_LIMITS } from '../api/cli-telemetry.js';
import { decodeParams, isMethod, type Method, WRITES } from '../api/schema.js';
import type { CallOutcome } from '../api/writer.js';
import { isSessionId, mintId } from '../session-ids.js';
import type { WireClaims } from '../signed-header.js';
import { Attachment, type AttachRequest, type EpochMoved, type WireDetachReason, WriterLinks } from './attachment.js';
import { actorFor, hasScope, inTicket, mayAttach, scopeFor } from './edge-auth.js';
import type { HostLink } from './host-link.js';
import { LIMITS, TokenBucket } from './limits.js';
import { Outbox } from './outbox.js';
import { encodeError, encodeNotification, encodeResult, encodeRpcError, errors, parseFrame, type RpcId } from './rpc.js';
import { FlushWindow, type WireEmit } from './telemetry.js';
import { type OpenParams, WireTerminals } from './terminal.js';
import type { DialWriter } from './writer-client.js';

export interface ConnectionDeps {
  host: HostLink;
  dial: DialWriter;
  version: string;
  region: string | null;
  routeTerminal(terminalId: string, to: WireTerminals | undefined): void;
  closed(c: Connection): void;
  /** Telemetry: one `wire.*` event per unit (wire/telemetry.ts); absent, nothing is measured. */
  emit?: WireEmit;
  /** Forward one checked opc event to the host (`cli.*`). */
  forward?(name: string, fields: Record<string, number | string | boolean>): void;
  pingMs?: number;
}

/** The connection's own totals, for `wire.close`. */
export interface ConnectionStats {
  attaches: number;
  frames_in: number;
  bytes_in: number;
  frames_out: number;
  bytes_out: number;
  duration_ms: number;
}

export interface UrlAttach extends AttachRequest {
  sessionId: string;
}

const TIMED: ReadonlySet<string> = new Set(['turns.send', 'sessions.compact', 'ping']);
const us = (t0: bigint) => Number((process.hrtime.bigint() - t0) / 1000n);
const requestId = () => `req_${randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '0')}`;

export class Connection {
  readonly id = mintId('wc');
  readonly member: string;
  readonly keyId: string;
  readonly outbox: Outbox;
  private attached = new Map<string, Attachment>();
  private links: WriterLinks;
  private terminals: WireTerminals;
  private bucket = new TokenBucket(LIMITS.maxRequestsPerSecond, LIMITS.requestBurst);
  private actor;
  private missed = 0;
  private timers: NodeJS.Timeout[] = [];
  private done = false;
  private readonly openedAt = Date.now();
  private stats = { attaches: 0, frames_in: 0, bytes_in: 0, frames_out: 0, bytes_out: 0 };
  private window: FlushWindow | undefined;
  /** Error events: at most 5 a second (burst 20) per connection. */
  private errorEvents = new TokenBucket(5, 20);
  private cliFrames = new TokenBucket(CLI_LIMITS.framesPerMinute / 60, CLI_LIMITS.burst);

  constructor(
    private ws: WebSocket,
    private claims: WireClaims,
    private deps: ConnectionDeps,
  ) {
    this.member = claims.member;
    this.keyId = claims.keyId;
    this.actor = actorFor(claims);
    this.links = new WriterLinks(deps.host, deps.dial);
    const emit = deps.emit;
    const w = (this.window = emit && new FlushWindow((f) => emit('wire.flush', { ...f, connection_id: this.id, person_id: this.member }), () => this.outbox.unsent));
    this.outbox = new Outbox(
      {
        send: (data, done) => {
          if (ws.readyState !== ws.OPEN) return done();
          this.stats.frames_out++;
          this.stats.bytes_out += data.length;
          w?.frame(data.length);
          ws.send(data, { binary: typeof data !== 'string' }, () => done());
        },
        onPause: (sid) => this.attached.get(sid)?.pause(),
        onResume: (sid) => this.attached.get(sid)?.resume(),
        onOverflow: () => this.close(4008, 'more than 16 MiB waited to be sent'),
        handed: w && ((_sid, waited, createdMs, delta) => (delta ? w.delta(waited) : w.event(createdMs, waited))),
      },
      { meter: w },
    );
    this.terminals = new WireTerminals({ host: deps.host, outbox: this.outbox, member: this.member, route: deps.routeTerminal, emit, connectionId: this.id });
  }

  /** Greet, attach what the URL names, and start reading. */
  start(urlAttaches: UrlAttach[]) {
    const { ws } = this;
    const until = this.claims.scope.until;
    const now = Date.now();
    this.outbox.urgent(
      encodeNotification('ready', {
        connectionId: this.id,
        server: { version: this.deps.version, region: this.deps.region },
        protocol: { features: [] },
        limits: { maxAttached: LIMITS.maxAttached, maxMessageBytes: LIMITS.maxMessageBytes, maxRequestsPerSecond: LIMITS.maxRequestsPerSecond },
        expiresAt: until === undefined ? null : new Date(until).toISOString(),
        expiresInMs: until === undefined ? null : Math.max(0, until - now),
      }),
    );
    if (until !== undefined) this.timer(Math.max(0, until - now), () => this.close(4001, 'credential expired'));
    const pingMs = this.deps.pingMs ?? LIMITS.pingMs;
    // Each tick counts the ping sent at the previous one as missed until a pong (or any frame) clears it:
    // the third tick without one closes, after two pings went unanswered (review r1 contract E7 was wrong: `>= 2` closes after one).
    const ping = setInterval(() => {
      if (++this.missed > 2) return this.close(1001, 'missed two pings');
      ws.ping();
    }, pingMs);
    ping.unref?.();
    this.timers.push(ping);
    ws.on('pong', () => {
      this.missed = 0;
    });
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      this.missed = 0;
      this.stats.frames_in++;
      this.stats.bytes_in += data.length;
      if (isBinary) return this.terminals.input(data);
      void this.onText(data.toString('utf8'));
    });
    ws.on('close', () => this.teardown());
    ws.on('error', () => this.teardown());
    for (const a of urlAttaches.slice(0, LIMITS.maxAttached)) void this.urlAttach(a);
    for (const a of urlAttaches.slice(LIMITS.maxAttached)) this.outbox.urgent(attachedError(a.sessionId, errors.tooManyAttached()));
  }

  close(code: number, reason: string) {
    if (this.done) return;
    this.ws.close(code, reason);
    const t = setTimeout(() => this.ws.terminate(), 1000);
    t.unref?.();
    this.teardown();
  }

  /** The host pushed a new access list: drop attachments the member may no longer see. */
  accessChanged(access: SessionAccess) {
    const a = this.attached.get(access.sessionId);
    if (a && !mayAttach(access, this.member)) this.detach(access.sessionId, 'access_lost');
  }

  /** After a host `welcome`: every attached session is checked against the new lists (absent: lost). */
  recheckAccess(get: (sessionId: string) => SessionAccess | undefined) {
    for (const sid of [...this.attached.keys()]) {
      const access = get(sid);
      if (!access || !mayAttach(access, this.member)) this.detach(sid, 'access_lost');
    }
  }

  revoked(keyId: string) {
    if (keyId === this.keyId) this.close(4001, 'credential revoked');
  }

  moved(sessionId: string) {
    this.links.forget(sessionId);
    void this.attached.get(sessionId)?.moved();
  }

  get attachedCount() {
    return this.attached.size;
  }

  /** The connection's totals so far (`wire.close`). */
  totals(): ConnectionStats {
    return { ...this.stats, duration_ms: Date.now() - this.openedAt };
  }

  private emitError(method: string, code: string) {
    if (!this.deps.emit || this.errorEvents.take() > 0) return;
    this.deps.emit('wire.error', { connection_id: this.id, person_id: this.member, method: isMethod(method) ? method : undefined, code });
  }

  private async urlAttach(a: UrlAttach) {
    const t0 = process.hrtime.bigint();
    if (!isSessionId(a.sessionId)) return this.outbox.urgent(attachedError(a.sessionId, errors.invalidParams('attach', 'not a session id')));
    const access = await this.access(a.sessionId, true);
    if ('error' in access) return this.outbox.urgent(attachedError(a.sessionId, access.error));
    const out = await this.attach(a, 'url');
    if (out.error) this.outbox.urgent(attachedError(a.sessionId, out.error));
    else this.outbox.urgent(encodeNotification('sessions.attached', { sessionId: a.sessionId, error: null, ...(out.result as object), timing: { serverUs: us(t0) } }));
    this.outbox.release(a.sessionId);
  }

  private async onText(text: string) {
    const m = parseFrame(text);
    if (m.kind === 'invalid') return this.outbox.urgent(encodeRpcError(m.id, m.code, m.message));
    if (m.kind === 'notification') return this.onNotification(m.method, m.params, text.length);
    const wait = this.bucket.take();
    if (wait > 0) {
      this.emitError(m.method, 'rate_limited');
      return this.outbox.urgent(encodeError(m.id, errors.rateLimited(wait)));
    }
    if (this.terminals.pendingError) {
      const e = this.terminals.pendingError;
      this.terminals.pendingError = undefined;
      return this.outbox.urgent(encodeError(m.id, e));
    }
    if (!isMethod(m.method)) return this.outbox.urgent(encodeRpcError(m.id, -32601, 'Method not found'));
    const t0 = process.hrtime.bigint();
    const sid = (m.params as { sessionId?: unknown } | undefined)?.sessionId;
    // A write holds its session's events until its response is queued; an attach holds them in Attachment.start.
    const held = typeof sid === 'string' && WRITES.has(m.method) ? sid : undefined;
    if (held) this.outbox.hold(held);
    const call = { attached: false };
    let out: CallOutcome;
    try {
      out = await this.run(m.method, m.params, call);
    } catch {
      out = { error: errors.internal() };
    }
    this.respond(m.id, m.method, out, t0);
    if (held) this.outbox.release(held);
    if (call.attached) this.outbox.release(sid as string);
  }

  private respond(id: RpcId, method: Method, out: CallOutcome, t0: bigint) {
    if (out.error) {
      this.emitError(method, out.error.code);
      return this.outbox.urgent(encodeError(id, out.error.requestId ? out.error : { ...out.error, requestId: requestId() }));
    }
    let result = out.result;
    if (method === 'sessions.attach' || TIMED.has(method)) result = { ...(result as object), timing: { serverUs: us(t0) } };
    this.outbox.urgent(encodeResult(id, result));
  }

  private onNotification(method: string, params: unknown, bytes: number) {
    if (method === 'telemetry') return this.onTelemetry(params, bytes);
    if (method !== 'sessions.ack') return;
    const p = params as { sessionId?: unknown; seq?: unknown } | undefined;
    if (typeof p?.sessionId === 'string' && typeof p.seq === 'number' && Number.isInteger(p.seq)) this.attached.get(p.sessionId)?.ack(p.seq);
  }

  /** opc's `telemetry` notification: checked, rate limited, forwarded event by event; one `wire.telemetry` per frame let through. */
  private onTelemetry(params: unknown, bytes: number) {
    const { emit, forward } = this.deps;
    if (!emit || !forward) return;
    if (bytes > CLI_LIMITS.frameBytes || this.cliFrames.take() > 0) return this.window?.refused();
    const checked = checkCliFrame(params, bytes, {
      member: this.member,
      maySee: (sid) => {
        const access = inTicket(this.claims.scope, sid) ? this.deps.host.access(sid) : undefined;
        return !!access && mayAttach(access, this.member);
      },
      now: Date.now,
    });
    for (const e of checked.events) forward(e.name, e.fields);
    const result = checked.events.length || !checked.rejected ? 'ok' : 'invalid';
    emit('wire.telemetry', { connection_id: this.id, person_id: this.member, events: checked.events.length, rejected: checked.rejected, result });
  }

  private async run(method: Method, raw: unknown, call: { attached: boolean }): Promise<CallOutcome> {
    const decoded = decodeParams(method, raw);
    if (!decoded.ok) return { error: errors.invalidParams(decoded.field, decoded.message) };
    const params = decoded.value as Record<string, unknown>;
    const scope = scopeFor(method);
    if (!hasScope(this.claims.scope, scope)) return { error: errors.missingScope(scope ?? '') };
    if (method === 'ping') return { result: {} };
    if (method === 'terminals.resize') return this.terminals.resize(params.terminalId as string, params.cols as number, params.rows as number);
    if (method === 'terminals.eof') return this.terminals.eof(params.terminalId as string);
    if (method === 'terminals.close') return this.terminals.close(params.terminalId as string);

    const sessionId = params.sessionId as string;
    const access = await this.access(sessionId, true);
    if ('error' in access) return access;
    const a = this.attached.get(sessionId);
    if (WRITES.has(method) && (this.claims.scope.readOnly || a?.readOnly)) return { error: errors.readOnly() };

    switch (method) {
      case 'sessions.attach':
        if (!a && this.attached.size >= LIMITS.maxAttached) return { error: errors.tooManyAttached() };
        call.attached = true;
        return this.attach({ ...(params as unknown as AttachRequest), sessionId, deltas: !!params.deltas }, 'method');
      case 'sessions.detach':
        if (a) this.detach(sessionId, undefined);
        return { result: {} };
      case 'terminals.open':
        return this.terminals.open(params as unknown as OpenParams, access.access);
    }
    const link = a?.link && !a.link.closed ? a.link : await this.links.get(sessionId);
    if ('error' in link) return { error: link.error };
    const rid = requestId();
    const out = await link.call(method, raw, {
      actor: this.actor,
      member: this.member,
      idempotencyKey: typeof params.idempotencyKey === 'string' ? params.idempotencyKey : undefined,
      requestId: rid,
    });
    return out.error && !out.error.requestId ? { error: { ...out.error, requestId: rid } } : out;
  }

  /** The session's access list, if this member may see it through this credential. */
  private async access(sessionId: string, hold: boolean): Promise<{ access: SessionAccess } | { error: NonNullable<CallOutcome['error']> }> {
    if (!inTicket(this.claims.scope, sessionId)) return { error: errors.sessionNotFound() };
    const access = await this.deps.host.waitAccess(sessionId, hold ? LIMITS.holdUnknownMs : 0);
    if (!access || !mayAttach(access, this.member)) return { error: errors.sessionNotFound() };
    return { access };
  }

  private async attach(o: UrlAttach, via: 'url' | 'method'): Promise<CallOutcome> {
    const t0 = Date.now();
    this.attached.get(o.sessionId)?.close();
    this.outbox.drop(o.sessionId);
    const w = this.window;
    const a = new Attachment(
      o.sessionId,
      { host: this.deps.host, dial: this.deps.dial, outbox: this.outbox, detached: (sid, r, m) => this.detach(sid, r, m), metered: !!w, duplicate: w && (() => w.duplicate()) },
      o,
    );
    this.attached.set(o.sessionId, a);
    const out = await a.start(o, this.actor);
    this.deps.emit?.('wire.attach', {
      connection_id: this.id, person_id: this.member, session_key: o.sessionId, attach_ms: Date.now() - t0, via, resume: !!o.resume,
      replay: o.after !== undefined || o.tailTurns !== undefined, deltas: !!o.deltas,
      outcome: out.error ? 'failed' : 'completed', error_code: out.error?.code,
    });
    if (out.error) {
      a.close();
      if (this.attached.get(o.sessionId) === a) {
        this.attached.delete(o.sessionId);
        this.outbox.drop(o.sessionId);
      }
    } else this.stats.attaches++;
    return out;
  }

  /** Stop sending a session; `reason` set: tell the client (`session.detached`). */
  private detach(sessionId: string, reason: WireDetachReason | undefined, moved?: EpochMoved) {
    const a = this.attached.get(sessionId);
    if (!a) return;
    a.close();
    this.attached.delete(sessionId);
    this.outbox.drop(sessionId);
    if (reason) {
      this.deps.emit?.('wire.detached', { connection_id: this.id, person_id: this.member, session_key: sessionId, reason });
      this.outbox.urgent(encodeNotification('session.detached', { sessionId, reason, ...moved }));
    }
  }

  private timer(ms: number, fn: () => void) {
    const t = setTimeout(fn, Math.min(ms, 2 ** 31 - 1));
    t.unref?.();
    this.timers.push(t);
  }

  private teardown() {
    if (this.done) return;
    this.done = true;
    this.window?.close();
    for (const t of this.timers) clearTimeout(t);
    for (const a of this.attached.values()) a.close();
    this.attached.clear();
    this.links.close();
    this.terminals.closeAll();
    this.outbox.close();
    this.deps.closed(this);
  }
}

function attachedError(sessionId: string, error: NonNullable<CallOutcome['error']>) {
  return encodeNotification('sessions.attached', {
    sessionId, error, session: null, logEpoch: null, epochStartSeq: null, capabilities: null, earlierTurns: null, timing: null,
  });
}
