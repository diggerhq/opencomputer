// Newline-delimited JSON on a unix socket, for the relay's two local peers
// (the host's wire.sock and a session writer's api.sock). Unlike ipc.ts's
// `lines`, it bounds a line, keeps bytes until a newline (no per-chunk string
// decode of half a character), and lets the caller pause the socket, which is
// how replay is paced by the client's reading.
//
// Invariants: a line longer than `maxLine` destroys the socket (the peer is
// broken, not slow); a line that is not JSON is dropped with a warning; the
// handler runs synchronously, in arrival order.

import type { Socket } from 'node:net';
import { log } from '../log.js';

export function ndjson(sock: Socket, maxLine: number, on: (m: unknown) => void) {
  let parts: Buffer[] = [];
  let held = 0;
  sock.on('data', (chunk: Buffer) => {
    let start = 0;
    for (let i = chunk.indexOf(10); i >= 0; i = chunk.indexOf(10, start)) {
      let line: Buffer;
      if (held) {
        parts.push(chunk.subarray(start, i));
        line = Buffer.concat(parts, held + i - start);
        parts = [];
        held = 0;
      } else line = chunk.subarray(start, i);
      start = i + 1;
      if (line.length > maxLine) return sock.destroy(new Error(`line over ${maxLine} bytes`));
      if (line.length === 0) continue;
      let m: unknown;
      try {
        m = JSON.parse(line.toString('utf8'));
      } catch {
        log.warn('wire: bad json line', line.subarray(0, 120).toString('utf8'));
        continue;
      }
      on(m);
      if (sock.destroyed) return;
    }
    if (start < chunk.length) {
      held += chunk.length - start;
      if (held > maxLine) return sock.destroy(new Error(`line over ${maxLine} bytes`));
      parts.push(chunk.subarray(start));
    }
  });
}

export function writeLine(sock: Socket | undefined, m: object): boolean {
  if (!sock || sock.destroyed || !sock.writable) return false;
  return sock.write(JSON.stringify(m) + '\n');
}
