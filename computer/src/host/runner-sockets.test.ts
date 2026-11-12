import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pidFileFor } from '../ipc.js';
import { retire } from './runner-sockets.js';

/** A runner that ignores `exit`: the host's end of its socket, and what it was sent. */
async function deaf() {
  const p = path.join(mkdtempSync(path.join(tmpdir(), 'retire-')), 'r.sock');
  const got: string[] = [];
  const server = net.createServer((c) => void c.on('data', (b) => got.push(String(b))).on('error', () => {}));
  await new Promise<void>((r) => server.listen(p, r));
  const sock = net.connect(p);
  await new Promise((r) => sock.once('connect', r));
  return { sock, socket: p, got, close: () => server.close() };
}

describe('retire', () => {
  it("a container's runner that ignores exit is stopped by `kill`; the pid file, which its session can write, is never used", async () => {
    const r = await deaf();
    // What a session could plant: the pid of something the host must not kill.
    const bystander = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    writeFileSync(pidFileFor(r.socket), String(bystander.pid));
    const did: string[] = [];
    const went = await retire(r.sock, r.socket, () => void did.push('stop'), { ms: 30, kill: async () => void (did.push('kill'), r.sock.destroy()) });
    expect(went).toBe(true);
    expect(did).toEqual(['stop', 'kill']);
    expect(r.got.join('')).toContain('"t":"exit"');
    expect(bystander.exitCode).toBeNull();
    expect(bystander.signalCode).toBeNull();
    bystander.kill();
    r.close();
  });

  it('a runner that goes on `exit` is not killed', async () => {
    const r = await deaf();
    const did: string[] = [];
    setTimeout(() => r.sock.destroy(), 5);
    expect(await retire(r.sock, r.socket, () => {}, { ms: 2000, kill: async () => void did.push('kill') })).toBe(true);
    expect(did).toEqual([]);
    r.close();
  });
});
