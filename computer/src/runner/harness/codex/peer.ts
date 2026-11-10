// Who is on the other end of a loopback connection, asked of the kernel
// (work 082, #129 review). Every runner runs as the same user, so a key in
// Codex's environment is readable by any other session's shell through
// /proc/<pid>/environ; which processes hold the connecting socket is not
// something the peer says. Each runner is a systemd unit of its own
// (host/launch.ts), so its cgroup is the runner, its Codex and the commands
// they run.
//
// Trust boundary: cgroup identity holds only against processes that cannot
// write cgroup.procs. A runner's cgroup lives in the agent user's own user
// manager, whose cgroups agent owns, so a session's shell can move itself
// into another runner's cgroup and then pass this check. That is the same
// boundary as the model proxy's cgroup identity for Claude
// (modelproxy/identity.go, work 077): Codex is equal to Claude here, not
// stronger. Closing it for both (runner cgroups agent cannot write) is
// tracked in work 082.
//
// Invariants:
// - a peer is attested only when a process in this process's own cgroup
//   holds the connecting socket: its inode is found in <proc>/net/tcp by the
//   connection's two ports, that `socket:[inode]` in the fd table of a pid
//   listed in the cgroup's cgroup.procs, and that pid's /proc/<pid>/cgroup
//   still names this cgroup after the fd was found; nothing the peer sends
//   counts;
// - it fails closed: an unreadable /proc or cgroup, a cgroup v1 machine, or
//   a connection not found is `ok: false` with the reason, never a pass;
// - it reads only this cgroup's processes' fd tables, synchronously, once
//   per connection. Codex 0.163.0 opens a connection per request (end-to-end
//   run), so the processes most likely to hold it (`likely`: the Codex
//   app-servers and their children, the npm shim's native binary) are read
//   first, and the whole cgroup only when none of them does; `likely` orders
//   the search and never widens it: each pid must still be in cgroup.procs;
// - `roots` exists for tests (a fake /proc); production passes the defaults.

import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import path from 'node:path';

export interface Roots {
  /** procfs, `/proc`. */
  proc: string;
  /** cgroup v2's mount, `/sys/fs/cgroup`. */
  cgroup: string;
}

export const ROOTS: Roots = { proc: '/proc', cgroup: '/sys/fs/cgroup' };

/** Why a peer was refused, as a closed set (telemetry); `why` says it in full (logs). */
export type Refusal = 'no_socket' | 'no_cgroup' | 'unreadable' | 'not_held';

export type Attested = { ok: true; pid: number; pids: number; fds: number } | { ok: false; code: Refusal; why: string; pids?: number; fds?: number };

/** 127.0.0.1 as /proc/net/tcp writes it: in host byte order, so either way round. */
const LOOPBACK_HEX = new Set(['0100007F', '7F000001']);
const portHex = (p: number) => p.toString(16).toUpperCase().padStart(4, '0');

/** The inode of the IPv4 socket bound to 127.0.0.1:`from` and connected to 127.0.0.1:`to`, from a /proc/net/tcp table. */
export function socketInode(table: string, from: number, to: number) {
  const [local, remote] = [portHex(from), portHex(to)];
  for (const line of table.split('\n')) {
    // sl local rem st tx:rx tr:when retrnsmt uid timeout inode ...
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    const [la, lp] = f[1].split(':');
    const [ra, rp] = f[2].split(':');
    if (lp === local && rp === remote && LOOPBACK_HEX.has(la) && LOOPBACK_HEX.has(ra) && f[9] !== '0') return f[9];
  }
  return undefined;
}

/** This process's cgroup v2 path, from a /proc/<pid>/cgroup file (`0::/path`); undefined on v1-only. */
export function cgroupPath(file: string) {
  return /^0::(\/.*)$/m.exec(file)?.[1];
}

/** Whether a process in this process's cgroup holds the socket that connected from 127.0.0.1:`peerPort` to our 127.0.0.1:`ourPort`. */
export function attest(peerPort: number, ourPort: number, roots: Roots = ROOTS, likely: Iterable<number> = []): Attested {
  let inode: string | undefined;
  let cg: string | undefined;
  let pids: number[];
  try {
    inode = socketInode(readFileSync(path.join(roots.proc, 'net/tcp'), 'latin1'), peerPort, ourPort);
    if (!inode) return { ok: false, code: 'no_socket', why: `no socket from port ${peerPort} in ${roots.proc}/net/tcp` };
    cg = cgroupPath(readFileSync(path.join(roots.proc, 'self/cgroup'), 'utf8'));
    if (!cg) return { ok: false, code: 'no_cgroup', why: 'no cgroup v2 path in /proc/self/cgroup' };
    pids = readFileSync(path.join(roots.cgroup, cg, 'cgroup.procs'), 'utf8').split('\n').filter(Boolean).map(Number);
  } catch (e) {
    return { ok: false, code: 'unreadable', why: (e as Error).message };
  }
  const want = `socket:[${inode}]`;
  /** Whether `pid` is (still) in our cgroup: cgroup.procs was read before its fds, so it may have moved since. */
  const inOurs = (pid: number) => {
    try {
      return cgroupPath(readFileSync(path.join(roots.proc, String(pid), 'cgroup'), 'utf8')) === cg;
    } catch {
      return false;
    }
  };
  let fds = 0;
  for (const pid of searchOrder(pids, likely, roots)) {
    const dir = path.join(roots.proc, String(pid), 'fd');
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue; // exited since, or not ours to read
    }
    for (const n of names) {
      fds++;
      try {
        if (readlinkSync(path.join(dir, n)) !== want) continue;
      } catch {
        continue;
      }
      if (inOurs(pid)) return { ok: true, pid, pids: pids.length, fds };
      break; // holds it, but moved out of our cgroup: on to the next pid
    }
  }
  return { ok: false, code: 'not_held', why: `no process in this runner's cgroup holds socket ${inode}`, pids: pids.length, fds };
}

/** `pids`, with those of `likely` (and their children) among them first. */
function searchOrder(pids: number[], likely: Iterable<number>, roots: Roots) {
  const member = new Set(pids);
  const first = new Set<number>();
  for (const pid of likely) {
    if (!member.has(pid)) continue;
    first.add(pid);
    for (const c of children(pid, roots)) if (member.has(c)) first.add(c);
  }
  if (!first.size) return pids;
  return [...first, ...pids.filter((p) => !first.has(p))];
}

/** The children of `pid`'s main thread (where Node spawns), from procfs; none when unreadable. */
function children(pid: number, roots: Roots) {
  try {
    return readFileSync(path.join(roots.proc, String(pid), 'task', String(pid), 'children'), 'utf8').split(' ').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}
