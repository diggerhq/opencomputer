import { existsSync, mkdtempSync, readlinkSync, statSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { createTelemetry } from '../telemetry/emitter.js';
import type { HostToGateway } from '../protocol.js';
import { tokenSocketFor } from '../ipc.js';
import { freshTokenDir, tokenRelay } from './tokens.js';

const run = promisify(execFile);
const helper = path.resolve('bin/git-credential-slack-presence');

describe('token relay', () => {
  it('asks the gateway for an OpenComputer key and hands the shim the key and its URL', async () => {
    const asked: Extract<HostToGateway, { t: 'token' }>[] = [];
    const tm = createTelemetry({ service: 'host', version: 'v', region: 'r', send: () => {} });
    const relay = tokenRelay((m) => {
      asked.push(m);
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      queueMicrotask(() =>
        relay.answer(m.kind === 'opencomputer'
          ? { id: m.id, result: { token: 'osb_k', expiresAt, apiUrl: 'https://app.example.dev' } }
          : { id: m.id, result: { token: 'ghs_t', expiresAt } }),
      );
      return true;
    }, tm);
    const dir = mkdtempSync(path.join(tmpdir(), 'tokens-'));
    const server = relay.serve(path.join(dir, 'token.sock'));
    await new Promise((r) => server.once('listening', r));
    try {
      const env = { ...process.env, SP_RUN: dir, SP_TOKEN_SOCKET: '' };
      const oc = await run(helper, ['opencomputer'], { env });
      expect(oc.stdout).toBe('osb_k\nhttps://app.example.dev\n');
      const gh = await run(helper, ['token'], { env });
      expect(gh.stdout).toBe('ghs_t\n');
      expect(asked.map((m) => m.kind)).toEqual(['opencomputer', undefined]);
    } finally {
      server.close();
    }
  });

  it("names the session from the runner's own socket, never from the asker", async () => {
    const asked: Extract<HostToGateway, { t: 'token' }>[] = [];
    const tm = createTelemetry({ service: 'host', version: 'v', region: 'r', send: () => {} });
    const relay = tokenRelay((m) => {
      asked.push(m);
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      queueMicrotask(() => relay.answer({ id: m.id, result: { token: 'osb_k', expiresAt, apiUrl: 'https://app.example.dev' } }));
      return true;
    }, tm);
    const dir = mkdtempSync(path.join(tmpdir(), 'tokens-'));
    let serving = 'T1:C1:1.1';
    const own = relay.serve(path.join(dir, 'r1.sock'), () => serving);
    const shared = relay.serve(path.join(dir, 'token.sock'));
    await Promise.all([own, shared].map((s) => new Promise((r) => s.once('listening', r))));
    try {
      const ask = (env: NodeJS.ProcessEnv) => run(helper, ['opencomputer'], { env: { ...process.env, SP_RUN: dir, ...env } });
      await ask({ SP_TOKEN_SOCKET: path.join(dir, 'r1.sock'), SP_SESSION_KEY: 'T1:C9:9.9' });
      serving = ''; // a spare
      await ask({ SP_TOKEN_SOCKET: path.join(dir, 'r1.sock') });
      await ask({ SP_TOKEN_SOCKET: '', SP_SESSION_KEY: 'T1:C9:9.9' });
      // A client that names a session itself is not believed either.
      await new Promise<void>((resolve, reject) => {
        const c = net.connect(path.join(dir, 'token.sock'), () => c.write(`${JSON.stringify({ kind: 'opencomputer', sessionKey: 'T1:C9:9.9' })}\n`));
        c.on('data', () => c.end()).on('close', () => resolve()).on('error', reject);
      });
      expect(asked.map((m) => m.sessionKey)).toEqual(['T1:C1:1.1', undefined]);
    } finally {
      own.close();
      shared.close();
    }
  });

  it("gives each runner its own socket in a setgid directory it cannot write, gone when the runner goes", async () => {
    const tm = createTelemetry({ service: 'host', version: 'v', region: 'r', send: () => {} });
    const root = mkdtempSync(path.join(tmpdir(), 'tokens-'));
    const relay = tokenRelay(() => false, tm);
    const dir = freshTokenDir(root);
    // 02750: the sockets made here keep SP_RUN's group, so runners running as another user still reach them (work 077).
    expect(statSync(dir).mode & 0o7777).toBe(0o2750);
    const serving = relay.serveRunner(root, 'r1', () => 'T1:C1:1.1');
    expect(relay.serveRunner(root, 'r1', () => 'T1:C2:2.2')).toBe(serving); // once per runner
    const sock = path.join(dir, 'r1.sock');
    expect(sock).toBe(tokenSocketFor(root, 'r1'));
    await vi.waitFor(() => expect(existsSync(sock)).toBe(true));
    // Work 103: in a run root that is not the host's, the name the helpers know leads to the runner's own socket.
    expect(readlinkSync(path.join(root, 'token.sock'))).toBe('tokens/r1.sock');
    serving.close();
    await vi.waitFor(() => expect(existsSync(sock)).toBe(false));
  });

  it("hands git a push credential for the organization's automations repository", async () => {
    const asked: Extract<HostToGateway, { t: 'token' }>[] = [];
    const tm = createTelemetry({ service: 'host', version: 'v', region: 'r', send: () => {} });
    const relay = tokenRelay((m) => {
      asked.push(m);
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      queueMicrotask(() =>
        relay.answer({
          id: m.id,
          result: { token: 'jwt_p', expiresAt, username: 't', remoteUrl: 'https://acme.code.storage/automations-acct.git' },
        }),
      );
      return true;
    }, tm);
    const dir = mkdtempSync(path.join(tmpdir(), 'tokens-'));
    const server = relay.serve(path.join(dir, 'token.sock'));
    await new Promise((r) => server.once('listening', r));
    try {
      const env = { ...process.env, SP_RUN: dir, SP_TOKEN_SOCKET: '' };
      const remote = await run(helper, ['automation-remote'], { env });
      expect(remote.stdout).toBe('https://acme.code.storage/automations-acct.git\n');
      const get = execFile(helper, ['get'], { env });
      get.stdin?.end('protocol=https\nhost=acme.code.storage\npath=automations-acct.git\n\n');
      const out = await new Promise<string>((resolve) => {
        let text = '';
        get.stdout?.on('data', (d) => (text += d));
        get.on('close', () => resolve(text));
      });
      expect(out).toMatch(/^username=t\npassword=jwt_p\npassword_expiry_utc=\d+\n$/);
      // One ask: the push reuses the credential the remote was set up with.
      expect(asked.map((m) => m.kind)).toEqual(['automation-repo']);
    } finally {
      server.close();
    }
  });
});
