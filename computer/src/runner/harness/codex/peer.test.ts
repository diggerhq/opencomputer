// The kernel-attested peer check against a fake /proc and cgroup tree.

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attest, cgroupPath, type Roots, socketInode } from './peer.js';

const HEAD = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
// 127.0.0.1:50000 (C350) -> 127.0.0.1:8080 (1F90): the client's socket, inode 777; and the server's accepted side, 778.
const TCP =
  HEAD +
  '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 700 1 0000000000000000 100 0 0 10 0\n' +
  '   1: 0100007F:C350 0100007F:1F90 01 00000000:00000000 00:00000000 00000000  1000        0 777 1 0000000000000000 20 4 30 10 -1\n' +
  '   2: 0100007F:1F90 0100007F:C350 01 00000000:00000000 00:00000000 00000000  1000        0 778 1 0000000000000000 20 4 30 10 -1\n';

let dir: string;
let roots: Roots;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'peer-'));
  roots = { proc: path.join(dir, 'proc'), cgroup: path.join(dir, 'cg') };
  mkdirSync(path.join(roots.proc, 'net'), { recursive: true });
  mkdirSync(path.join(roots.proc, 'self'), { recursive: true });
  writeFileSync(path.join(roots.proc, 'net/tcp'), TCP);
  writeFileSync(path.join(roots.proc, 'self/cgroup'), '0::/user.slice/sp-runner-a.service\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const OURS = '/user.slice/sp-runner-a.service';
/** Process `pid`, in cgroup `cg`, with fds pointing at `targets`. */
function proc(pid: number, targets: string[], cg = OURS) {
  const fd = path.join(roots.proc, String(pid), 'fd');
  mkdirSync(fd, { recursive: true });
  for (const [i, t] of targets.entries()) symlinkSync(t, path.join(fd, String(i)));
  writeFileSync(path.join(roots.proc, String(pid), 'cgroup'), `0::${cg}\n`);
}
function members(cg: string, pids: number[]) {
  mkdirSync(path.join(roots.cgroup, cg), { recursive: true });
  writeFileSync(path.join(roots.cgroup, cg, 'cgroup.procs'), pids.map((p) => `${p}\n`).join(''));
}

describe('peer', () => {
  it('finds the client side of a loopback connection by its two ports', () => {
    expect(socketInode(TCP, 50000, 8080)).toBe('777');
    expect(socketInode(TCP, 8080, 50000)).toBe('778');
    expect(socketInode(TCP, 50001, 8080)).toBeUndefined();
    // Either byte order of 127.0.0.1; never a socket that is not on loopback, nor inode 0 (a TIME_WAIT).
    expect(socketInode(`${HEAD}   0: 7F000001:C350 7F000001:1F90 01 0:0 0:0 0 1000 0 9 1\n`, 50000, 8080)).toBe('9');
    expect(socketInode(`${HEAD}   0: 0500000A:C350 0100007F:1F90 01 0:0 0:0 0 1000 0 9 1\n`, 50000, 8080)).toBeUndefined();
    expect(socketInode(`${HEAD}   0: 0100007F:C350 0100007F:1F90 06 0:0 0:0 0 0 0 0 1\n`, 50000, 8080)).toBeUndefined();
  });

  it("reads cgroup v2's path only", () => {
    expect(cgroupPath('0::/a/b.service\n')).toBe('/a/b.service');
    expect(cgroupPath('12:pids:/a\n1:name=systemd:/a\n')).toBeUndefined();
  });

  it("attests a peer whose socket a process in this runner's cgroup holds", () => {
    members('user.slice/sp-runner-a.service', [10, 11]);
    proc(10, ['/dev/null', 'socket:[778]']);
    proc(11, ['pipe:[5]', 'socket:[777]']);
    expect(attest(50000, 8080, roots)).toEqual({ ok: true, pid: 11, pids: 2, fds: 4 });
  });

  it("refuses a peer in another session's cgroup, though the same user runs both", () => {
    members('user.slice/sp-runner-a.service', [10]);
    members('user.slice/sp-runner-b.service', [20]);
    proc(10, ['socket:[778]']);
    proc(20, ['socket:[777]'], '/user.slice/sp-runner-b.service');
    const a = attest(50000, 8080, roots);
    expect(a).toMatchObject({ ok: false, why: expect.stringContaining('777'), pids: 1, fds: 1 });
  });

  it('fails closed when it cannot tell', () => {
    members('user.slice/sp-runner-a.service', [10]);
    proc(10, ['socket:[777]']);
    expect(attest(50001, 8080, roots)).toMatchObject({ ok: false, why: expect.stringContaining('no socket') });
    writeFileSync(path.join(roots.proc, 'self/cgroup'), '1:name=systemd:/x\n');
    expect(attest(50000, 8080, roots)).toMatchObject({ ok: false, why: expect.stringContaining('cgroup v2') });
    writeFileSync(path.join(roots.proc, 'self/cgroup'), '0::/elsewhere\n');
    expect(attest(50000, 8080, roots)).toMatchObject({ ok: false, why: expect.stringContaining('ENOENT') });
    rmSync(path.join(roots.proc, 'net'), { recursive: true });
    expect(attest(50000, 8080, roots).ok).toBe(false);
  });

  it('skips a process that exited since the cgroup was read', () => {
    members('user.slice/sp-runner-a.service', [9, 10]);
    proc(10, ['socket:[777]']);
    expect(attest(50000, 8080, roots)).toMatchObject({ ok: true, pid: 10 });
  });

  it('refuses a process that left this cgroup between cgroup.procs and its fds', () => {
    members('user.slice/sp-runner-a.service', [10]);
    proc(10, ['socket:[777]'], '/user.slice/sp-runner-b.service');
    expect(attest(50000, 8080, roots)).toMatchObject({ ok: false, why: expect.stringContaining('777') });
    // Another process still in it that holds the same socket (a fork) does pass.
    members('user.slice/sp-runner-a.service', [10, 11]);
    proc(11, ['socket:[777]']);
    expect(attest(50000, 8080, roots)).toMatchObject({ ok: true, pid: 11 });
  });

  it('reads the likely holders first (a Codex shim and its native child), and only members of the cgroup', () => {
    members('user.slice/sp-runner-a.service', [10, 11, 20, 21]);
    proc(10, ['/dev/null', '/dev/null', '/dev/null']);
    proc(11, ['/dev/null', '/dev/null']);
    proc(20, ['/dev/null']);
    proc(21, ['socket:[777]']);
    mkdirSync(path.join(roots.proc, '20/task/20'), { recursive: true });
    writeFileSync(path.join(roots.proc, '20/task/20/children'), '21 ');
    // The shim (20) first, then its child (21): two fds read, not the whole cgroup's.
    expect(attest(50000, 8080, roots, [20])).toEqual({ ok: true, pid: 21, pids: 4, fds: 2 });
    // Without a hint, the same answer the long way.
    expect(attest(50000, 8080, roots)).toEqual({ ok: true, pid: 21, pids: 4, fds: 7 });
    // A likely pid outside the cgroup is never read.
    proc(30, ['socket:[777]'], '/user.slice/sp-runner-b.service');
    members('user.slice/sp-runner-a.service', [10, 11]);
    expect(attest(50000, 8080, roots, [30])).toMatchObject({ ok: false, fds: 5 });
  });
});
