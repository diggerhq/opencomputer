import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lines } from '../ipc.js';
import { createTerminals } from './terminal.js';
import { Unavailable } from './unavailable.js';
import { serveWireLink, type WireLink, type WireLinkHooks } from './wire-link.js';
import { createWorkspaceFiles } from './workspace-files.js';

let root: string;
let link: WireLink;
let fork: string;
const recorded: [string, string, unknown][] = [];
const counts: [string, number][] = [];

const hooks: WireLinkHooks = {
  where: (sid) => (sid === 'cs_a' ? { socket: '/x/api.sock', token: 't', writer: 'host', epoch: 1 } : undefined),
  resume: async () => ({ status: 'starting' }),
  workspace: (sid) =>
    sid === 'cs_a' ? { forkPath: fork, owner: 'usr_owner' }
    : sid === 'cs_stopped' ? { forkPath: fork, owner: 'usr_owner', sandbox: { id: '0123456789abcdef', person: 'U1', workspace: fork, running: false } }
    : undefined,
  record: async (sid, type, data) => {
    recorded.push([sid, type, data]);
    return 42;
  },
  terminalsChanged: (sid, n) => counts.push([sid, n]),
};

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'wirelink-'));
  fork = path.join(root, 'fork');
  mkdirSync(fork);
  writeFileSync(path.join(fork, 'hello.txt'), 'hi there');
  const dir = path.join(root, 'wire');
  link = await serveWireLink(hooks, {
    dir,
    terminals: createTerminals({ dir: path.join(dir, 'terminals'), launch: 'detached' }),
    files: createWorkspaceFiles({ dir: path.join(root, 'files-scratch') }),
  });
  recorded.length = 0;
  counts.length = 0;
});
afterEach(async () => {
  await link.close();
  rmSync(root, { recursive: true, force: true });
});

/** A frame the fake relay read: JSON from the host, read loosely (the test edge). */
// biome-ignore lint/suspicious/noExplicitAny: parsed frames at the test edge
type Frame = any;

/** A fake relay on wire.sock. */
async function relay() {
  const sock = net.connect(link.socket);
  await new Promise((r) => sock.once('connect', r));
  const got: Frame[] = [];
  lines(sock, (m) => got.push(m));
  const send = (m: object) => sock.write(`${JSON.stringify(m)}\n`);
  const next = async (pred: (m: Frame) => boolean, ms = 8000) => {
    const end = Date.now() + ms;
    for (;;) {
      const i = got.findIndex(pred);
      if (i >= 0) return got.splice(i, 1)[0];
      if (Date.now() > end) throw new Error(`no frame; have ${JSON.stringify(got)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { sock, send, next, got };
}
const connect = (p: string) => new Promise<net.Socket>((resolve, reject) => net.connect(p).once('connect', function (this: net.Socket) { resolve(this); }).once('error', reject));

describe('wire link', () => {
  it('is reachable by its group only, and answers hello with the full state', async () => {
    expect(statSync(link.socket).mode & 0o777).toBe(0o660);
    expect(statSync(path.dirname(link.socket)).mode & 0o777).toBe(0o710);
    link.setKey('k1');
    link.setAdmins(['usr_admin']);
    link.setAccess({ sessionId: 'cs_a', owner: 'usr_owner', members: null });
    const r = await relay();
    r.send({ t: 'hello', version: 'test' });
    expect(await r.next((m) => m.t === 'welcome')).toEqual({ t: 'welcome', key: 'k1', admins: ['usr_admin'], access: [{ sessionId: 'cs_a', owner: 'usr_owner', members: null }] });
    r.sock.destroy();
    // A call before hello closes the socket, unanswered.
    const early = await relay();
    early.send({ t: 'where', id: 'w0', sessionId: 'cs_a' });
    await new Promise((res) => early.sock.once('close', res));
    expect(early.got).toEqual([]);
  });

  it('pushes access, revocations and moves, and answers where', async () => {
    const r = await relay();
    r.send({ t: 'hello', version: 'test' });
    await r.next((m) => m.t === 'welcome');
    link.setAccess({ sessionId: 'cs_a', owner: 'usr_owner', members: ['usr_b'] });
    link.revoked('ak_1');
    link.moved('cs_a');
    await r.next((m) => m.t === 'access' && m.access.members[0] === 'usr_b');
    await r.next((m) => m.t === 'revoked' && m.keyId === 'ak_1');
    await r.next((m) => m.t === 'moved' && m.sessionId === 'cs_a');
    r.send({ t: 'where', id: 'w1', sessionId: 'cs_a' });
    r.send({ t: 'where', id: 'w2', sessionId: 'cs_zz' });
    expect((await r.next((m) => m.id === 'w1')).result.writer).toBe('host');
    expect((await r.next((m) => m.id === 'w2')).error.code).toBe('session_not_found');
    r.sock.destroy();
  });

  it('opens a terminal for the owner only, records it, and hangs it up when the relay goes', async () => {
    const r = await relay();
    r.send({ t: 'hello', version: 'test' });
    await r.next((m) => m.t === 'welcome');
    r.send({ t: 'terminal.open', id: 't0', sessionId: 'cs_a', member: 'usr_other', cols: 80, rows: 24, tty: true });
    expect((await r.next((m) => m.id === 't0')).error).toMatchObject({ code: 'forbidden', reason: 'terminal_owner_only' });
    r.send({ t: 'terminal.open', id: 't1', sessionId: 'cs_a', member: 'usr_owner', cols: 80, rows: 24, tty: true, command: 'echo hi; sleep 30' });
    const { result } = await r.next((m) => m.id === 't1');
    const pty = await connect(result.socket);
    let out = '';
    pty.on('data', (d: Buffer) => (out += d.toString()));
    for (const end = Date.now() + 8000; !out.includes('hi') && Date.now() < end; ) await new Promise((res) => setTimeout(res, 20));
    expect(out).toContain('hi');
    expect(recorded).toContainEqual(['cs_a', 'terminal.opened', { terminalId: result.terminalId, command: 'echo hi; sleep 30' }]);
    expect(counts).toContainEqual(['cs_a', 1]);
    r.sock.destroy();
    const end = Date.now() + 8000;
    while (!recorded.some(([, t]) => t === 'terminal.closed') && Date.now() < end) await new Promise((res) => setTimeout(res, 20));
    expect(recorded.find(([, t]) => t === 'terminal.closed')).toBeTruthy();
    expect(counts.at(-1)).toEqual(['cs_a', 0]);
  });

  it("refuses a terminal in a session whose container is stopped, and starts nothing (C13)", async () => {
    const r = await relay();
    r.send({ t: 'hello', version: 'test' });
    await r.next((m) => m.t === 'welcome');
    r.send({ t: 'terminal.open', id: 't1', sessionId: 'cs_stopped', member: 'usr_owner', cols: 80, rows: 24, tty: true });
    const { error } = await r.next((m) => m.id === 't1');
    expect(error).toMatchObject({ code: 'conflict', status: 409, reason: 'session_not_running' });
    expect(error.message).toMatch(/[Rr]esume the session first/);
    expect(recorded).toEqual([]);
    expect(counts).toEqual([]);
    r.sock.destroy();
  });

  it('lets only the relay peer that opened a terminal resize, eof or close it', async () => {
    const [a, b] = [await relay(), await relay()];
    for (const r of [a, b]) {
      r.send({ t: 'hello', version: 'test' });
      await r.next((m) => m.t === 'welcome');
    }
    a.send({ t: 'terminal.open', id: 'o', sessionId: 'cs_a', member: 'usr_owner', cols: 80, rows: 24, tty: true, command: 'sleep 30' });
    const { terminalId } = (await a.next((m) => m.id === 'o')).result;
    b.send({ t: 'terminal.resize', id: 'b1', terminalId, cols: 100, rows: 30 });
    b.send({ t: 'terminal.eof', id: 'b2', terminalId });
    b.send({ t: 'terminal.close', id: 'b3', terminalId });
    for (const id of ['b1', 'b2', 'b3']) expect((await b.next((m) => m.id === id)).error.code).toBe('terminal_not_found');
    expect(recorded.some(([, t]) => t === 'terminal.closed')).toBe(false);
    a.send({ t: 'terminal.resize', id: 'a1', terminalId, cols: 100, rows: 30 });
    expect((await a.next((m) => m.id === 'a1')).result).toEqual({});
    a.send({ t: 'terminal.close', id: 'a2', terminalId });
    expect((await a.next((m) => m.id === 'a2')).result).toEqual({});
    a.sock.destroy();
    b.sock.destroy();
  });

  it('tells the relay what the host has words for (the computer is updating), as the call\'s result or its files.done', async () => {
    // The first script of this place starts; every later one is refused as behind the image lock.
    let n = 0;
    const dir = path.join(root, 'wire2');
    const other = await serveWireLink(hooks, {
      dir,
      terminals: createTerminals({ dir: path.join(dir, 'terminals'), launch: 'detached' }),
      files: createWorkspaceFiles({
        dir: path.join(root, 'files-scratch2'),
        place: (ws) => ({
          root: ws.forkPath,
          spawn: async (argv) => {
            if (n++) throw new Unavailable('The computer is updating, try again in a few minutes.');
            return spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
          },
        }),
      }),
    });
    const sock = net.connect(other.socket);
    const got: Frame[] = [];
    lines(sock, (m) => got.push(m));
    const next = async (pred: (m: Frame) => boolean) => {
      for (const end = Date.now() + 8000; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) {
        const i = got.findIndex(pred);
        if (i >= 0) return got.splice(i, 1)[0];
      }
      throw new Error(`no frame; have ${JSON.stringify(got)}`);
    };
    const send = (m: object) => sock.write(`${JSON.stringify(m)}\n`);
    send({ t: 'hello', version: 'test' });
    await next((m) => m.t === 'welcome');
    const updating = { code: 'unavailable', status: 503, retryable: true, message: 'The computer is updating, try again in a few minutes.' };
    // A download: its size was read (the first script), its bytes are refused.
    send({ t: 'files.get', id: 'g', sessionId: 'cs_a', member: 'usr_owner', path: 'hello.txt', file: true });
    const first = await next((m) => m.id === 'g' && m.t === 'result');
    const s = await connect(first.result.socket);
    s.resume();
    expect((await next((m) => m.id === 'g' && m.t === 'files.done')).error).toEqual(updating);
    send({ t: 'files.list', id: 'l', sessionId: 'cs_a', member: 'usr_owner', path: '' });
    expect((await next((m) => m.id === 'l')).error).toEqual(updating);
    send({ t: 'files.put', id: 'p', sessionId: 'cs_a', member: 'usr_owner', path: 'notes', format: 'tar' });
    expect((await next((m) => m.id === 'p')).error).toEqual(updating);
    sock.destroy();
    await other.close();
  });

  it('streams a file out and an upload in, with files.done', async () => {
    const r = await relay();
    r.send({ t: 'hello', version: 'test' });
    await r.next((m) => m.t === 'welcome');
    r.send({ t: 'files.get', id: 'f1', sessionId: 'cs_a', member: 'usr_owner', path: 'hello.txt', file: true });
    const first = await r.next((m) => m.id === 'f1' && m.t === 'result');
    expect(first.result).toMatchObject({ size: 8, contentType: 'text/plain; charset=utf-8' });
    const s = await connect(first.result.socket);
    let got = '';
    s.on('data', (d: Buffer) => (got += d.toString()));
    await new Promise((res) => s.on('end', res));
    expect(got).toBe('hi there');
    expect((await r.next((m) => m.id === 'f1' && m.t === 'files.done')).error).toBeUndefined();

    const src = path.join(root, 'up');
    mkdirSync(src);
    writeFileSync(path.join(src, 'n.txt'), 'pushed');
    r.send({ t: 'files.put', id: 'f2', sessionId: 'cs_a', member: 'usr_owner', path: 'notes', format: 'tar' });
    const put = await r.next((m) => m.id === 'f2' && m.t === 'result');
    const up = await connect(put.result.socket);
    up.end(execFileSync('tar', ['-c', '-C', src, '.']));
    const done = await r.next((m) => m.id === 'f2' && m.t === 'files.done');
    expect(done.result).toMatchObject({ upload: { path: 'notes', files: 2, bytes: 6, replaced: null }, seq: 42 });
    expect(readFileSync(path.join(fork, 'notes/n.txt'), 'utf8')).toBe('pushed');
    expect(recorded).toContainEqual(['cs_a', 'files.pushed', { path: 'notes', files: 2, bytes: 6, replaced: false }]);
    r.sock.destroy();
  });
});
