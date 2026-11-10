// The host's connections to runner processes, below adoption: dial a runner's
// socket, launch a runner and wait for it to listen, find the runners still
// listening after a host restart, and wait for one to go. host/main.ts decides
// what each connection is for (adoption.ts).
//
// Invariant: a socket nobody listens on after a restart is the trace of a
// runner that died; it is removed with its pid file, calvin-send-file socket,
// API socket (work 084) and secrets, so nothing of it outlives it. API
// sockets (`*.api.sock`) are never taken for runners.

import net from 'node:net';
import path from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { HOST_RUN, type HostToRunner, type RunnerSpec } from '../protocol.js';
import { RUNNERS_DIR, pidFileFor, send } from '../ipc.js';
import { log } from '../log.js';
import type { Telemetry } from '../telemetry/emitter.js';
import type { Dimensions } from '../telemetry/envelope.js';
import { launch } from './launch.js';
import { pollReady } from './cold-start.js';
import { rm } from '../workspaces/as-runner.js';
import { API_SOCK } from './runner-api.js';

/** Open a connection to a runner's socket; rejects if nothing listens there. */
export function dialRunner(socket: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socket);
    sock.once('error', reject);
    sock.once('connect', () => {
      sock.off('error', reject);
      sock.on('error', (e) => log.warn('runner socket', path.basename(socket), e.message));
      resolve(sock);
    });
  });
}

/** Launch a runner (`runner.launched`) and connect to it once it listens (`runner.ready`). */
export async function launchRunner(rs: RunnerSpec, o: { tm: Telemetry; mode: string; env: NodeJS.ProcessEnv; root: string; f?: Dimensions }) {
  const { tm, f = {} } = o;
  const t0 = Date.now();
  const launched = tm.start('runner.launched', { ...f, data: { launch_mode: o.mode } });
  await launch(rs, o.mode, o.env, o.root).catch((e) => {
    launched.end({ outcome: 'failed', error_type: 'launch' });
    throw e;
  });
  launched.end({ outcome: 'completed' });
  const { value: sock, polls } = await pollReady(() => dialRunner(rs.socket).catch(() => undefined));
  if (!sock) {
    tm.emit('runner.ready', { ...f, outcome: 'timed_out', error_type: 'launch', duration_ms: Date.now() - t0, data: { polls } });
    throw new Error('runner did not start within 30 s');
  }
  const launchMs = Date.now() - t0;
  log.info(`runner ${rs.id} up for ${rs.session?.key ?? 'the pool'} in ${launchMs} ms`);
  tm.emit('runner.ready', { ...f, duration_ms: launchMs, data: { polls } });
  return sock;
}

/**
 * After a restart: connect to every runner still listening and hand it to `adopt` (by its socket's
 * name); clear what the dead ones left. Resolves with the names of the runners adopted.
 */
// The sessions' user can create anything in runners/ (a directory named like a socket, say): never the host's problem.
function drop(p: string) {
  try {
    rmSync(p, { force: true });
  } catch (e: any) {
    log.warn(`${p} not removed: ${e?.message ?? e}`);
  }
}

export async function rediscover(adopt: (id: string, sock: net.Socket) => Promise<unknown>) {
  mkdirSync(RUNNERS_DIR, { recursive: true });
  const live = new Set<string>();
  const names = readdirSync(RUNNERS_DIR);
  // Work 084: API sockets (runner-api.ts) are not runners: a runner's goes with it; the previous host's session-writers' all go.
  for (const f of names.filter((f) => f.endsWith(API_SOCK) && !names.includes(f.replace(API_SOCK, '.sock')))) drop(path.join(RUNNERS_DIR, f));
  for (const f of names.filter((f) => f.endsWith('.sock') && !f.endsWith(API_SOCK))) {
    const id = f.replace(/\.sock$/, '');
    await dialRunner(path.join(RUNNERS_DIR, f))
      .then((sock) => adopt(id, sock))
      .then(
        () => live.add(id),
        () => {
          drop(path.join(RUNNERS_DIR, f));
          drop(pidFileFor(path.join(RUNNERS_DIR, f)));
          drop(path.join(RUNNERS_DIR, f.replace(/\.sock$/, '.files'))); // calvin-send-file's socket
          drop(path.join(RUNNERS_DIR, `${id}${API_SOCK}`));
        },
      );
  }
  // A runner that was killed outright left its secrets behind (session-secrets.ts), named as its socket.
  // They are the runners' user's (0700), so removed as that user; one left behind never stops the host.
  const secretsDir = path.join(HOST_RUN, 'secrets');
  let left: string[] = [];
  try {
    left = existsSync(secretsDir) ? readdirSync(secretsDir) : [];
  } catch (e: any) {
    log.warn(`cannot list ${secretsDir}: ${e?.message ?? e}`);
  }
  for (const d of left.filter((d) => !live.has(d)))
    await rm(path.join(secretsDir, d)).catch((e) => log.warn(`secrets of ${d} not removed: ${e?.message ?? e}`));
  return live;
}

/**
 * Stop a runner now: `stop` (its turn), `exit` with a deadline (the runner quits by itself after it, ending its own
 * harness: the host may not be allowed to signal it); SIGKILL from its pid file if its socket is still open after `ms`.
 * True when it went.
 */
export async function retire(sock: net.Socket, socket: string, stop: () => void, ms = 10_000): Promise<boolean> {
  stop();
  send(sock, { t: 'exit', ms: Math.max(0, ms - 2_000) } satisfies HostToRunner);
  await Promise.race([closed(sock), new Promise((t) => setTimeout(t, ms).unref())]);
  if (sock.destroyed) return true;
  try {
    const pid = Number(readFileSync(pidFileFor(socket), 'utf8'));
    if (pid > 1) process.kill(pid, 'SIGKILL');
  } catch (e) {
    log.warn(`runner ${path.basename(socket)} did not exit and could not be killed: ${(e as Error)?.message ?? e}`);
  }
  await closed(sock);
  return sock.destroyed;
}

/** Resolves once a runner's socket has closed (it exits ~200 ms after `stopped`), or after 5 s. */
export function closed(sock: net.Socket) {
  return new Promise<void>((resolve) => {
    if (sock.destroyed) return resolve();
    sock.once('close', () => resolve());
    setTimeout(resolve, 5000).unref();
  });
}
