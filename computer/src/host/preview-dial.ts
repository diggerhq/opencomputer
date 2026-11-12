// How the preview proxy and the listen probe reach a previewed port (work
// 103, seam S3). Both take a Dialer, so where the port lives is decided in one
// place: this machine's loopback for a runner that shares it (`detached`), the
// runner's preview socket for one in a container (C9; the other end is
// src/runner/preview-socket.ts).
//
// Invariants:
// - A Dialer returns its connection at once and never throws; the connection
//   emits `connect`, or `error` with code ECONNREFUSED when nothing listens on
//   the port.
// - The proxy keeps connections alive through an http.Agent, which calls a
//   socket's setKeepAlive, setTimeout, ref and unref on them: a Dialer whose
//   connection is not a net.Socket provides those.
// - The preview socket is in a directory its session can write: it is
//   connected to only when `lstat` says it is a socket, and what it answers is
//   believed only as far as `ok`: every other answer, or none, is "nothing
//   listens".

import net from 'node:net';
import { lstatSync } from 'node:fs';
import { Duplex } from 'node:stream';
import { type RunRoot, previewSocketFor } from '../ipc.js';

/** A connection to this port for http.request's `createConnection`: returned at once, emits `connect` or `error` (code ECONNREFUSED when nothing listens). */
export type Dialer = (port: number) => Duplex;

/** The port on this machine, over IPv4 loopback, as http.request itself would connect. */
export const loopbackDialer: Dialer = (port) => net.connect({ host: '127.0.0.1', port, noDelay: true });

const refused = (why: string) => Object.assign(new Error(`connect ECONNREFUSED ${why}`), { code: 'ECONNREFUSED', errno: -111, syscall: 'connect' });

/** The connection of a port nothing can listen on: ECONNREFUSED, as every Dialer reports one. */
export const nothingListens: Dialer = (port) => {
  const out = new Duplex({ read() {}, write: (_c, _e, cb) => cb() });
  process.nextTick(() => out.destroy(refused(`:${port}`)));
  return out;
};
const OK = 'ok\n';

/**
 * The port inside the container of sandbox `id`, through its runner's preview socket below `run`. The runner
 * connects to its own loopback and answers `ok`; a port it never previewed, a closed one and a runner that is not
 * there are all ECONNREFUSED.
 */
export function sandboxDialer(run: RunRoot, id: string): Dialer {
  const socketPath = previewSocketFor(run, id);
  return (port) => {
    let sock: net.Socket | undefined;
    let ready = false;
    let head = Buffer.alloc(0);
    const held: (() => void)[] = [];
    const whenReady = (f: () => void) => (ready ? f() : void held.push(f));
    const out: Duplex & { connecting?: boolean } = new Duplex({
      read: () => void sock?.resume(),
      write: (chunk, _enc, cb) => whenReady(() => sock?.write(chunk, cb)),
      final: (cb) => whenReady(() => (sock ? sock.end(cb) : cb())),
      destroy: (err, cb) => (sock?.destroy(), cb(err)),
    });
    out.connecting = true;
    const fail = (why: string) => out.destroyed || out.destroy(refused(why));
    try {
      if (!lstatSync(socketPath).isSocket()) throw new Error('not a socket');
      sock = net.connect(socketPath);
    } catch {
      process.nextTick(fail, `${socketPath} (no preview socket)`);
    }
    // What an http.Agent and http.request call on a socket.
    Object.assign(out, {
      setKeepAlive: () => out,
      setNoDelay: () => out,
      setTimeout: (ms: number, cb?: () => void) => (cb && out.once('timeout', cb), sock?.setTimeout(ms), out),
      ref: () => (sock?.ref(), out),
      unref: () => (sock?.unref(), out),
    });
    if (!sock) return out;
    const s = sock;
    s.on('timeout', () => out.emit('timeout'));
    s.on('connect', () => s.write(`${port}\n`));
    s.on('data', (d: Buffer) => {
      if (ready) return void (out.push(d) || s.pause());
      head = Buffer.concat([head, d]);
      if (head.length < OK.length && OK.startsWith(head.toString('latin1'))) return;
      if (head.subarray(0, OK.length).toString('latin1') !== OK) return void fail(`${id}:${port}`);
      ready = true;
      out.connecting = false;
      const rest = head.subarray(OK.length);
      out.emit('connect');
      if (rest.length && !out.push(rest)) s.pause();
      for (const f of held.splice(0)) f();
    });
    let ended = false;
    s.on('end', () => (ready ? ((ended = true), void out.push(null)) : void fail(`${id}:${port}`)));
    s.on('error', (e) => (ready ? out.destroy(e) : void fail(`${id}:${port}`)));
    s.on('close', () => {
      if (!ready) return void fail(`${id}:${port}`);
      // After a clean end, what was pushed is read first.
      if (ended && !out.readableEnded) out.once('end', () => out.destroy());
      else if (!out.destroyed) out.destroy();
    });
    return out;
  };
}
