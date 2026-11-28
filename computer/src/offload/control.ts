// The offload service's control socket (work 136): one JSON line in, one out,
// per connection (offload-protocol.ts). Only the host asks here; sessions ask
// the host, which attaches their fence (host/offload-relay.ts).
//
// Invariants:
// - The socket is 0660 and its group is the host's (`sp-host`; the unit gives
//   the service that group as a supplementary one), and so is the runtime
//   directory, so only root, the service and the host reach it. Node has no
//   SO_PEERCRED, so file permissions are the whole check.
// - When offload is not ready (off, not AWS, no role) every request but
//   `health` is refused with `unavailable`, and `health` says why.
// - An error answers `{ok: false, error, code}`; nothing is thrown at the asker,
//   and no answer carries a credential.

import net from 'node:net';
import { chmodSync, chownSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ControlResponse, Fence, Health } from '../offload-protocol.js';
import { readLine } from '../offload-protocol.js';
import { log } from '../log.js';
import { type Jobs, Refused } from './jobs.js';

export interface ControlDeps {
  /** Undefined while offload is not ready. */
  jobs?: Jobs;
  health(): Health;
  drain(timeoutSec?: number): Promise<boolean>;
}

type Req = { op?: unknown; fence?: Fence; id?: unknown; offset?: unknown; timeoutSec?: unknown } & Record<string, unknown>;

export async function handle(req: Req, d: ControlDeps): Promise<ControlResponse> {
  try {
    if (req?.op === 'health') return { ok: true, ...d.health() };
    if (req.op === 'drain') return { ok: true, drained: await d.drain(typeof req.timeoutSec === 'number' ? req.timeoutSec : undefined) };
    const j = d.jobs;
    if (!j) return { ok: false, error: d.health().reason ?? 'offload is not available', code: 'unavailable' };
    switch (req.op) {
      case 'submit': return { ok: true, ...(await j.submit(req.fence, req as Parameters<Jobs['submit']>[1])) };
      case 'start': return { ok: true, job: j.start(req.fence, req.id) };
      case 'status': return { ok: true, job: j.status(req.fence, req.id) };
      case 'logs': return { ok: true, ...j.logs(req.fence, req.id, req.offset) };
      case 'cancel': return { ok: true, ...j.cancel(req.fence, req.id) };
      case 'fetch': return { ok: true, ...(await j.fetch(req.fence, req.id)) };
      case 'list': return { ok: true, jobs: j.list(req.fence) };
      case 'cancelFence':
        if (!req.fence || typeof req.fence !== 'object') return { ok: false, error: 'cancelFence needs a fence', code: 'bad-request' };
        return { ok: true, cancelled: j.cancelFence(req.fence) };
      default: return { ok: false, error: `unknown op ${String(req.op)}`, code: 'bad-request' };
    }
  } catch (e) {
    if (e instanceof Refused) return { ok: false, error: e.message, code: e.code };
    log.warn(`offload control ${String(req?.op)}: ${(e as Error)?.message ?? e}`);
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/** Listen on `socket`; `gid`: the host's group, given to the socket and its directory (undefined: left as they are). */
export function serveControl(socket: string, d: ControlDeps, gid?: number): net.Server {
  rmSync(socket, { force: true });
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    readLine(sock).then(
      async (req) => sock.end(JSON.stringify(await handle(req as Req, d)) + '\n'),
      (e) => sock.end(JSON.stringify({ ok: false, error: String(e?.message ?? e), code: 'bad-request' }) + '\n'),
    );
  });
  server.listen(socket, () => {
    chmodSync(socket, 0o660);
    if (gid === undefined) return;
    try {
      // Only where needed: the unit makes the directory the host's group
      // (setgid), so the socket has it too, and a chown to a group oc-offload
      // is not in fails with EPERM even when nothing would change.
      for (const p of [path.dirname(socket), socket]) if (statSync(p).gid !== gid) chownSync(p, -1, gid);
    } catch (e) {
      log.warn(`offload control socket: could not give it group ${gid} (${(e as Error)?.message ?? e}); the host may not reach it`);
    }
  });
  return server;
}
