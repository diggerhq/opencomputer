// Host agents dial in over one WebSocket each (path /host, `Authorization:
// Bearer <host token>`). The hub authenticates them, hands over credentials
// and the people table at `welcome`, stores their session reports, answers
// GitHub token requests, and carries deliver/action/stop to the host that
// serves a session. With no host connected, deliveries and clicks wait in the
// outbox and go out when one says hello.

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  type Delivery,
  type GatewayToHost,
  type HostCredentials,
  type HostToGateway,
  type PostThreadRequest,
  type PostThreadResult,
  type ReadThreadRequest,
  type SecretRequest,
  type SessionSecret,
  type SessionSpec,
  type SpawnRequest,
  type SpawnResult,
  type WorkspaceStatus,
} from '../protocol.js';
import type { Linked } from '../links.js';
import type { Store, Queued } from './db.js';
import { errorText, log } from '../log.js';

export interface HubDeps {
  store: Store;
  /** Static host tokens (SP_HOST_TOKENS); the hosts table holds issued ones. */
  tokens: string[];
  /** Tokens issued by /setup (S3's checkHostToken): the host's label, or undefined. */
  checkToken?(token: string): string | undefined;
  credentials(): HostCredentials;
  mintToken(repos?: string[]): Promise<{ token: string; expiresAt: string }>;
  /** A session starts a new thread (work 047): the router posts it and creates the session. */
  spawn?(from: string, req: SpawnRequest): Promise<SpawnResult>;
  /** A session reads a Slack thread, or posts into one for its owner (work 049 L3). */
  readThread?(from: string, host: string, req: ReadThreadRequest): Promise<Linked>;
  postThread?(from: string, host: string, req: PostThreadRequest): Promise<PostThreadResult>;
  /** The secrets a session gets (work 046), sent with every delivery. */
  secretsFor?(spec: SessionSpec): SessionSecret[];
  /** A session asks its person for a secret: the gateway posts a button in its thread. */
  requestSecret?(from: string, req: SecretRequest): Promise<void>;
}

export interface Reply {
  ok: boolean;
  error?: string;
}

interface Conn {
  ws: WebSocket;
  hostId: string;
  version: string;
  pending: Map<string, (r: Reply) => void>;
}

type Request = DistributiveOmit<Extract<GatewayToHost, { id: string }>, 'id'>;
type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

/** Starting a runner (fork, boot Claude Code) happens before the host replies. */
const REPLY_TIMEOUT_MS = 30_000;
/** Proxies in front of the gateway close idle connections; ping well inside its window, and drop hosts that stop answering. */
const PING_MS = 25_000;

export class Hub {
  private wss = new WebSocketServer({ noServer: true });
  private conns = new Map<string, Conn>();
  /** Latest housekeeping status per person, for !status. */
  readonly workspaces = new Map<string, WorkspaceStatus & { at: number }>();

  private pinger: NodeJS.Timeout;

  constructor(private deps: HubDeps) {
    const alive = new WeakSet<WebSocket>();
    this.wss.on('connection', (ws) => {
      alive.add(ws);
      ws.on('pong', () => alive.add(ws));
    });
    this.pinger = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (!alive.has(ws)) {
          ws.terminate();
          continue;
        }
        alive.delete(ws);
        ws.ping();
      }
    }, PING_MS);
    this.pinger.unref();
  }

  /** Take over WebSocket upgrades on /host for a server (Bolt's, or setup mode's). */
  attach(server: Server) {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (new URL(req.url ?? '/', 'http://x').pathname !== '/host') return void socket.destroy();
      const token = req.headers.authorization?.match(/^Bearer\s+(.+)$/)?.[1];
      if (!token || !this.authorized(token)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req);
        this.accept(ws);
      });
    });
  }

  private authorized(token: string) {
    if (this.deps.tokens.includes(token) || this.deps.store.hostForToken(token)) return true;
    try {
      return !!this.deps.checkToken?.(token);
    } catch (e: any) {
      log.warn('host token check failed:', e?.message ?? e);
      return false;
    }
  }

  private accept(ws: WebSocket) {
    let conn: Conn | undefined;
    ws.on('message', (data) => {
      let m: HostToGateway;
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      if (m.t === 'hello') conn = this.hello(ws, m);
      else if (conn) void this.onMessage(conn, m);
    });
    ws.on('close', () => {
      if (!conn || this.conns.get(conn.hostId) !== conn) return;
      this.conns.delete(conn.hostId);
      for (const done of conn.pending.values()) done({ ok: false, error: 'host disconnected' });
      log.info(`host ${conn.hostId} disconnected`);
    });
    ws.on('error', (e) => log.warn('host socket', e.message));
  }

  private hello(ws: WebSocket, m: Extract<HostToGateway, { t: 'hello' }>): Conn {
    if (m.protocol !== PROTOCOL_VERSION) log.warn(`host ${m.hostId} speaks protocol ${m.protocol}, gateway ${PROTOCOL_VERSION}`);
    // A reconnect replaces the old socket of the same host.
    this.conns.get(m.hostId)?.ws.close(4001, 'replaced');
    const conn: Conn = { ws, hostId: m.hostId, version: m.version, pending: new Map() };
    this.conns.set(m.hostId, conn);
    this.send(conn, { t: 'welcome', protocol: PROTOCOL_VERSION, credentials: this.deps.credentials(), people: this.deps.store.people() });
    for (const r of m.sessions) this.deps.store.report(r, m.hostId);
    log.info(`host ${m.hostId} connected (${m.version}, ${m.sessions.length} sessions)`);
    void this.flush();
    return conn;
  }

  private async onMessage(conn: Conn, m: HostToGateway) {
    switch (m.t) {
      case 'session':
        return this.deps.store.report(m.report, conn.hostId);
      case 'workspace':
        this.workspaces.set(m.status.person, { ...m.status, at: Date.now() });
        return;
      case 'disk':
        return; // only a managed gateway can grow the host's disk (work 071)
      case 'token':
        try {
          return this.send(conn, { t: 'token', id: m.id, result: await this.deps.mintToken(m.repos) });
        } catch (e: any) {
          return this.send(conn, { t: 'token', id: m.id, error: e?.message ?? String(e) });
        }
      case 'spawn':
        try {
          if (!this.deps.spawn) throw new Error('Slack is not set up on the gateway');
          return this.send(conn, { t: 'spawned', id: m.id, result: await this.deps.spawn(m.from, m.req) });
        } catch (e: any) {
          log.warn(`spawn from ${m.from} failed:`, e?.data?.error ?? e?.message ?? e);
          return this.send(conn, { t: 'spawned', id: m.id, error: e?.data?.error ?? e?.message ?? String(e) });
        }
      case 'read':
      case 'post':
        try {
          if (!this.deps.readThread || !this.deps.postThread) throw new Error('Slack is not set up on the gateway');
          if (m.t === 'read') return this.send(conn, { t: 'thread', id: m.id, result: await this.deps.readThread(m.from, conn.hostId, m.req) });
          return this.send(conn, { t: 'posted', id: m.id, result: await this.deps.postThread(m.from, conn.hostId, m.req) });
        } catch (e) {
          log.warn(`${m.t} from ${m.from} failed:`, errorText(e));
          return this.send(conn, { t: m.t === 'read' ? 'thread' : 'posted', id: m.id, error: errorText(e) });
        }
      case 'preview':
      case 'unpreview':
        // Preview URLs (work 074) need the backend's tunnel per computer; this gateway has none.
        return this.send(conn, { t: 'previewed', id: m.id, error: 'preview URLs need an OpenComputer computer; this gateway does not offer them' });
      case 'secret-request':
        try {
          if (!this.deps.requestSecret) throw new Error('secrets are not set up on the gateway');
          await this.deps.requestSecret(m.from, m.req);
          return this.send(conn, { t: 'secret-asked', id: m.id });
        } catch (e) {
          log.warn(`secret request from ${m.from} failed:`, errorText(e));
          return this.send(conn, { t: 'secret-asked', id: m.id, error: errorText(e) });
        }
      case 'reply': {
        const done = conn.pending.get(m.id);
        conn.pending.delete(m.id);
        return done?.({ ok: m.ok, error: m.error });
      }
    }
  }

  private send(conn: Conn, m: GatewayToHost) {
    conn.ws.send(JSON.stringify(m));
  }

  private request(conn: Conn, m: Request): Promise<Reply> {
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        resolve({ ok: false, error: 'timeout' });
      }, REPLY_TIMEOUT_MS);
      conn.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.send(conn, { ...m, id } as GatewayToHost);
    });
  }

  /** The host recorded for the session if it is connected, else any connected host (one host for now). */
  private hostFor(key: string): Conn | undefined {
    const host = this.deps.store.session(key)?.host;
    return (host && this.conns.get(host)) || this.conns.values().next().value;
  }

  get connected() {
    return [...this.conns.keys()];
  }

  /** Deliver into a session, or queue it. `queued` means no host is connected. */
  async deliver(spec: SessionSpec, msg: Delivery): Promise<Reply | 'queued'> {
    const conn = this.hostFor(spec.key);
    if (!conn) return this.deps.store.enqueue({ t: 'deliver', key: spec.key, msg }), 'queued';
    this.deps.store.setHost(spec.key, conn.hostId);
    const session = this.deps.store.session(spec.key)?.spec ?? spec;
    return this.request(conn, { t: 'deliver', session, msg, ...this.secretsOf(session) });
  }

  private secretsOf(spec: SessionSpec): { secrets?: SessionSecret[] } {
    try {
      return this.deps.secretsFor ? { secrets: this.deps.secretsFor(spec) } : {};
    } catch (e) {
      log.warn(`secrets for ${spec.key}:`, errorText(e));
      return {};
    }
  }

  /**
   * Secrets changed: send the new set to every running session they apply to
   * (`owner` set: that person's sessions; `key` set: that session; neither: all).
   * Sessions without a runner get them with their next delivery.
   */
  pushSecrets(which: { key?: string; owner?: string } = {}) {
    let n = 0;
    for (const row of this.deps.store.liveSessions()) {
      if (which.key && row.spec.key !== which.key) continue;
      if (which.owner && row.spec.owner.slackUserId !== which.owner) continue;
      const conn = row.host ? this.conns.get(row.host) : undefined;
      const { secrets } = this.secretsOf(row.spec);
      if (!conn || !secrets) continue;
      this.send(conn, { t: 'secrets', sessionKey: row.spec.key, secrets });
      n++;
    }
    return n;
  }

  async action(key: string, promptId: string, value: string, userId: string): Promise<Reply | 'queued'> {
    const conn = this.hostFor(key);
    if (!conn) return this.deps.store.enqueue({ t: 'action', key, promptId, value, userId }), 'queued';
    return this.request(conn, { t: 'action', sessionKey: key, promptId, value, userId });
  }

  /** A stop has no meaning later, so it is not queued. */
  async stop(key: string): Promise<Reply> {
    const conn = this.hostFor(key);
    if (!conn) return { ok: false, error: 'no host connected' };
    return this.request(conn, { t: 'stop', sessionKey: key });
  }

  broadcast(m: Extract<GatewayToHost, { t: 'pushed' | 'people' }>) {
    for (const conn of this.conns.values()) this.send(conn, m);
  }

  /** Credentials changed (a fresh install, a new Claude token): push them; hosts forward them to their runners. */
  refreshCredentials() {
    const credentials = this.deps.credentials();
    for (const conn of this.conns.values()) this.send(conn, { t: 'credentials', credentials });
    if (this.conns.size) log.info(`credentials pushed to ${this.conns.size} host(s)`);
  }

  closeAll() {
    clearInterval(this.pinger);
    for (const ws of this.wss.clients) ws.close(1001, 'gateway restarting');
  }

  /** Replay the outbox, oldest first, against the session table as it is now. */
  private async flush() {
    const queued: Queued[] = this.deps.store.drain();
    for (const q of queued) {
      const row = this.deps.store.session(q.key);
      if (!row) continue;
      const r = q.t === 'deliver' ? await this.deliver(row.spec, q.msg) : await this.action(q.key, q.promptId, q.value, q.userId);
      if (r !== 'queued' && !r.ok) log.warn(`queued ${q.t} for ${q.key} failed: ${r.error}`);
    }
    if (queued.length) log.info(`flushed ${queued.length} queued message(s)`);
  }
}
