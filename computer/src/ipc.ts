// Newline-delimited JSON over unix sockets (host ⇄ runner, helpers → host),
// and where runner sockets live on a host.

import type { Socket } from 'node:net';
import path from 'node:path';
import { HOST_RUN } from './protocol.js';
import { log } from './log.js';

/** Call `on` with every JSON line arriving on `sock`. */
export function lines(sock: Socket, on: (m: any) => unknown) {
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (d: string) => {
    buf += d;
    for (let i: number; (i = buf.indexOf('\n')) >= 0; ) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!l.trim()) continue;
      let m: { t?: string };
      try {
        m = JSON.parse(l);
      } catch {
        log.warn('bad json line', l.slice(0, 120));
        continue;
      }
      Promise.resolve()
        .then(() => on(m))
        .catch((e) => log.error('handler', m?.t, e));
    }
  });
}

export function send(sock: Socket | undefined, m: object) {
  if (sock && !sock.destroyed && sock.writable) sock.write(JSON.stringify(m) + '\n');
}

export const RUNNERS_DIR = path.join(HOST_RUN, 'runners');

/**
 * <SP_RUN>/runners/<name>.sock, a `.pid` file next to it. The name is the
 * runner's id (work 069), or `keyName` of its session for runners started by
 * hosts before; the runner's first report says which session it serves.
 */
export const socketFor = (name: string) => path.join(RUNNERS_DIR, `${name}.sock`);
/** A session key as a file name: runners before work 069, and the session's trace file. */
export const keyName = (key: string) => Buffer.from(key).toString('base64url');
export const pidFileFor = (socket: string) => socket.replace(/\.sock$/, '.pid');
