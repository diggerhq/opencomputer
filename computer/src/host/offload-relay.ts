// Build offload through the host (work 136): each sandboxed runner gets its own
// offload socket, `<run>/tokens/<id>.offload.sock` beside its token socket,
// and the host forwards what the session asks there to the offload service's
// control socket (SP_OFFLOAD_CONTROL), with the session's fence attached.
//
// Invariants:
// - The fence is the host's word: org from the host's identity, session key
//   from the sandbox record (a runner with none, a spare, is refused),
//   runner id from the socket served, and an epoch larger for every socket
//   served (it starts at the clock, so also across host restarts). Whatever
//   fence the session sent is dropped; `cancelFence` and `drain` are never forwarded.
// - A socket is served only while the service's health says ready (asked at
//   start and every 30 s); the runner then gets SP_OFFLOAD_SOCKET in boot.env.
// - Closing a runner's handle (runner gone, retired, sandbox removed) removes
//   the socket and cancels every fence it served at the service.

import net from 'node:net';
import { chmodSync, rmSync } from 'node:fs';
import { type ControlResponse, type Fence, SESSION_OPS, askLine, offloadSocketFor, readLine } from '../offload-protocol.js';
import type { RunRoot } from '../ipc.js';
import { log } from '../log.js';

export interface OffloadRelayDeps {
  /** The service's control socket. */
  control: string;
  /** The host's organization (identity.ts `hostId`). */
  org(): string;
  ask?: typeof askLine;
  now?: () => number;
}

export interface OffloadHandle {
  socket: string;
  close(): void;
}

export function offloadRelay(d: OffloadRelayDeps) {
  const ask = d.ask ?? askLine;
  const now = d.now ?? Date.now;
  let ready = false;
  let epoch = 0;
  const served = new Map<string, OffloadHandle>();

  async function refresh() {
    const r: ControlResponse = await ask(d.control, { op: 'health' }, 5000).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
    const next = r.ok && r.ready === true;
    if (next !== ready) log.info(`offload ${next ? 'ready' : `not available (${r.ok ? (r.reason ?? 'not ready') : r.error})`}: sockets for new runners ${next ? 'served' : 'not served'}`);
    ready = next;
    return ready;
  }

  /** Serve runner `id`'s offload socket, or undefined while offload is not ready. Idempotent per id. `session`: its record's key, or throws (a spare). */
  function serveRunner(run: RunRoot, id: string, session: () => string | undefined): OffloadHandle | undefined {
    const socket = offloadSocketFor(run, id);
    const open = served.get(socket);
    if (open) return open;
    if (!ready) return undefined;
    epoch = Math.max(epoch + 1, now());
    const mine = epoch;
    const fences = new Map<string, Fence>();
    rmSync(socket, { force: true });
    const server = net.createServer((sock) => {
      sock.on('error', () => {});
      const answer = (r: ControlResponse) => sock.end(JSON.stringify(r) + '\n');
      readLine(sock).then(async (raw) => {
        const { fence: _dropped, ...req } = (raw ?? {}) as { op?: unknown; fence?: unknown };
        if (typeof req.op !== 'string' || !SESSION_OPS.has(req.op)) return answer({ ok: false, error: `op ${String(req.op)} is not offered`, code: 'refused' });
        let sessionKey: string | undefined;
        try {
          sessionKey = session();
        } catch {}
        if (!sessionKey) return answer({ ok: false, error: 'this runner serves no thread', code: 'refused' });
        const fence: Fence = { org: d.org(), sessionKey, runnerId: id, epoch: mine };
        fences.set(`${fence.org}\0${sessionKey}`, fence);
        answer(await ask(d.control, { ...req, fence }).catch((e) => ({ ok: false, error: `offload service: ${e?.message ?? e}`, code: 'unavailable' as const })));
      }, (e) => answer({ ok: false, error: String(e?.message ?? e), code: 'bad-request' }));
    });
    // 0660: the runner reaches it through SP_RUN's group, as its token socket (tokens.ts).
    server.listen(socket, () => chmodSync(socket, 0o660));
    const handle: OffloadHandle = {
      socket,
      close() {
        if (served.get(socket) !== handle) return;
        served.delete(socket);
        server.close();
        rmSync(socket, { force: true });
        for (const fence of fences.values())
          ask(d.control, { op: 'cancelFence', fence }).catch((e) => log.warn(`offload: cancelFence for runner ${id} failed: ${e?.message ?? e}`));
      },
    };
    served.set(socket, handle);
    return handle;
  }

  return { refresh, serveRunner, get ready() { return ready; } };
}

export type OffloadRelay = ReturnType<typeof offloadRelay>;
