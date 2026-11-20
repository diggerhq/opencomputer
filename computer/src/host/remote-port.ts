// A session's writer over its API socket (work 084): a runner's
// `<id>.api.sock`, as the api-bridge uses it (a WriterPort).
//
// Invariants:
// - Calls share one connection, dialled on first use and again after it
//   closes; each mirror subscription has a connection of its own (the socket
//   protocol allows one subscribe per connection).
// - A subscription whose connection closes is detached as `moved` exactly
//   once (the writer exited or handed its journal on), so the bridge follows
//   whichever writes next.
// - A runner listens on its API socket a moment after its control socket:
//   dialling retries for up to `dialMs`.
// - The socket is in a directory its session can write: it is connected to
//   as the runner's control socket is (checked-socket.ts), never plainly.

import { type ApiClient, dialApi } from '../api/socket.js';
import type { WriterPort } from './api-bridge.js';
import { type SocketCheck, connectChecked } from './checked-socket.js';

export type Dial = (path: string, token: string) => Promise<ApiClient>;

/** `dialApi` for a runner's API socket: only a socket (of `check.uid`, when given), and the very file that was checked. */
export const checkedDial = (check: SocketCheck = {}): Dial => (path, token) => dialApi(path, token, (p) => connectChecked(p, check));

export function remotePort(socket: string, token: string, o: { dial?: Dial; dialMs?: number } = {}): WriterPort & { close(): void } {
  const dial = o.dial ?? checkedDial();
  const dialMs = o.dialMs ?? 10_000;
  let shared: Promise<ApiClient> | undefined;
  const subs = new Set<ApiClient>();
  let closed = false;

  async function connect(): Promise<ApiClient> {
    for (const end = Date.now() + dialMs; ; ) {
      try {
        return await dial(socket, token);
      } catch (e) {
        if (closed || Date.now() >= end) throw e;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  }

  function client() {
    if (!shared) {
      const p = connect();
      shared = p;
      p.then(
        (c) => void c.closed.then(() => shared === p && (shared = undefined)),
        () => shared === p && (shared = undefined),
      );
    }
    return shared;
  }

  return {
    async call(method, params, ctx) {
      return (await client()).call(method, params, ctx);
    },
    async subscribe(so) {
      const c = await connect();
      subs.add(c);
      let done = false;
      const detached = (reason: Parameters<typeof so.onDetached>[0]) => {
        if (done) return;
        done = true;
        subs.delete(c);
        c.close();
        so.onDetached(reason);
      };
      const r = await c.subscribe({ ...so, onDetached: detached });
      if ('error' in r) {
        done = true;
        subs.delete(c);
        c.close();
        return r;
      }
      void c.closed.then(() => detached('moved'));
      return {
        attached: r.attached,
        ack: (seq) => c.ack(seq),
        close() {
          done = true;
          subs.delete(c);
          c.close();
        },
      };
    },
    close() {
      closed = true;
      void shared?.then((c) => c.close(), () => {});
      for (const c of subs) c.close();
      subs.clear();
    },
  };
}
