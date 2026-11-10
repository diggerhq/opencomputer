// A unix socket that takes exactly one connection (work 084): how a `/files`
// transfer's bytes move between the host and the relay, beside wire.sock's
// JSON lines. The host creates it, sends its path in the call's `result`, and
// the relay dials it once.
//
// Invariants: the socket file is 0660 and, given `group`, belongs to it (the
// relay's sp-wire); it is removed as soon as the connection arrives, or after
// `timeoutMs` without one (the promise then rejects); a second dialler is
// never served.

import { randomBytes } from 'node:crypto';
import { chmodSync, chownSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export interface OneShot {
  socket: string;
  /** The relay's connection; rejects when nobody dials within the timeout. */
  connection: Promise<net.Socket>;
  cancel(): void;
}

export function oneShotSocket(dir: string, group?: number, timeoutMs = 30_000): Promise<OneShot> {
  const socket = path.join(dir, `${randomBytes(12).toString('hex')}.sock`);
  const server = net.createServer();
  let timer: NodeJS.Timeout | undefined;
  const cleanup = () => {
    clearTimeout(timer);
    server.close();
    rmSync(socket, { force: true });
  };
  const connection = new Promise<net.Socket>((resolve, reject) => {
    server.once('connection', (s) => {
      cleanup();
      resolve(s);
    });
    timer = setTimeout(() => {
      cleanup();
      reject(new Error('nobody connected'));
    }, timeoutMs);
    timer.unref?.();
  });
  connection.catch(() => {});
  return new Promise((resolve, reject) => {
    server.once('error', (e) => {
      cleanup();
      reject(e);
    });
    server.listen(socket, () => {
      try {
        chmodSync(socket, 0o660);
        if (group !== undefined) chownSync(socket, -1, group);
      } catch (e) {
        cleanup();
        return reject(e);
      }
      resolve({ socket, connection, cancel: cleanup });
    });
  });
}
