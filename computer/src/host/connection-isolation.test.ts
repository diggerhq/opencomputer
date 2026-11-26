// One thread cannot use another's connections (serverless-agents-ws work 080):
// a session reaches a connection with the OpenComputer key minted for it, and
// asks for one with a `connection-request`. Both carry the host's word for the
// session, never the runner's: a runner's token socket mints only for the
// session the host serves on it, its container mounts no other runner's
// socket, and its frames reach the gateway stamped with its own session.

import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createTelemetry } from '../telemetry/emitter.js';
import type { HostToGateway, RunnerToHost } from '../protocol.js';
import { sandboxRunFor, tokenSocketFor } from '../ipc.js';
import { freshTokenDir, tokenRelay } from './tokens.js';
import { createArgs } from './sandbox/podman-args.js';
import { relayed } from './spare-frames.js';

const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const SESSION: Record<string, string> = { [A]: 'T1:C1:1.1', [B]: 'T1:C2:2.2' };

/** One JSON line to a token socket, as the shim writes it, and its one-line answer. */
function ask(socket: string, req: object): Promise<{ token?: string; error?: string }> {
  return new Promise((resolve, reject) => {
    let got = '';
    const c = net.connect(socket, () => c.write(`${JSON.stringify(req)}\n`));
    c.on('data', (d) => (got += d)).on('end', () => resolve(JSON.parse(got))).on('error', reject);
  });
}

describe('connections across threads', () => {
  it("a runner's token socket mints keys for its own session only, whatever the request names", async () => {
    const asked: Extract<HostToGateway, { t: 'token' }>[] = [];
    const tm = createTelemetry({ service: 'host', version: 'v', region: 'r', send: () => {} });
    // The gateway's key is the session's: a key for B is one only B may hold.
    const relay = tokenRelay((m) => {
      asked.push(m);
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      queueMicrotask(() => relay.answer({ id: m.id, result: { token: `osb_${m.sessionKey}`, expiresAt, apiUrl: 'https://app.example.dev' } }));
      return true;
    }, tm);
    const host = mkdtempSync(path.join(tmpdir(), 'isolation-'));
    const runs: Record<string, string> = { [A]: sandboxRunFor(host, A), [B]: sandboxRunFor(host, B) };
    for (const id of [A, B]) mkdirSync(runs[id], { recursive: true }), freshTokenDir(runs[id]);
    const served = [A, B].map((id) => relay.serveRunner(runs[id], id, () => SESSION[id]));
    const socket = (id: string) => tokenSocketFor(runs[id], id);
    await vi.waitFor(() => expect([A, B].every((id) => existsSync(socket(id)))).toBe(true));
    try {
      // B's key is minted and cached first; A, naming B every way it can, still gets its own.
      expect(await ask(socket(B), { kind: 'opencomputer' })).toMatchObject({ token: `osb_${SESSION[B]}` });
      for (const req of [{ sessionKey: SESSION[B] }, { session: SESSION[B] }, { from: SESSION[B] }])
        expect(await ask(socket(A), { kind: 'opencomputer', ...req })).toMatchObject({ token: `osb_${SESSION[A]}` });
      expect(await ask(socket(B), { kind: 'opencomputer', sessionKey: SESSION[A] })).toMatchObject({ token: `osb_${SESSION[B]}` });
      expect(asked.map((m) => [m.kind, m.sessionKey])).toEqual([['opencomputer', SESSION[B]], ['opencomputer', SESSION[A]]]);
    } finally {
      for (const s of served) s.close();
    }
  });

  it("a runner's container mounts its own run root, so no other runner's token socket", () => {
    const host = '/run/sp';
    const args = (id: string) =>
      createArgs({ id, run: sandboxRunFor(host, id), dataDir: '/var/lib/sp', image: 'img', abi: '1', modelSocket: '/run/sp/model.sock' });
    const flag = (a: string[], f: string) => a.flatMap((v, i) => (a[i - 1] === f ? [v] : []));
    const a = args(A);
    const sources = flag(a, '-v').map((v) => v.split(':')[0]);
    const inside = (p: string) => sources.some((s) => p === s || p.startsWith(`${s}/`));
    expect(inside(tokenSocketFor(sandboxRunFor(host, A), A))).toBe(true);
    expect(inside(tokenSocketFor(sandboxRunFor(host, B), B))).toBe(false);
    expect(inside(tokenSocketFor(host, A))).toBe(false); // the host's own runners' sockets
    expect(inside(path.join(host, 'token.sock'))).toBe(false); // the host's shared socket, which names no session
    expect(sources.filter((s) => s.startsWith(`${host}/`))).toEqual([sandboxRunFor(host, A), '/run/sp/model.sock']);
    expect(flag(a, '--env')).toContain(`SP_TOKEN_SOCKET=${tokenSocketFor(sandboxRunFor(host, A), A)}`);
  });

  it("a connection-request reaches the gateway from the runner's session, not from one it names", () => {
    const forged = { t: 'connection-request', id: 'q', req: { service: 'linear', reason: 'To file a bug' }, from: SESSION[B] } as RunnerToHost;
    expect(relayed(forged as Extract<RunnerToHost, { t: 'connection-request' }>, SESSION[A])).toEqual({
      t: 'connection-request',
      id: 'q',
      req: { service: 'linear', reason: 'To file a bug' },
      from: SESSION[A],
    } satisfies HostToGateway);
  });
});
