import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionAccess } from '../protocol.js';
import type { HostLink } from './host-link.js';
import { Outbox } from './outbox.js';
import { WireTerminals } from './terminal.js';

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.reverse()) c();
  cleanup = [];
});

/** A host that opens each terminal as a unix socket server and remembers what it was asked to close. */
function fakeHost(admins: string[] = []) {
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
    const { host, closed } = fakeHost();
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
    const { host, closed } = fakeHost(['usr_admin']);
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
