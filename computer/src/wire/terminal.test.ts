import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionAccess } from '../protocol.js';
import type { HostLink } from './host-link.js';
import { Outbox } from './outbox.js';
import { startRelay } from './relay.js';
import { WireTerminals } from './terminal.js';
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

  it('hangs up a member’s terminal when they may no longer open one in the session', async () => {
    const s = sid();
    const { host, relay } = await setup({ access: [accessFor(s, 'usr_owner', ['usr_owner', 'usr_invited'])] });
    const c = connectClient(relay.port, { member: 'usr_invited' });
    expect((await c.call('terminals.open', { sessionId: s, cols: 80, rows: 24 })).error).toBeUndefined();
    host.push({ t: 'access', access: accessFor(s, 'usr_owner', ['usr_owner']) });
    const exited = await c.next((m) => m.method === 'terminal.exited', 3000);
    expect(exited.params.reason).toBe('access_lost');
    c.ws.close();
  });

  it('refuses an admin in an "only me" session; in an org-wide one, an admin but not an unnamed member (CTO-37)', async () => {
    const onlyMe = sid();
    const open = sid();
    const { relay } = await setup({
      access: [{ ...accessFor(onlyMe, 'usr_owner', ['usr_owner']), admins: ['usr_admin'] }, accessFor(open, 'usr_owner', null)],
      admins: ['usr_admin'],
    });
    const admin = connectClient(relay.port, { member: 'usr_admin' });
    // Not named in the session: it does not exist for them.
    expect((await admin.call('terminals.open', { sessionId: onlyMe, cols: 80, rows: 24 })).error.data).toMatchObject({ code: 'session_not_found' });
    expect((await admin.call('terminals.open', { sessionId: open, cols: 80, rows: 24 })).error).toBeUndefined();
    const member = connectClient(relay.port, { member: 'usr_member' });
    expect((await member.call('terminals.open', { sessionId: open, cols: 80, rows: 24 })).error.data).toMatchObject({ reason: 'terminal_owner_only' });
    admin.ws.close();
    member.ws.close();
  });
});

/** A host that opens each terminal as a unix socket server and remembers what it was asked to close. */
function socketHost(admins: string[] = []) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'wire-term-'));
  const servers: net.Server[] = [];
  cleanup.push(() => {
    for (const s of servers) s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const closed: string[] = [];
  let n = 0;
  const host = {
    key: 'k',
    admins: new Set(admins),
    connected: true,
    access: () => undefined,
    waitAccess: async () => undefined,
    async call(frame: { t: string; terminalId?: string }) {
      if (frame.t === 'terminal.close') {
        closed.push(frame.terminalId!);
        return { result: {} };
      }
      const socket = path.join(dir, `t${++n}.sock`);
      const server = net.createServer((s) => s.on('error', () => {}));
      servers.push(server);
      await new Promise<void>((r) => server.listen(socket, r));
      return { result: { terminalId: `tm_${n}`, socket } };
    },
    callFiles: () => ({ first: Promise.resolve({}), done: Promise.resolve({}) }),
    telemetry: () => {},
    close: () => {},
  } as unknown as HostLink;
  return { host, closed };
}

const sink = { send: (_d: unknown, done: () => void) => done(), onPause() {}, onResume() {}, onOverflow() {} };

function terminals(member: string, host: HostLink) {
  return new WireTerminals({ host, outbox: new Outbox(sink as never), member, route: () => {} });
}

const owner = (members: string[] | null): SessionAccess => ({ sessionId: 'cs_a', owner: 'usr_owner', members });

describe('terminals when access changes (CTO-37)', () => {
  it('hangs up a listed person’s terminal when they are taken off the list, and keeps the owner’s', async () => {
    const { host, closed } = socketHost();
    const pat = terminals('usr_pat', host);
    const own = terminals('usr_owner', host);
    expect(await pat.open({ sessionId: 'cs_a', tty: false }, owner(['usr_pat']))).toMatchObject({ result: { terminal: { id: 'tm_1' } } });
    expect(await own.open({ sessionId: 'cs_a', tty: false }, owner(['usr_pat']))).toMatchObject({ result: { terminal: { id: 'tm_2' } } });
    pat.recheck(() => owner(['usr_pat']));
    expect(pat.size).toBe(1);
    pat.recheck(() => owner([]));
    own.recheck(() => owner([]));
    expect(pat.size).toBe(0);
    expect(own.size).toBe(1);
    expect(closed).toEqual(['tm_1']);
  });

  it('an admin’s terminal in an organization-wide session goes when it becomes owner-only, or the session is gone', async () => {
    const { host, closed } = socketHost(['usr_admin']);
    const admin = terminals('usr_admin', host);
    expect(await admin.open({ sessionId: 'cs_a', tty: false }, owner(null))).toMatchObject({ result: {} });
    expect(await admin.open({ sessionId: 'cs_a', tty: false }, owner([]))).toMatchObject({ error: { reason: 'terminal_owner_only' } });
    admin.recheck(() => owner(null));
    expect(admin.size).toBe(1);
    admin.recheck(() => undefined);
    expect(admin.size).toBe(0);
    expect(closed).toEqual(['tm_1']);
  });
});
