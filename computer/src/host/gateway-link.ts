// The host's link to the gateway (work 045): one WebSocket, dialled again
// after every close with jittered backoff, pinged every 25 s so a dead link
// is noticed within two pings (proxies in front of the gateway drop idle
// connections at 30 s). Knows nothing of the messages: `hello` is what the
// host says on open, `message` is where every parsed frame goes.
//
// Invariants:
// - `send` drops a message while the link is not open: deliveries are the
//   gateway's to retry, and a reply to a gone gateway is moot.
// - `redial` drops the link now rather than waiting for a close handshake
//   (~11 s on the preview) and dials again within 200 ms: for a new identity
//   (`assign`) or a changed hello (subscriptions.ts).
// - `url` and `token` are asked at every dial, so an `assign` saved before a
//   redial is what the next dial uses.

import WebSocket from 'ws';
import type { GatewayToHost, HostToGateway } from '../protocol.js';
import { log } from '../log.js';

export interface LinkHooks {
  url(): string;
  token(): string;
  hello(): Extract<HostToGateway, { t: 'hello' }>;
  message(m: GatewayToHost): void;
}

export interface GatewayLink {
  /** A socket is open and not yet closed (`send` reaches the gateway, or the close is under way). */
  readonly connected: boolean;
  /** Open right now, for `host.sample`. */
  readonly open: boolean;
  /** When the last frame (message or pong) came in; 0 before any. */
  readonly seenAt: number;
  /** Bytes sent but not yet written to the network (the mirror waits on it: api-bridge.ts). */
  readonly buffered: number;
  send(m: HostToGateway): void;
  /** A request that waits for an answer: sent, or false while the link is not connected (tokens.ts, previews.ts). */
  ask(m: HostToGateway): boolean;
  dial(): void;
  redial(): void;
}

const PING_MS = 25_000;
const MAX_BACKOFF_MS = 30_000;

export function gatewayLink(hooks: LinkHooks, connect = (url: string, token: string) => new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } })): GatewayLink {
  let ws: WebSocket | undefined;
  let backoff = 1000;
  let seenAt = 0;

  function dial() {
    const url = hooks.url();
    const sock = connect(url, hooks.token());
    let alive = true;
    const ping = setInterval(() => {
      if (!alive) return sock.terminate();
      alive = false;
      sock.ping();
    }, PING_MS);
    sock.on('pong', () => {
      alive = true;
      seenAt = Date.now();
    });
    sock.on('open', () => {
      ws = sock;
      backoff = 1000;
      const hello = hooks.hello();
      log.info(`connected to ${url} as ${hello.hostId}`);
      send(hello);
    });
    sock.on('message', (d) => {
      seenAt = Date.now();
      let m: GatewayToHost;
      try {
        m = JSON.parse(String(d));
      } catch {
        return;
      }
      hooks.message(m);
    });
    sock.on('error', (e) => log.warn('gateway link:', e.message));
    sock.on('close', () => {
      clearInterval(ping);
      if (ws === sock) ws = undefined;
      const wait = backoff * (0.75 + Math.random() / 2);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      setTimeout(dial, wait);
    });
  }

  function send(m: HostToGateway) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  }

  return {
    get connected() {
      return !!ws;
    },
    get open() {
      return ws?.readyState === WebSocket.OPEN;
    },
    get seenAt() {
      return seenAt;
    },
    get buffered() {
      return ws?.bufferedAmount ?? 0;
    },
    send,
    ask(m) {
      if (!ws) return false;
      send(m);
      return true;
    },
    dial,
    redial() {
      backoff = 200;
      ws?.terminate();
    },
  };
}
