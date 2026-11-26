import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Unavailable, UPDATING } from './unavailable.js';
import { createTerminals, frame, frames, type Terminals, TERMINALS_PER_SESSION } from './terminal.js';

let dir: string;
let terms: Terminals;
const env = process.env;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'term-'));
  terms = createTerminals({ dir, launch: 'detached', path: env.PATH });
});
afterEach(async () => {
  await terms.closeAll();
  rmSync(dir, { recursive: true, force: true });
});

const connect = (p: string) =>
  new Promise<net.Socket>((resolve, reject) => {
    const s = net.connect(p, () => resolve(s));
    s.once('error', reject);
  });

function collect(s: net.Socket) {
  const got = { text: '', ended: false };
  s.on('data', (d: Buffer) => (got.text += d.toString('utf8')));
  s.on('end', () => (got.ended = true));
  return got;
}

async function until(fn: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

type Opened = { terminalId: string; socket: string; stderrSocket: string | null };
const exits: { id: string; code: number | null; signal: string | null }[] = [];
const onExit = (id: string, code: number | null, signal: string | null) => exits.push({ id, code, signal });

describe('frames', () => {
  it('splits frames across chunks', () => {
    const got: [string, string][] = [];
    const feed = frames((k, p) => got.push([k, p.toString()]));
    const all = Buffer.concat([frame('O', 'hello'), frame('Z', '{}')]);
    for (const b of all) feed(Buffer.from([b]));
    expect(got).toEqual([
      ['O', 'hello'],
      ['Z', '{}'],
    ]);
  });
});

describe('terminals (real PTY)', () => {
  it('runs a command in a PTY at the given size, and reports its exit', async () => {
    const r = (await terms.open({ sessionId: 'cs_a', cwd: dir, cols: 91, rows: 17, command: 'stty size; tty >/dev/null && echo TTY; exit 3', tty: true }, onExit)) as Opened;
    expect(r.stderrSocket).toBeNull();
    const out = collect(await connect(r.socket));
    await until(() => out.ended);
    expect(out.text).toContain('17 91');
    expect(out.text).toContain('TTY');
    await until(() => exits.some((e) => e.id === r.terminalId));
    expect(exits.find((e) => e.id === r.terminalId)?.code).toBe(3);
    expect(terms.count('cs_a')).toBe(0);
  });

  it('carries input, resize, and starts in cwd with a fixed environment', async () => {
    process.env.SP_SECRET_FOR_TEST = 'leak';
    // A shell command line, not a template: the shell expands these.
    const command = ['read a; stty size; pwd; echo "S=$', '{SP_SECRET_FOR_TEST:-none} T=$TERM"; read b'].join('');
    const r = (await terms.open({ sessionId: 'cs_a', cwd: dir, cols: 80, rows: 24, tty: true, command }, onExit)) as Opened;
    delete process.env.SP_SECRET_FOR_TEST;
    const s = await connect(r.socket);
    const out = collect(s);
    terms.resize(r.terminalId, 120, 40);
    await new Promise((res) => setTimeout(res, 100));
    s.write('go\n');
    await until(() => out.text.includes('T='));
    expect(out.text).toContain('40 120');
    expect(out.text).toContain(dir);
    expect(out.text).toContain('S=none T=xterm-256color');
    s.write('x\n');
    await until(() => out.ended);
  });

  it('keeps standard error apart without a tty, and eof closes stdin', async () => {
    const r = (await terms.open({ sessionId: 'cs_a', cwd: dir, cols: 80, rows: 24, tty: false, command: 'echo err >&2; cat' }, onExit)) as Opened;
    expect(r.stderrSocket).toBeTruthy();
    const s = await connect(r.socket);
    const err = collect(await connect(r.stderrSocket as string));
    const out = collect(s);
    s.write('piped\n');
    await until(() => out.text.includes('piped'));
    terms.eof(r.terminalId);
    await until(() => out.ended && err.ended);
    expect(err.text).toBe('err\n');
    expect(out.text).toBe('piped\n');
  });

  it('close hangs up an interactive shell', async () => {
    const r = (await terms.open({ sessionId: 'cs_a', cwd: dir, cols: 80, rows: 24, tty: true, command: 'sleep 60' }, onExit)) as Opened;
    const out = collect(await connect(r.socket));
    expect(terms.close(r.terminalId)).toBe(true);
    await until(() => out.ended);
    await until(() => exits.some((e) => e.id === r.terminalId));
    const e = exits.find((x) => x.id === r.terminalId);
    expect(e?.code === null ? e.signal : 'exited').toBe('SIGHUP');
  });

  it('the relay hanging up its socket hangs up the shell', async () => {
    const r = (await terms.open({ sessionId: 'cs_a', cwd: dir, cols: 80, rows: 24, tty: true, command: 'sleep 60' }, onExit)) as Opened;
    (await connect(r.socket)).destroy();
    await until(() => exits.some((e) => e.id === r.terminalId));
  });

  it('refuses a ninth terminal in a session', async () => {
    for (let i = 0; i < TERMINALS_PER_SESSION; i++) {
      expect('terminalId' in (await terms.open({ sessionId: 'cs_b', cwd: dir, cols: 80, rows: 24, tty: true, command: 'sleep 30' }, onExit))).toBe(true);
    }
    const r = await terms.open({ sessionId: 'cs_b', cwd: dir, cols: 80, rows: 24, tty: true }, onExit);
    expect('error' in r && r.error.code).toBe('too_many_terminals');
    await terms.closeSession('cs_b');
    expect(terms.count('cs_b')).toBe(0);
  }, 20_000);
});

describe('terminals in containers (work 103, C13)', () => {
  it('on a podman host, an open that names no sandbox starts nothing', async () => {
    const podman = createTerminals({ dir: path.join(dir, 'p'), launch: 'podman' });
    podman.prewarm(); // no helper ahead either: it would be a process outside every container
    const r = await podman.open({ sessionId: 'cs_a', cwd: dir, cols: 80, rows: 24, tty: true }, onExit);
    expect('error' in r && [r.error.code, r.error.status]).toEqual(['unavailable', 503]);
    expect(podman.count('cs_a')).toBe(0);
    await podman.closeAll();
  });

  it('enters the sandbox first: refused with the words of the refusal, or as not running, and nothing starts; no use is left', async () => {
    const log: string[] = [];
    let answer: () => Promise<{ running: boolean; leave(): void }> = async () => ({ running: false, leave: () => void log.push('left') });
    const podman = createTerminals({ dir: path.join(dir, 'p'), launch: 'podman', inside: { enter: (id) => (log.push(`enter ${id}`), answer()), hangUp() {} } });
    const open = () => podman.open({ sessionId: 'cs_a', sandbox: '00aa11bb22cc33dd', cwd: '/workspace', cols: 80, rows: 24, tty: true }, onExit);
    const stopped = await open();
    expect('error' in stopped && [stopped.error.code, stopped.error.reason]).toEqual(['conflict', 'session_not_running']);
    answer = () => Promise.reject(new Unavailable(UPDATING));
    const updating = await open();
    expect('error' in updating && updating.error).toEqual({ code: 'unavailable', message: 'The computer is updating, try again in a few minutes.', status: 503, retryable: true });
    answer = () => Promise.reject(new Error('systemctl: /run/user/1500'));
    const other = await open();
    expect('error' in other && [other.error.code, other.error.message]).toEqual(['unavailable', 'The terminal could not start.']);
    expect(log).toEqual(['enter 00aa11bb22cc33dd', 'left', 'enter 00aa11bb22cc33dd', 'enter 00aa11bb22cc33dd']);
    expect(podman.count('cs_a')).toBe(0);
    await podman.closeAll();
  });

  it('the helper, as podman exec runs it: its own environment with TERM over it, never BASH_ENV, and SIGHUP hangs up', async () => {
    const helper = path.resolve(import.meta.dirname, 'terminal-pty.py');
    const p = spawn('python3', [helper, 'sp-term-test'], { stdio: ['pipe', 'pipe', 'inherit'], env: { PATH: env.PATH, HOME: '/home/agent', BASH_ENV: '/nonexistent', SP_INSIDE: 'yes' } });
    let out = '';
    let exit: { exitCode: number | null; signal: string | null } | undefined;
    p.stdout.on('data', frames((k, payload) => (k === 'O' ? (out += payload.toString()) : k === 'Z' && (exit = JSON.parse(payload.toString())))));
    p.stdin.write(frame('S', JSON.stringify({ cols: 80, rows: 24, tty: true, cwd: dir, env: { TERM: 'vt100' }, term: 'vt100', inherit: true,
      command: 'echo "$SP_INSIDE $HOME $TERM ${BASH_ENV:-unset}"; sleep 60' })));
    await until(() => out.includes('vt100'));
    expect(out).toContain('yes /home/agent vt100 unset');
    p.kill('SIGHUP');
    await until(() => !!exit);
    expect(exit).toEqual({ exitCode: null, signal: 'SIGHUP' });
  });
});
