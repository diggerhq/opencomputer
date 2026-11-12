// The runner's preview socket (work 103, C9): how the host reaches a server
// this session previews when the session runs in a container, whose loopback
// the host cannot dial. The host connects to SP_PREVIEW_SOCKET and writes one
// line, the port in decimal and `\n` (6 bytes at most). For a port this
// runner asked a preview of, the runner connects to 127.0.0.1:<port> and
// answers `ok\n`, then carries bytes both ways until either side ends; when
// nothing listens there it answers `closed\n` and ends.
//
// Invariants:
// - A port is reachable only between this runner's `preview` request for it
//   and an `unpreview` of its name (or the request's failure): for any other
//   port, and for anything that is not a port line, the connection ends
//   without a reply. So the socket is no way into the session's other
//   listeners, whoever connects to it.
// - The set of ports is this process's memory: a runner that starts again
//   serves none until its session calls `preview` again.
// - Without SP_PREVIEW_SOCKET (a runner outside a container) nothing listens
//   and the hooks pass through unchanged.

import net from 'node:net';
import { chmodSync, rmSync } from 'node:fs';
import { log } from '../log.js';
import type { PreviewHooks } from './preview.js';

/** `65535\n`. */
const LINE_MAX = 6;
/** How long a connection has to send its line. */
const LINE_WAIT_MS = 5000;

export interface PreviewGate {
  allow(port: number): void;
  revoke(port: number): void;
  allowed(port: number): boolean;
  server: net.Server;
}

/** The port a line names, or undefined: digits only, 1 to 65535. */
export function portOf(line: string): number | undefined {
  if (!/^[1-9]\d{0,4}$/.test(line)) return undefined;
  const n = Number(line);
  return n <= 65535 ? n : undefined;
}

/** Listen on `socketPath` (0660: the host is in the socket's group). `connect`: tests pass their own. */
export function previewSocket(socketPath: string, connect: (port: number) => net.Socket = (port) => net.connect({ host: '127.0.0.1', port, noDelay: true })): PreviewGate {
  const ports = new Set<number>();
  const server = net.createServer((c) => {
    c.on('error', () => {});
    let head = Buffer.alloc(0);
    const timer = setTimeout(() => c.destroy(), LINE_WAIT_MS);
    const onData = (d: Buffer) => {
      head = Buffer.concat([head, d]);
      const nl = head.indexOf(0x0a);
      if (nl < 0 && head.length < LINE_MAX) return;
      clearTimeout(timer);
      c.off('data', onData);
      c.pause();
      const port = nl >= 0 && nl < LINE_MAX ? portOf(head.subarray(0, nl).toString('latin1')) : undefined;
      if (port === undefined || !ports.has(port)) return void c.end();
      const rest = head.subarray(nl + 1);
      const up = connect(port);
      let connected = false;
      up.once('connect', () => {
        connected = true;
        c.write('ok\n');
        if (rest.length) up.write(rest);
        up.on('error', () => c.destroy());
        c.on('error', () => up.destroy());
        c.on('close', () => up.destroy());
        up.on('close', () => c.destroy());
        up.pipe(c).pipe(up);
      });
      up.once('error', () => {
        if (!connected) c.end('closed\n');
      });
    };
    c.on('data', onData);
    c.on('close', () => clearTimeout(timer));
  });
  server.on('error', (e) => log.error(`preview socket ${socketPath}: ${e.message}`));
  rmSync(socketPath, { force: true });
  server.listen(socketPath, () => chmodSync(socketPath, 0o660));
  server.unref();
  return { allow: (p) => void ports.add(p), revoke: (p) => void ports.delete(p), allowed: (p) => ports.has(p), server };
}

/**
 * `hooks`, opening a port on the gate when its preview is asked for (the host probes it before it answers) and
 * closing it when the request fails or its name is unpreviewed.
 */
export function gatedPreviews(hooks: PreviewHooks, gate: Pick<PreviewGate, 'allow' | 'revoke' | 'allowed'>): PreviewHooks {
  const names = new Map<string, number>();
  return {
    async preview(req) {
      const had = gate.allowed(req.port);
      gate.allow(req.port);
      try {
        const r = await hooks.preview(req);
        for (const [n, p] of names) if (p === req.port) names.delete(n); // a port has one name
        names.set(r.name, req.port);
        return r;
      } catch (e) {
        if (!had) gate.revoke(req.port);
        throw e;
      }
    },
    async unpreview(name) {
      await hooks.unpreview(name);
      const port = names.get(name);
      names.delete(name);
      if (port !== undefined) gate.revoke(port);
    },
  };
}

/** The hooks a runner uses: gated behind a preview socket at `socketPath`, or `hooks` itself without one. */
export const servedPreviews = (socketPath: string | undefined, hooks: PreviewHooks): PreviewHooks =>
  socketPath ? gatedPreviews(hooks, previewSocket(socketPath)) : hooks;
