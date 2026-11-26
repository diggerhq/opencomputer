import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isLoopbackPeer, listen, type PeerCheck, SLOW_CHECK_MS } from './loopback.js';
import type { Roots } from './peer.js';

let dir: string | undefined;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe('loopback', () => {
  it('accepts only peers on this machine', () => {
    expect(isLoopbackPeer('127.0.0.1')).toBe(true);
    expect(isLoopbackPeer('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackPeer('10.0.0.5')).toBe(false);
    expect(isLoopbackPeer('::1')).toBe(false);
    expect(isLoopbackPeer(undefined)).toBe(false);
  });

  it('forwards 127.0.0.1:<port> to the unix socket both ways, and closes', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'loopback-'));
    const sock = path.join(dir, 'up.sock');
    const up = net.createServer((c) => c.pipe(c));
    await new Promise<void>((r) => up.listen(sock, r));
    const l = await listen(sock, { peerCheck: false });
    expect(l.port).toBeGreaterThan(0);
    const c = net.connect(l.port, '127.0.0.1');
    const req = 'POST /v1/responses HTTP/1.1\r\nhost: x\r\nAuthorization: Bearer ssh-placeholder\r\n\r\n';
    const got = await new Promise<string>((r) => {
      let all = '';
      c.on('data', (d) => ((all += d) === `${req}hi` ? r(all) : all.length > 200 && r(all)));
      c.write(req.slice(0, 20));
      setTimeout(() => c.write(req.slice(20)), 20);
      setTimeout(() => c.write('hi'), 60);
    });
    expect(got).toBe(`${req}hi`);
    const closed = new Promise((r) => c.on('close', r));
    l.close();
    await closed;
    up.close();
    await expect(new Promise((res, rej) => net.connect(l.port, '127.0.0.1').on('connect', res).on('error', rej))).rejects.toThrow();
  });

  it('listens on loopback only', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'loopback-'));
    const l = await listen(path.join(dir, 'none.sock'), { peerCheck: false });
    const nonLocal = Object.values((await import('node:os')).networkInterfaces())
      .flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
    if (nonLocal) await expect(new Promise((res, rej) => net.connect(l.port, nonLocal).on('connect', res).on('error', rej))).rejects.toThrow();
    l.close();
  });
  // A /proc whose net/ and processes are this machine's, with a cgroup of our choosing: this
  // process is in it (`in`) or not, so the check runs on real sockets without systemd.
  const fakeRoots = (inCgroup: boolean): Roots => {
    const proc = path.join(dir!, `proc-${inCgroup}`);
    const cgroup = path.join(dir!, `cg-${inCgroup}`);
    mkdirSync(path.join(proc, 'self'), { recursive: true });
    mkdirSync(path.join(cgroup, 'runner'), { recursive: true });
    symlinkSync('/proc/net', path.join(proc, 'net'));
    // This process's real fds, under a cgroup file that names the fake one.
    mkdirSync(path.join(proc, String(process.pid)));
    symlinkSync(`/proc/${process.pid}/fd`, path.join(proc, String(process.pid), 'fd'));
    writeFileSync(path.join(proc, String(process.pid), 'cgroup'), '0::/runner\n');
    writeFileSync(path.join(proc, 'self/cgroup'), '0::/runner\n');
    writeFileSync(path.join(cgroup, 'runner/cgroup.procs'), inCgroup ? `${process.pid}\n` : '');
    return { proc, cgroup };
  };
  const roundTrip = async (port: number) => {
    const c = net.connect(port, '127.0.0.1');
    return new Promise<string>((r) => {
      let all = '';
      c.on('data', (d) => (all += d) && c.end()).on('close', () => r(all)).on('error', () => r(all));
      c.write('GET /v1/models HTTP/1.1\r\nhost: x\r\n\r\n');
    });
  };

  it.runIf(process.platform === 'linux')("forwards a peer in this runner's cgroup, and nothing for one outside it", async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'loopback-'));
    const sock = path.join(dir, 'up.sock');
    let reached = 0;
    const up = net.createServer((c) => (reached++, c.end('ok')));
    await new Promise<void>((r) => up.listen(sock, r));
    const checks: PeerCheck[] = [];
    const inside = await listen(sock, { peerCheck: true, roots: fakeRoots(true), checked: (c) => checks.push(c) });
    expect(await roundTrip(inside.port)).toBe('ok');
    inside.close();
    const outside = await listen(sock, { peerCheck: true, roots: fakeRoots(false), checked: (c) => checks.push(c) });
    expect(await roundTrip(outside.port)).toBe('');
    expect(reached).toBe(1);
    // The refusal is reported with its code. An accept is reported only when it took over
    // SLOW_CHECK_MS, which a loaded CI runner can (25 ms seen), so only refusals are counted.
    expect(checks.filter((c) => !c.ok)).toEqual([expect.objectContaining({ ok: false, code: 'not_held' })]);
    for (const c of checks.filter((c) => c.ok)) expect(c.ms).toBeGreaterThan(SLOW_CHECK_MS);
    outside.close();
    up.close();
  });

  it('refuses every connection when /proc cannot be read (fails closed)', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'loopback-'));
    const sock = path.join(dir, 'up.sock');
    let reached = 0;
    const up = net.createServer((c) => (reached++, c.end('ok')));
    await new Promise<void>((r) => up.listen(sock, r));
    const checks: PeerCheck[] = [];
    const l = await listen(sock, { peerCheck: true, roots: { proc: path.join(dir, 'none'), cgroup: path.join(dir, 'none') }, checked: (c) => checks.push(c) });
    expect(await roundTrip(l.port)).toBe('');
    expect(checks).toEqual([expect.objectContaining({ ok: false, code: 'unreadable' })]);
    expect(reached).toBe(0);
    l.close();
    up.close();
  });
});
