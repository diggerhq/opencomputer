// Newline-delimited JSON over unix sockets (host ⇄ runner, helpers → host),
// and where a runner's sockets and files live below a run root. The layout
// below a root is the same for every root; nothing here reads the environment.

import type { Socket } from 'node:net';
import path from 'node:path';
import { RUNNER_TOKEN_DIR } from './protocol.js';
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

/** The directory a runner sees as SP_RUN: HOST_RUN itself, or its own under HOST_RUN/sandbox (work 103). */
export type RunRoot = string;
export const runnersDir = (run: RunRoot) => path.join(run, 'runners');
/** The run root of the runner `id` in a container (work 103): its own directory, mounted at the same path inside. */
export const sandboxRunFor = (hostRun: string, id: string): RunRoot => path.join(hostRun, 'sandbox', id);

/**
 * <run>/runners/<name>.sock, a `.pid` file next to it. The name is the
 * runner's id (work 069), or `keyName` of its session for runners started by
 * hosts before; the runner's first report says which session it serves.
 */
export const socketFor = (run: RunRoot, name: string) => path.join(runnersDir(run), `${name}.sock`);
/** Where a runner's previews are dialed from outside its network namespace (work 103); nothing listens there yet. */
export const previewSocketFor = (run: RunRoot, name: string) => path.join(runnersDir(run), `${name}.preview.sock`);
/** A runner's own token socket (host/tokens.ts, work 080): the host knows the session from which one is asked. */
export const tokenSocketFor = (run: RunRoot, id: string) => path.join(run, RUNNER_TOKEN_DIR, `${id}.sock`);
/** A runner's secrets (runner/session-secrets.ts), named as its socket. */
export const secretsFor = (run: RunRoot, id: string) => path.join(run, 'secrets', id);
/** A session key as a file name: runners before work 069, and the session's trace file. */
export const keyName = (key: string) => Buffer.from(key).toString('base64url');
export const pidFileFor = (socket: string) => socket.replace(/\.sock$/, '.pid');
