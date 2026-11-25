import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionAccess } from '../protocol.js';
import { startRelay } from './relay.js';
import { accessFor, connectClient, fakeHost, sid, until } from './test-fakes.js';

let cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

/** A relay over a fake host whose terminals are unix sockets here; `terminal.close` ends one and the host says it exited. */
async function setup(o: { access: SessionAccess[]; admins?: string[]; idleMs?: number }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wire-term-'));
  const pty = new Map<string, net.Socket>();
  const servers: net.Server[] = [];
  let n = 0;
  const host = await fakeHost({
    access: o.access,
    admins: o.admins,
    answer: async (m) => {
      if (m.t === 'terminal.open') {
        const terminalId = `tm_${String(++n).padStart(12, '0')}`;
        const socket = path.join(dir, `${terminalId}.sock`);
        const server = net.createServer((s) => {
          pty.set(terminalId, s);
          s.on('error', () => {});
          s.on('data', (d) => s.write(d)); // an echoing shell
        });
        servers.push(server);
        await new Promise<void>((r) => server.listen(socket, () => r()));
        return { result: { terminalId, socket, stderrSocket: null } };
      }
      if (m.t === 'terminal.close') {
        pty.get(m.terminalId)?.end();
        setTimeout(() => host.push({ t: 'terminal.exited', terminalId: m.terminalId, exitCode: null, signal: 'SIGHUP' }), 5);
        return { result: {} };
      }
      return undefined;
    },
  });
  const relay = await startRelay({ host: '127.0.0.1', port: 0, socket: host.socket, version: 'test', region: null, telemetryMs: 3_600_000, terminalIdleMs: o.idleMs });
  cleanup.push(
    () => host.close(),
    () => relay.close(),
    () => {
      for (const s of servers) s.close();
      rmSync(dir, { recursive: true, force: true });
    },
  );
  await until(() => relay.hostLink.key !== null);
  return { host, relay };
}

const frame = (channel: number, text: string) => {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(channel, 0);
  return Buffer.concat([head, Buffer.from(text)]);
};

describe('wire terminals', () => {
  it('hangs up a tty terminal after the idle timeout, saying why', async () => {
    const s = sid();
    const { relay } = await setup({ access: [accessFor(s)], idleMs: 150 });
    const c = connectClient(relay.port);
    const open = await c.call('terminals.open', { sessionId: s, cols: 80, rows: 24 });
    expect(open.error).toBeUndefined();
    const exited = await c.next((m) => m.method === 'terminal.exited', 3000);
    expect(exited.params).toMatchObject({ terminalId: open.result.terminal.id, reason: 'idle' });
    c.ws.close();
  });

  it('input and output keep a terminal open past the idle timeout', async () => {
    const s = sid();
    const { relay } = await setup({ access: [accessFor(s)], idleMs: 250 });
    const c = connectClient(relay.port);
    const open = await c.call('terminals.open', { sessionId: s, cols: 80, rows: 24 });
    const channel = open.result.terminal.channel;
    const started = Date.now();
    while (Date.now() - started < 600) {
      c.ws.send(frame(channel, 'x'));
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(c.frames.some((m) => m.method === 'terminal.exited')).toBe(false);
    expect(c.frames.some((m) => Buffer.isBuffer(m) && m.subarray(4).toString() === 'x')).toBe(true);
    const exited = await c.next((m) => m.method === 'terminal.exited', 3000);
    expect(exited.params.reason).toBe('idle');
    c.ws.close();
  });

  it('never times out a command without a tty, nor any terminal with the timeout off', async () => {
    const s = sid();
    const { relay } = await setup({ access: [accessFor(s)], idleMs: 100 });
    const c = connectClient(relay.port);
    expect((await c.call('terminals.open', { sessionId: s, tty: false, command: 'sleep 5' })).error).toBeUndefined();
    await new Promise((r) => setTimeout(r, 400));
    expect(c.frames.some((m) => m.method === 'terminal.exited')).toBe(false);
    c.ws.close();

    const off = await setup({ access: [accessFor(s)], idleMs: 0 });
    const d = connectClient(off.relay.port);
    expect((await d.call('terminals.open', { sessionId: s, cols: 80, rows: 24 })).error).toBeUndefined();
    await new Promise((r) => setTimeout(r, 300));
    expect(d.frames.some((m) => m.method === 'terminal.exited')).toBe(false);
    d.ws.close();
  });

  it('hangs up a member’s terminal when they may no longer drive the session', async () => {
    const s = sid();
    const { host, relay } = await setup({ access: [accessFor(s, 'usr_owner', ['usr_owner', 'usr_invited'])] });
    const c = connectClient(relay.port, { member: 'usr_invited' });
    expect((await c.call('terminals.open', { sessionId: s, cols: 80, rows: 24 })).error).toBeUndefined();
    host.push({ t: 'access', access: accessFor(s, 'usr_owner', ['usr_owner']) });
    const exited = await c.next((m) => m.method === 'terminal.exited', 3000);
    expect(exited.params.reason).toBe('access_lost');
    c.ws.close();
  });

  it('refuses an admin in an "only me" session, and lets an org member into an org-wide one', async () => {
    const onlyMe = sid();
    const open = sid();
    const { relay } = await setup({
      access: [{ ...accessFor(onlyMe, 'usr_owner', ['usr_owner']), admins: ['usr_admin'] }, accessFor(open, 'usr_owner', null)],
      admins: ['usr_admin'],
    });
    const admin = connectClient(relay.port, { member: 'usr_admin' });
    // Not named in the session: it does not exist for them.
    expect((await admin.call('terminals.open', { sessionId: onlyMe, cols: 80, rows: 24 })).error.data).toMatchObject({ code: 'session_not_found' });
    const member = connectClient(relay.port, { member: 'usr_member' });
    expect((await member.call('terminals.open', { sessionId: open, cols: 80, rows: 24 })).error).toBeUndefined();
    admin.ws.close();
    member.ws.close();
  });
});
