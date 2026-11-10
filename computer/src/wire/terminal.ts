// One connection's terminals, relay side (opc docs websocket/terminals.mdx):
// `terminals.*` calls go to the host (host/terminal.ts), whose answer names a
// unix socket per stream; bytes flow between those sockets and binary frames
// `[channel u32 BE][data]` on the WebSocket.
//
// Invariants:
// - Only the session's owner or an admin opens one (checked here against the
//   host's access list and admins; the host checks the 8-per-session limit).
// - Output goes out ahead of events (the outbox's urgent queue), in frames of
//   at most 64 KiB, and the terminal's socket is paused while the connection
//   is congested, so a flood of output cannot grow memory.
// - `terminal.exited` is sent after the terminal's sockets have ended, so all
//   output precedes it.
// - Input over 1 MiB/s per terminal is dropped, and the connection's next
//   request fails with `rate_limited`.
// - A terminal belongs to the connection that opened it; closing the
//   connection hangs up every one of them.

import net from 'node:net';
import type { ApiError, HostToWire, SessionAccess } from '../protocol.js';
import type { CallOutcome } from '../api/writer.js';
import { mayOpenTerminal } from './edge-auth.js';
import type { HostLink } from './host-link.js';
import { LIMITS, TokenBucket } from './limits.js';
import type { Outbox } from './outbox.js';
import { encodeNotification, errors } from './rpc.js';
import type { WireEmit } from './telemetry.js';

interface Open {
  id: string;
  sessionId: string;
  channel: number;
  stderrChannel: number | null;
  sockets: net.Socket[];
  live: number;
  bucket: TokenBucket;
  exited?: Extract<HostToWire, { t: 'terminal.exited' }>;
  done: boolean;
  /** For `wire.terminal`. */
  openedAt: number;
  bytesIn: number;
  bytesOut: number;
}

export interface TerminalDeps {
  host: HostLink;
  outbox: Outbox;
  member: string;
  /** Register/unregister for the host's `terminal.exited` (the relay routes by terminal id). */
  route(terminalId: string, to: WireTerminals | undefined): void;
  onChange?(): void;
  /** Telemetry: one `wire.terminal` per terminal when it ends. */
  emit?: WireEmit;
  connectionId?: string;
}

export interface OpenParams {
  sessionId: string;
  cols?: number;
  rows?: number;
  command?: string;
  tty?: boolean;
  term?: string;
}

const EXIT_WAIT_MS = 2000;

export class WireTerminals {
  private byId = new Map<string, Open>();
  private byChannel = new Map<number, Open>();
  private nextChannel = 1;
  /** Input was dropped: the next request fails with this. */
  pendingError: ApiError | undefined;

  constructor(private deps: TerminalDeps) {}

  get size() {
    return this.byId.size;
  }

  async open(p: OpenParams, access: SessionAccess | undefined): Promise<CallOutcome> {
    const { host, member } = this.deps;
    if (!access) return { error: errors.sessionNotFound() };
    if (!mayOpenTerminal(access, member, host.admins)) return { error: errors.terminalOwnerOnly() };
    const tty = p.tty ?? true;
    if (tty && (p.cols === undefined || p.rows === undefined)) return { error: errors.invalidParams(p.cols === undefined ? 'cols' : 'rows', 'cols and rows are required with tty') };
    const r = await host.call({
      t: 'terminal.open', sessionId: p.sessionId, member, cols: p.cols ?? 80, rows: p.rows ?? 24, command: p.command, tty, term: p.term,
    });
    if (r.error) return { error: r.error };
    const res = r.result as { terminalId: string; socket: string; stderrSocket?: string | null };
    const t: Open = {
      id: res.terminalId,
      sessionId: p.sessionId,
      channel: this.nextChannel++,
      stderrChannel: res.stderrSocket ? this.nextChannel++ : null,
      sockets: [],
      live: 0,
      bucket: new TokenBucket(LIMITS.terminalInputBytesPerSecond, LIMITS.terminalInputBytesPerSecond),
      done: false,
      openedAt: Date.now(),
      bytesIn: 0,
      bytesOut: 0,
    };
    try {
      t.sockets.push(await this.connect(t, res.socket, t.channel));
      if (res.stderrSocket && t.stderrChannel !== null) t.sockets.push(await this.connect(t, res.stderrSocket, t.stderrChannel));
    } catch {
      for (const s of t.sockets) s.destroy();
      void host.call({ t: 'terminal.close', terminalId: t.id });
      return { error: errors.unavailable() };
    }
    this.byId.set(t.id, t);
    this.byChannel.set(t.channel, t);
    this.deps.route(t.id, this);
    this.deps.onChange?.();
    return { result: { terminal: { id: t.id, channel: t.channel, stderrChannel: t.stderrChannel } } };
  }

  /** A binary frame from the client. */
  input(frame: Buffer) {
    if (frame.length < 4) return;
    const t = this.byChannel.get(frame.readUInt32BE(0));
    if (!t || t.done) return;
    const data = frame.subarray(4);
    if (t.bucket.take(data.length) > 0) {
      this.pendingError = errors.rateLimited(1000);
      return;
    }
    t.bytesIn += data.length;
    t.sockets[0]?.write(data);
  }

  async resize(terminalId: string, cols: number, rows: number): Promise<CallOutcome> {
    if (!this.byId.has(terminalId)) return { error: errors.terminalNotFound() };
    return this.forward(await this.deps.host.call({ t: 'terminal.resize', terminalId, cols, rows }));
  }

  async eof(terminalId: string): Promise<CallOutcome> {
    if (!this.byId.has(terminalId)) return { error: errors.terminalNotFound() };
    return this.forward(await this.deps.host.call({ t: 'terminal.eof', terminalId }));
  }

  async close(terminalId: string): Promise<CallOutcome> {
    if (!this.byId.has(terminalId)) return { error: errors.terminalNotFound() };
    return this.forward(await this.deps.host.call({ t: 'terminal.close', terminalId }));
  }

  /** The host says the terminal's process ended. */
  exited(m: Extract<HostToWire, { t: 'terminal.exited' }>) {
    const t = this.byId.get(m.terminalId);
    if (!t) return;
    t.exited = m;
    if (t.live === 0) return this.finish(t);
    setTimeout(() => {
      for (const s of t.sockets) s.destroy();
      this.finish(t);
    }, EXIT_WAIT_MS).unref();
  }

  /** The connection closed: hang up everything it opened. */
  closeAll() {
    for (const t of this.byId.values()) {
      t.done = true;
      for (const s of t.sockets) s.destroy();
      void this.deps.host.call({ t: 'terminal.close', terminalId: t.id });
      this.deps.route(t.id, undefined);
      this.ended(t, false);
    }
    this.byId.clear();
    this.byChannel.clear();
  }

  private forward(r: { result?: unknown; error?: ApiError }): CallOutcome {
    return r.error ? { error: r.error } : { result: {} };
  }

  private connect(t: Open, path: string, channel: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const s = net.connect(path);
      s.setNoDelay?.(true);
      s.once('error', reject);
      s.once('connect', () => {
        s.off('error', reject);
        s.on('error', () => {});
        t.live++;
        resolve(s);
      });
      const head = Buffer.alloc(4);
      head.writeUInt32BE(channel, 0);
      s.on('data', (chunk: Buffer) => {
        const { outbox } = this.deps;
        t.bytesOut += chunk.length;
        const room = LIMITS.terminalFrameBytes - head.length; // a frame is at most 64 KiB with its header
        for (let i = 0; i < chunk.length; i += room) {
          outbox.urgent(Buffer.concat([head, chunk.subarray(i, i + room)]));
        }
        if (outbox.congested) {
          s.pause();
          outbox.whenDrained(() => s.resume());
        }
      });
      s.on('close', () => {
        t.live = Math.max(0, t.live - 1);
        if (t.live === 0 && t.exited) this.finish(t);
      });
    });
  }

  private finish(t: Open) {
    if (t.done && !this.byId.has(t.id)) return;
    t.done = true;
    this.byId.delete(t.id);
    this.byChannel.delete(t.channel);
    this.deps.route(t.id, undefined);
    const m = t.exited;
    this.deps.outbox.urgent(encodeNotification('terminal.exited', { terminalId: t.id, exitCode: m?.exitCode ?? null, signal: m?.signal ?? null }));
    this.deps.onChange?.();
    this.ended(t, true);
  }

  private ended(t: Open, exited: boolean) {
    this.deps.emit?.('wire.terminal', {
      connection_id: this.deps.connectionId, person_id: this.deps.member, session_key: t.sessionId,
      duration_ms: Date.now() - t.openedAt, bytes_in: t.bytesIn, bytes_out: t.bytesOut, exited,
    });
  }
}
