// cloudflared under the host (work 074): the tunnel that carries this
// computer's previews runs as the host's child, started from the token in the
// gateway's `welcome` and restarted on exit with backoff.
//
// Invariants: the token lives in this process's memory and in the child's
// environment (TUNNEL_TOKEN) only, never on disk, argv or in a log line; the
// child is restarted only when the token changes (a `previews` frame that
// only changes ports leaves it alone); no token, no child. The child gets a
// minimal environment, not the host's (which holds the host token).

import { type ChildProcess, spawn } from 'node:child_process';
import { log } from '../log.js';

export const CLOUDFLARED_ARGS = ['tunnel', '--no-autoupdate', 'run'];
const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
/** A child that ran this long was healthy: the next restart starts from the minimum wait again. */
const HEALTHY_MS = 60_000;

export interface Cloudflared {
  /** Run with this token, or stop with none; the same token again changes nothing. */
  set(token: string | undefined): void;
  stop(): void;
  readonly running: boolean;
}

export function cloudflared(o: { command?: string; env?: NodeJS.ProcessEnv } = {}): Cloudflared {
  const command = o.command ?? 'cloudflared';
  const base = o.env ?? process.env;
  let token: string | undefined;
  let child: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  let backoff = MIN_BACKOFF_MS;

  function start() {
    timer = undefined;
    if (!token) return;
    const env = { PATH: base.PATH, HOME: base.HOME, TUNNEL_TOKEN: token };
    const c = spawn(command, CLOUDFLARED_ARGS, { env, stdio: ['ignore', 'ignore', 'pipe'] });
    const at = Date.now();
    child = c;
    let tail = '';
    c.stderr?.setEncoding('utf8').on('data', (d: string) => (tail = (tail + d).slice(-2000)));
    c.on('error', (e: NodeJS.ErrnoException) => log.warn(`cloudflared: ${e.code === 'ENOENT' ? `${command} is not installed` : e.message}`));
    c.on('close', (code, signal) => {
      if (child !== c) return; // replaced or stopped on purpose
      child = undefined;
      if (Date.now() - at >= HEALTHY_MS) backoff = MIN_BACKOFF_MS;
      const last = tail.trim().split('\n').pop()?.slice(0, 300);
      log.warn(`cloudflared exited (${signal ?? code}); restarting in ${Math.round(backoff / 1000)} s${last ? `; last: ${last}` : ''}`);
      timer = setTimeout(start, backoff);
      timer.unref();
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    });
    log.info('cloudflared started');
  }

  function halt() {
    if (timer) clearTimeout(timer), (timer = undefined);
    const c = child;
    child = undefined;
    c?.kill('SIGTERM');
  }

  return {
    set(next) {
      if (next === token) return;
      token = next;
      halt();
      backoff = MIN_BACKOFF_MS;
      if (token) start();
      else log.info('cloudflared stopped: no preview config');
    },
    stop() {
      token = undefined;
      halt();
    },
    get running() {
      return !!child;
    },
  };
}
