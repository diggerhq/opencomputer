// One connection's terminals, relay side (opc docs websocket/terminals.mdx):
// `terminals.*` calls go to the host (host/terminal.ts), whose answer names a
// unix socket per stream; bytes flow between those sockets and binary frames
// `[channel u32 BE][data]` on the WebSocket.
//
// Invariants:
// - Only someone who may drive the session opens one (checked here against the
//   host's access list; an admin who is not named gets nothing extra; the host
//   checks again, and the 8-per-session limit).
// - Output goes out ahead of events (the outbox's urgent queue), in frames of
//   at most 64 KiB, and the terminal's socket is paused while the connection
//   is congested, so a flood of output cannot grow memory.
// - `terminal.exited` is sent after the terminal's sockets have ended, so all
//   output precedes it.
// - Input over 1 MiB/s per terminal is dropped, and the connection's next
//   request fails with `rate_limited`.
// - A terminal belongs to the connection that opened it; closing the
//   connection hangs up every one of them.
// - A tty terminal with no input and no output for `idleMs` (LIMITS.terminalIdleMs,
//   SP_WIRE_TERMINAL_IDLE_MINUTES) is hung up, and its `terminal.exited` says
//   `reason: "idle"`; one whose session the member may no longer drive is hung
//   up with `reason: "access_lost"`. A command without a tty is never idle.
// - A browser (`browsers.*`) is a terminal without a tty whose command the
//   host fixes (host/browser-cdp.py): the client never names one. Its idle
//   clock counts input only (a page animates on its own), its stderr is read
//   and dropped, and its end is `browser.exited`, not `terminal.exited`.
// - A desktop (`desktops.*`, host/desktop-x11.py) is the same, carrying VNC;
//   its idle clock counts the viewer's key, pointer and clipboard events only
//   (rfb-input.ts), and its end is `desktop.exited`.

import net from 'node:net';
import type { ApiError, HostToWire, SessionAccess } from '../protocol.js';
import type { CallOutcome } from '../api/writer.js';
import { mayOpenTerminal } from './edge-auth.js';
import type { HostLink } from './host-link.js';
import { LIMITS, TokenBucket } from './limits.js';
import type { Outbox } from './outbox.js';
import { rfbActivity } from './rfb-input.js';
import { encodeNotification, errors } from './rpc.js';
import type { WireEmit } from './telemetry.js';

/** What runs in place of a terminal's command, as the wire names it (`browsers.*`, `desktops.*`). */
export type WireApp = 'browser' | 'desktop';

const APPS = {
  browser: { exited: 'browser.exited', idKey: 'browserId', notFound: () => errors.browserNotFound() },
  desktop: { exited: 'desktop.exited', idKey: 'desktopId', notFound: () => errors.desktopNotFound() },
} as const;

interface Open {
  id: string;
  app?: WireApp;
  sessionId: string;
  channel: number;
  stderrChannel: number | null;
  sockets: net.Socket[];
  live: number;
  bucket: TokenBucket;
  exited?: Extract<HostToWire, { t: 'terminal.exited' }>;
  done: boolean;
  /** Why the relay hung it up, if it did. */
  reason?: TerminalEndReason;
  /** Last input or output (ms; input only for an app), for the idle timeout; tty terminals and apps only. */
  activeAt: number;
  /** A desktop's: whether a chunk of the viewer's bytes was a person's action, not an update request. */
  activity?: (chunk: Uint8Array) => boolean;
  idleTimer?: NodeJS.Timeout;
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
  /** Hang up a tty terminal after this long with no input or output; 0 never. Default LIMITS.terminalIdleMs. */
  idleMs?: number;
}

/** Why the relay hung a terminal up, in `terminal.exited.reason`. */
export type TerminalEndReason = 'idle' | 'access_lost';

export interface OpenParams {
  sessionId: string;
  cols?: number;
  rows?: number;
  command?: string;
  tty?: boolean;
  term?: string;
}

export interface AppParams {
  sessionId: string;
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
    const tty = p.tty ?? true;
    if (tty && (p.cols === undefined || p.rows === undefined)) return { error: errors.invalidParams(p.cols === undefined ? 'cols' : 'rows', 'cols and rows are required with tty') };
    const r = await this.start(p.sessionId, access, { cols: p.cols ?? 80, rows: p.rows ?? 24, command: p.command, tty, term: p.term });
    if ('error' in r) return r;
    if (tty) this.watchIdle(r.t);
    return { result: { terminal: { id: r.t.id, channel: r.t.channel, stderrChannel: r.t.stderrChannel } } };
  }

  /** `browsers.open`, `desktops.open`: the session's headless browser or X desktop, on one channel (both directions). */
  async openApp(app: WireApp, p: AppParams, access: SessionAccess | undefined): Promise<CallOutcome> {
    const r = await this.start(p.sessionId, access, { cols: 80, rows: 24, tty: false, app });
    if ('error' in r) return r;
    this.watchIdle(r.t);
    return { result: { [app]: { id: r.t.id, channel: r.t.channel } } };
  }

  private async start(
    sessionId: string,
    access: SessionAccess | undefined,
    o: { cols: number; rows: number; tty: boolean; command?: string; term?: string; app?: WireApp },
  ): Promise<{ t: Open } | { error: ApiError }> {
    const { host, member } = this.deps;
    if (!access) return { error: errors.sessionNotFound() };
    if (!mayOpenTerminal(access, member)) return { error: errors.terminalOwnerOnly() };
    const r = await host.call({ t: 'terminal.open', sessionId, member, ...o });
    if (r.error) return { error: r.error };
    const res = r.result as { terminalId: string; socket: string; stderrSocket?: string | null };
    const t: Open = {
      id: res.terminalId,
      app: o.app,
      sessionId,
      channel: this.nextChannel++,
      stderrChannel: res.stderrSocket ? this.nextChannel++ : null,
      sockets: [],
      live: 0,
      bucket: new TokenBucket(LIMITS.terminalInputBytesPerSecond, LIMITS.terminalInputBytesPerSecond),
      done: false,
      activeAt: Date.now(),
      activity: o.app === 'desktop' ? rfbActivity() : undefined,
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
    return { t };
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
    if (!t.activity || t.activity(data)) t.activeAt = Date.now();
    t.sockets[0]?.write(data);
  }

  /** The sessions this connection has terminals in. */
  sessions(): Set<string> {
    return new Set([...this.byId.values()].map((t) => t.sessionId));
  }

  /** The member may no longer drive `sessionId`: hang up every terminal they have in it. */
  closeSession(sessionId: string) {
    for (const t of this.byId.values()) if (t.sessionId === sessionId) this.hangUp(t, 'access_lost');
  }

  async resize(terminalId: string, cols: number, rows: number): Promise<CallOutcome> {
    if (!this.isTerminal(terminalId)) return { error: errors.terminalNotFound() };
    return this.forward(await this.deps.host.call({ t: 'terminal.resize', terminalId, cols, rows }));
  }

  async eof(terminalId: string): Promise<CallOutcome> {
    if (!this.isTerminal(terminalId)) return { error: errors.terminalNotFound() };
    return this.forward(await this.deps.host.call({ t: 'terminal.eof', terminalId }));
  }

  async close(terminalId: string): Promise<CallOutcome> {
    if (!this.isTerminal(terminalId)) return { error: errors.terminalNotFound() };
    return this.forward(await this.deps.host.call({ t: 'terminal.close', terminalId }));
  }

  private isTerminal(id: string) {
    const t = this.byId.get(id);
    return t !== undefined && t.app === undefined;
  }

  async closeApp(app: WireApp, id: string): Promise<CallOutcome> {
    if (this.byId.get(id)?.app !== app) return { error: APPS[app].notFound() };
    return this.forward(await this.deps.host.call({ t: 'terminal.close', terminalId: id }));
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
      clearTimeout(t.idleTimer);
      for (const s of t.sockets) s.destroy();
      void this.deps.host.call({ t: 'terminal.close', terminalId: t.id });
      this.deps.route(t.id, undefined);
      this.ended(t, false);
    }
    this.byId.clear();
    this.byChannel.clear();
  }

  /** Checks at the earliest moment the terminal could have gone idle, and hangs it up once it has. */
  private watchIdle(t: Open) {
    const idleMs = this.deps.idleMs ?? LIMITS.terminalIdleMs;
    if (!(idleMs > 0)) return;
    const check = () => {
      if (t.done) return;
      const left = t.activeAt + idleMs - Date.now();
      if (left > 0) return void (t.idleTimer = arm(left));
      this.hangUp(t, 'idle');
    };
    const arm = (ms: number) => {
      const timer = setTimeout(check, ms);
      timer.unref?.();
      return timer;
    };
    t.idleTimer = arm(idleMs);
  }

  /** Ask the host to end the terminal; its `terminal.exited` then carries `reason`. */
  private hangUp(t: Open, reason: TerminalEndReason) {
    if (t.done || t.reason) return;
    t.reason = reason;
    clearTimeout(t.idleTimer);
    void this.deps.host.call({ t: 'terminal.close', terminalId: t.id });
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
        if (t.app && channel !== t.channel) return; // an app's stderr: Chromium's or x11vnc's noise
        t.bytesOut += chunk.length;
        if (!t.app) t.activeAt = Date.now();
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
    clearTimeout(t.idleTimer);
    this.byId.delete(t.id);
    this.byChannel.delete(t.channel);
    this.deps.route(t.id, undefined);
    const m = t.exited;
    const reason = t.reason ? { reason: t.reason } : {};
    this.deps.outbox.urgent(
      t.app
        ? encodeNotification(APPS[t.app].exited, { [APPS[t.app].idKey]: t.id, ...reason })
        : encodeNotification('terminal.exited', { terminalId: t.id, exitCode: m?.exitCode ?? null, signal: m?.signal ?? null, ...reason }),
    );
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
