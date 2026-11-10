// Codex speaks TCP only, and oc-modelproxy listens on a unix socket whose
// peer credentials say which runner is calling (work 077). This forwarder is
// the bridge (work 082, contract section 5): a listener on 127.0.0.1 at a
// kernel-assigned port, piping each connection byte for byte to a fresh
// connection to the proxy's socket, made by this runner process so the
// proxy's SO_PEERCRED identity is this runner's.
//
// Threat model. A port on 127.0.0.1 is open to every process on the
// computer, and through it they would reach the model as this runner (its
// session's subscription). Every session's runner, Codex and commands run as
// the same user, so nothing in Codex's environment or files is secret from
// another session: a shared key (this file's first design) was readable from
// /proc/<codex>/environ. What another session cannot fake is where it runs:
// each runner is a systemd unit, a cgroup of its own. So a connection is
// forwarded only when the kernel says a process in this runner's cgroup
// holds its other end (peer.ts). Processes inside the cgroup (Codex and the
// commands it runs for this session) may use it, as Claude's Bash may use
// the proxy as this runner today. Without systemd units (a laptop, tests)
// there is no such boundary, and the check is off only when the runner's
// main.ts says so (SP_CODEX_PEER_CHECK=off).
//
// Invariants:
// - it binds 127.0.0.1 only, and also refuses any peer whose address is not
//   loopback (defence if the bind ever changes);
// - with the check on, no byte is read from a connection, nor any sent to
//   the proxy, before the kernel attested its peer; an unreadable /proc or
//   cgroup refuses (fails closed);
// - either side closing or failing destroys the other; nothing outlives the
//   pair;
// - one listener per runner, created on first use and closed when the
//   process exits; a failure to listen is reported to every caller, and the
//   next caller tries again.

import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { log } from '../../../log.js';
import { type Refusal, type Roots, attest, ROOTS } from './peer.js';

export interface Loopback {
  port: number;
  close(): void;
}

export interface LoopbackOptions {
  /** Attest each peer's cgroup (peer.ts); false only where runners have no cgroup of their own. */
  peerCheck: boolean;
  /** A peer was refused, or attesting one took over `SLOW_CHECK_MS` (telemetry; not every check: Codex connects per request). */
  checked?(c: PeerCheck): void;
  /** Where /proc and the cgroup tree are (tests). */
  roots?: Roots;
}

export interface PeerCheck {
  ok: boolean;
  code?: Refusal | 'not_loopback';
  ms: number;
  pids?: number;
  fds?: number;
}

/** An accepted check this slow is reported; a refusal always is. */
export const SLOW_CHECK_MS = 5;

/** A peer on this machine's loopback (IPv4, or IPv4 mapped into IPv6). */
export function isLoopbackPeer(address: string | undefined) {
  return address === '127.0.0.1' || address === '::ffff:127.0.0.1';
}

/** A forwarder from 127.0.0.1:<port> to the unix socket `socket`, for peers in this runner's cgroup. */
export function listen(socket: string, o: LoopbackOptions): Promise<Loopback> {
  const conns = new Set<net.Socket>();
  let port = 0;
  const server = net.createServer({ pauseOnConnect: true }, (inbound) => {
    if (!isLoopbackPeer(inbound.remoteAddress)) {
      log.warn(`codex loopback: refused a peer at ${inbound.remoteAddress}`);
      o.checked?.({ ok: false, code: 'not_loopback', ms: 0 });
      return void inbound.destroy();
    }
    if (o.peerCheck) {
      const t0 = performance.now();
      const a = attest(inbound.remotePort ?? 0, port, o.roots ?? ROOTS, codexPids);
      const ms = performance.now() - t0;
      const took = ms.toFixed(2);
      if (!a.ok || ms > SLOW_CHECK_MS) o.checked?.({ ok: a.ok, ...(a.ok ? {} : { code: a.code }), ms, pids: a.pids, fds: a.fds });
      if (!a.ok) {
        log.warn(`codex loopback: refused a connection from port ${inbound.remotePort}: ${a.why} (${took} ms, ${a.pids ?? 0} pids, ${a.fds ?? 0} fds)`);
        return void inbound.destroy();
      }
      log.info(`codex loopback: pid ${a.pid} attested in ${took} ms (${a.pids} pids, ${a.fds} fds)`);
    }
    forward(inbound);
  });
  const forward = (inbound: net.Socket) => {
    const outbound = net.connect(socket);
    conns.add(inbound).add(outbound);
    const end = (why?: Error) => {
      if (why) log.warn(`codex loopback: ${why.message}`);
      inbound.destroy();
      outbound.destroy();
      conns.delete(inbound);
      conns.delete(outbound);
    };
    inbound.on('error', end).on('close', () => end());
    outbound.on('error', end).on('close', () => end());
    // pipe() carries back-pressure each way; ends propagate as half-closes, and close tears both down.
    inbound.pipe(outbound);
    outbound.pipe(inbound);
    inbound.resume();
  };
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => {
      server.off('error', reject);
      server.on('error', (e) => log.warn('codex loopback:', e.message));
      server.unref();
      port = (server.address() as net.AddressInfo).port;
      if (!o.peerCheck) log.warn('codex loopback: peer check off (SP_CODEX_PEER_CHECK=off): any local process can reach the model as this runner');
      resolve({
        port,
        close() {
          server.close();
          for (const c of conns) c.destroy();
          conns.clear();
        },
      });
    });
  });
}

/** This runner's live Codex app-servers: the peer check reads their fd tables first (peer.ts). */
export const codexPids = new Set<number>();

let shared: Promise<Loopback> | undefined;

/** This runner's one forwarder to `socket`, made on first use; closed when the process exits. */
export function loopback(socket: string, o: LoopbackOptions): Promise<Loopback> {
  if (!shared) {
    shared = listen(socket, o);
    shared.then(
      (l) => process.once('exit', () => l.close()),
      () => (shared = undefined),
    );
  }
  return shared;
}
