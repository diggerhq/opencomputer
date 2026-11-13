// The host's end of the model proxy's control socket (work 097, design C1
// and C3; computer/modelproxy/README.md is the protocol): one connection,
// dialled again after every close, that carries binds and releases out and
// answers, reports and telemetry in. It keeps no bindings itself: on every
// `hello` it asks `hooks.hello` to re-send them, then says `synced`.
//
// Invariants:
// - Up means connected and a `hello` received. A connection with no `hello`
//   within 5 s, or a bind with no answer within 5 s, is dropped as down; so
//   is any close. Reconnect backoff is 250 ms, doubling to 5 s, reset by a hello.
// - Nothing here logs a frame: binds and requests carry variables.
// - Every promise settles: a bind with its answer, `proxy_unavailable` while
//   down or when the connection goes, `timeout` past 5 s; a request with the
//   proxy's response, `proxy_unavailable`, or `timeout` past 20 s.

import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { lines, send } from '../ipc.js';
import type { ModelObserved, ModelProfile, ModelRequest, ModelResponse } from '../protocol.js';

export interface ProxyHello {
  version: string;
  protocol: number;
  /** What runners send as their credential. */
  placeholder: string;
  profiles: ModelProfile[];
  /** Every binding the proxy holds. */
  bindings: { caller: string; sessionKey: string; mode: string; profile?: string; key?: string }[];
}

/** A bind as the host sends it, without its `id`. */
export type ProxyBind = { caller: string; sessionKey: string } & (
  | { profile: string; vars: Record<string, string>; key: string }
  | { mode: 'refuse'; reason: string }
);

export interface ProxyEvent {
  name: string;
  at: number;
  outcome?: string;
  duration_ms?: number;
  error_type?: string;
  session_key?: string;
  profile?: string;
  data?: Record<string, unknown>;
}

/** A bind's answer: `code` is the proxy's refusal code, `proxy_unavailable` or `timeout`. */
export type BindAnswer = { bound: true; key?: string } | { bound: false; code: string };

export interface ProxyHooks {
  /** A hello arrived (the client is up): re-send every bind now; `synced` follows. */
  hello(h: ProxyHello): void;
  /** Up or down changed. */
  changed(up: boolean): void;
  observed(m: ModelObserved & { caller: string }): void;
  event(e: ProxyEvent): void;
}

export interface ModelProxy {
  readonly up: boolean;
  /** The last hello, kept while down (its profiles and placeholder still describe live runners). */
  readonly hello: ProxyHello | undefined;
  /** When it went down; undefined while up. */
  readonly downSince: number | undefined;
  bind(b: ProxyBind): Promise<BindAnswer>;
  release(caller: string): void;
  request(m: ModelRequest): Promise<ModelResponse>;
  stop(): void;
}

export interface ProxyOptions {
  connect?: (path: string) => net.Socket;
  helloMs?: number;
  bindMs?: number;
  requestMs?: number;
  now?: () => number;
}

type In =
  | ({ t: 'hello' } & ProxyHello)
  | { t: 'bound'; id?: string; caller: string; sessionKey: string; key?: string }
  | { t: 'refused'; id?: string; caller: string; code: string; message: string }
  | ({ t: 'observed'; caller: string } & ModelObserved)
  | ({ t: 'response' } & ModelResponse)
  | ({ t: 'event' } & ProxyEvent);

/** Dial `path` and keep dialling; `path` undefined (SP_MODEL_PROXY unset): never up. */
export function modelProxy(path: string | undefined, hooks: ProxyHooks, o: ProxyOptions = {}): ModelProxy {
  const now = o.now ?? Date.now;
  const binds = new Map<string, (a: BindAnswer) => void>();
  const requests = new Map<string, (r: ModelResponse) => void>();
  let sock: net.Socket | undefined;
  let hello: ProxyHello | undefined;
  let up = false;
  let downSince: number | undefined = now();
  let stopped = false;
  let backoff = 250;

  const settleAll = () => {
    for (const [id, done] of binds) done({ bound: false, code: 'proxy_unavailable' }), binds.delete(id);
    for (const [id, done] of requests) done({ id, error: 'proxy_unavailable' }), requests.delete(id);
  };

  const dial = () => {
    if (stopped || !path) return;
    const s = (o.connect ?? ((p) => net.createConnection(p)))(path);
    sock = s;
    const helloTimer = setTimeout(() => s.destroy(), o.helloMs ?? 5000);
    helloTimer.unref();
    s.on('error', () => {});
    s.on('close', () => {
      clearTimeout(helloTimer);
      if (sock !== s) return;
      sock = undefined;
      settleAll();
      if (up) (up = false), (downSince = now()), hooks.changed(false);
      if (stopped) return;
      setTimeout(dial, backoff).unref();
      backoff = Math.min(backoff * 2, 5000);
    });
    lines(s, (m: In) => {
      if (sock !== s) return;
      switch (m.t) {
        case 'hello': {
          clearTimeout(helloTimer);
          backoff = 250;
          hello = { version: m.version, protocol: m.protocol, placeholder: m.placeholder, profiles: m.profiles ?? [], bindings: m.bindings ?? [] };
          const was = up;
          (up = true), (downSince = undefined);
          hooks.hello(hello);
          send(s, { t: 'synced' });
          if (!was) hooks.changed(true);
          return;
        }
        case 'bound':
          return m.id && binds.get(m.id)?.({ bound: true, key: m.key });
        case 'refused':
          return m.id && binds.get(m.id)?.({ bound: false, code: m.code });
        case 'response':
          return requests.get(m.id)?.({ id: m.id, status: m.status, headers: m.headers, body: m.body, error: m.error });
        case 'observed':
        case 'event': {
          const { t, ...rest } = m;
          return t === 'observed' ? hooks.observed(rest as ModelObserved & { caller: string }) : hooks.event(rest as ProxyEvent);
        }
      }
    });
  };
  dial();

  return {
    get up() {
      return up;
    },
    get hello() {
      return hello;
    },
    get downSince() {
      return downSince;
    },
    bind(b) {
      if (!up) return Promise.resolve({ bound: false, code: 'proxy_unavailable' });
      const id = randomUUID();
      const s = sock;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          binds.delete(id);
          resolve({ bound: false, code: 'timeout' });
          s?.destroy(); // no answer in time: down, and the next hello re-sends every bind
        }, o.bindMs ?? 5000);
        timer.unref();
        binds.set(id, (a) => (clearTimeout(timer), binds.delete(id), resolve(a)));
        send(s, { t: 'bind', id, ...b });
      });
    },
    release(caller) {
      if (up) send(sock, { t: 'release', caller });
    },
    request(m) {
      if (!up) return Promise.resolve({ id: m.id, error: 'proxy_unavailable' });
      return new Promise((resolve) => {
        const timer = setTimeout(() => (requests.delete(m.id), resolve({ id: m.id, error: 'timeout' })), o.requestMs ?? 20_000);
        timer.unref();
        requests.set(m.id, (r) => (clearTimeout(timer), requests.delete(m.id), resolve(r)));
        send(sock, { t: 'request', ...m });
      });
    },
    stop() {
      stopped = true;
      sock?.destroy();
    },
  };
}
