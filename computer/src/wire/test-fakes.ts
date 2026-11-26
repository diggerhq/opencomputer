// Test-only fakes for the relay's tests (relay.test.ts, files.test.ts,
// relay.bench.test.ts): a host wire socket, an in-process writer (DialWriter),
// a writer API socket for the real dialWriter, and a signed WebSocket client.
// Never imported by the relay itself.
//
// Invariants: every fake answers in the documented frame shapes
// (protocol-api.ts WireToHost/HostToWire and ApiClientFrame/ApiWriterFrame),
// and every server it starts is closed by `close()`.

import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import type { HostToWire, JournalDelta, JournalEvent, SessionAccess, WireToHost } from '../protocol.js';
import type { CallOutcome } from '../api/writer.js';
import { mintId } from '../session-ids.js';
import { signWire, type WireScope } from '../signed-header.js';
import { ndjson, writeLine } from './ndjson.js';
import type { DialWriter, SubscribeFrame, WriterHandlers, WriterLink } from './writer-client.js';

export const KEY = 'test-wire-key-0123456789abcdef';

export type HostAnswer = (m: Extract<WireToHost, { id: string }> | { t: 'files.list'; id: string }, peer: net.Socket) => { result?: unknown; error?: unknown } | undefined | Promise<{ result?: unknown; error?: unknown } | undefined>;

/** A host on a fresh wire.sock: `welcome` with `key` and `access`, `where` answered for every known session. */
export async function fakeHost(o: { key?: string | null; access?: SessionAccess[]; admins?: string[]; answer?: HostAnswer } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wire-host-'));
  const socket = path.join(dir, 'wire.sock');
  const peers = new Set<net.Socket>();
  const access = new Map((o.access ?? []).map((a) => [a.sessionId, a]));
  const calls: unknown[] = [];
  const state = { key: o.key === undefined ? KEY : o.key, answer: o.answer };
  const server = net.createServer((peer) => {
    peers.add(peer);
    peer.on('error', () => {});
    peer.on('close', () => peers.delete(peer));
    ndjson(peer, 1 << 22, async (raw) => {
      const m = raw as WireToHost;
      if (m.t === 'hello') return void writeLine(peer, { t: 'welcome', key: state.key, admins: o.admins ?? [], access: [...access.values()] } satisfies HostToWire);
      calls.push(m);
      if (!('id' in m)) return;
      const custom = await state.answer?.(m as never, peer);
      if (custom) return void writeLine(peer, { t: 'result', id: m.id, ...custom });
      if (m.t === 'where') {
        if (!access.has(m.sessionId)) return void writeLine(peer, { t: 'result', id: m.id, error: { code: 'session_not_found', message: 'no', status: 404 } });
        return void writeLine(peer, { t: 'result', id: m.id, result: { socket: `/fake/${m.sessionId}.api.sock`, token: 'tok', writer: 'host', epoch: 1 } });
      }
      if (m.t === 'resume') return void writeLine(peer, { t: 'result', id: m.id, result: { status: 'starting' } });
      writeLine(peer, { t: 'result', id: m.id, error: { code: 'internal', message: 'fake host: unhandled', status: 500 } });
    });
  });
  await new Promise<void>((r) => server.listen(socket, () => r()));
  return {
    socket,
    calls,
    state,
    push(m: HostToWire) {
      if (m.t === 'access') access.set(m.access.sessionId, m.access);
      for (const p of peers) writeLine(p, m);
    },
    async close() {
      for (const p of peers) p.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const accessFor = (sessionId: string, owner = 'usr_owner', members: string[] | null = null): SessionAccess => ({ sessionId, owner, members });

export function event(sessionId: string, seq: number, type = 'turn.started', data: unknown = {}): JournalEvent {
  return { id: `ev_${String(seq).padStart(16, '0')}`, seq, createdAt: '2026-10-26T00:00:00.000Z', sessionId, turnId: null, type, actor: null, data };
}

/** One in-process writer per dial: the test drives events, deltas and call answers. */
export interface FakeWriter {
  sessionId: string;
  h: WriterHandlers;
  subscribed: SubscribeFrame | undefined;
  calls: { method: string; params: unknown }[];
  acks: number[];
  paused: boolean;
  closed: boolean;
}

/** A DialWriter whose writers subscribe with `attached(sessionId)` and answer calls with `onCall`. */
export function fakeDial(o: { lastSeq?: number; epoch?: number; onCall?: (w: FakeWriter, method: string, params: unknown) => CallOutcome | Promise<CallOutcome>; onSubscribe?: (w: FakeWriter) => void } = {}) {
  const writers: FakeWriter[] = [];
  const dial: DialWriter = async (where, h) => {
    const sessionId = path.basename(where.socket).replace('.api.sock', '');
    const w: FakeWriter = { sessionId, h, subscribed: undefined, calls: [], acks: [], paused: false, closed: false };
    writers.push(w);
    const link: WriterLink = {
      async call(method, params) {
        w.calls.push({ method, params });
        return o.onCall ? o.onCall(w, method, params) : { result: { ok: true } };
      },
      async subscribe(f) {
        w.subscribed = f;
        const lastSeq = o.lastSeq ?? 0;
        const after = f.after ?? lastSeq;
        // Like the writer's hub, events follow the result on a later tick.
        if (o.onSubscribe) setImmediate(() => o.onSubscribe?.(w));
        return { result: { session: { id: sessionId, lastSeq }, after, lastSeq, epoch: o.epoch ?? 1 } };
      },
      ack: (seq) => void w.acks.push(seq),
      pause: () => void (w.paused = true),
      resume: () => void (w.paused = false),
      close: () => void (w.closed = true),
      get closed() {
        return w.closed;
      },
    };
    return link;
  };
  return { dial, writers, last: (sid: string) => [...writers].reverse().find((w) => w.sessionId === sid && w.subscribed) };
}

/** A writer's API socket (ApiWriterFrame), for the real dialWriter: subscribe answers, then `emit` writes events. */
export async function fakeWriterSocket() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wire-writer-'));
  const socket = path.join(dir, 'cs.api.sock');
  let sub: net.Socket | undefined;
  const server = net.createServer((s) => {
    s.setNoDelay?.(true);
    s.on('error', () => {});
    ndjson(s, 1 << 22, (raw) => {
      const m = raw as { t: string; id?: string; after?: number };
      if (m.t === 'subscribe') {
        sub = s;
        writeLine(s, { t: 'result', id: m.id, result: { session: { lastSeq: 0 }, after: m.after ?? 0, lastSeq: 0, epoch: 1 } });
      } else if (m.t === 'call') writeLine(s, { t: 'result', id: m.id, result: {} });
    });
  });
  await new Promise<void>((r) => server.listen(socket, () => r()));
  return {
    socket,
    emit: (e: JournalEvent | { delta: JournalDelta }) => (sub ? writeLine(sub, 'delta' in e ? { t: 'delta', delta: e.delta } : { t: 'event', event: e }) : false),
    get subscribed() {
      return sub !== undefined;
    },
    async close() {
      sub?.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A frame as the client parsed it: JSON from the wire, read loosely by tests (the edge). */
// biome-ignore lint/suspicious/noExplicitAny: parsed client frames at the test edge
export type Frame = any;

export interface Client {
  ws: WebSocket;
  frames: Frame[];
  closed: Promise<{ code: number; reason: string }>;
  /** The first frame matching `pred` not yet taken, waiting up to `ms`. */
  next(pred: (m: Frame) => boolean, ms?: number): Promise<Frame>;
  call(method: string, params: unknown, ms?: number): Promise<Frame>;
}

let rpcId = 0;

/** A client WebSocket to the relay, signed as the wire Worker would sign it. */
export function connectClient(port: number, o: { member?: string; keyId?: string; scope?: WireScope; query?: string; protocol?: string | null; key?: string } = {}): Client {
  const headers = signWire(o.key ?? KEY, { member: o.member ?? 'usr_owner', keyId: o.keyId ?? 'ak_000000000000', client: 'opc/0.1.0', scope: o.scope ?? {} });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/connect${o.query ? `?${o.query}` : ''}`, o.protocol === null ? [] : [o.protocol ?? 'opc.v1'], { headers, maxPayload: 64 * 1024 * 1024 });
  const frames: Frame[] = [];
  ws.on('message', (d: Buffer, binary: boolean) => frames.push(binary ? d : JSON.parse(d.toString('utf8'))));
  ws.on('error', () => {});
  const closed = new Promise<{ code: number; reason: string }>((r) => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
  const next = async (pred: (m: Frame) => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    for (;;) {
      const i = frames.findIndex(pred);
      if (i >= 0) return frames.splice(i, 1)[0];
      if (Date.now() > end) throw new Error(`no matching frame; have ${JSON.stringify(frames).slice(0, 2000)}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return {
    ws,
    frames,
    closed,
    next,
    async call(method, params, ms) {
      const id = ++rpcId;
      if (ws.readyState === WebSocket.CONNECTING) await new Promise((r) => ws.once('open', r));
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      return next((m) => m.id === id, ms);
    },
  };
}

export const sid = () => mintId('cs');
export const until = async (fn: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};
