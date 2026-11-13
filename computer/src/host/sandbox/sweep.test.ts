import { existsSync, mkdirSync, mkdtempSync, utimesSync } from 'node:fs';
import type net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ContainerInfo, Inventory } from './containers.js';
import { PodmanError } from './podman.js';
import type { SandboxRecord } from './records.js';
import { type SweepDeps, sandboxSweep } from './sweep.js';
import { threadLocks } from './thread-lock.js';

const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const C = 'cccccccccccccccc';
// An hour ahead of the clock: a directory this test makes has a change time the kernel set, and it must count as old.
const NOW = Date.now() + 3_600_000;
const OLD = NOW - 11 * 60_000;
const record = (id: string, usedAt = OLD): SandboxRecord => ({ id, person: 'p', key: `C1:${id}`, createdAt: '', usedAt: new Date(usedAt).toISOString() });
const box = (id: string, state = 'running', createdAt = OLD): ContainerInfo => ({ id, state, abi: '1', image: 'img', createdAt });

function rig(o: { inventory?: Partial<Inventory> | Error; records?: SandboxRecord[]; running?: string[]; sockets?: string[]; adopt?: (r: SandboxRecord) => Promise<unknown>; unread?: string[];
  answer?: (argv: string[]) => string | Error; remove?: boolean; over?: Partial<SweepDeps> } = {}) {
  const runDir = mkdtempSync(path.join(tmpdir(), 'sweep-'));
  const log: string[] = [];
  const events: { name: string; data: unknown }[] = [];
  const run = async (argv: string[]) => {
    log.push(argv.join(' '));
    const a = o.answer?.(argv) ?? '';
    if (a instanceof Error) throw a;
    return a;
  };
  const records = new Map((o.records ?? []).map((r) => [r.id, r]));
  const runRoot = (id: string) => path.join(runDir, id);
  const s = sandboxSweep({
    as: { settled: async () => {}, run, podman: (args) => run(['podman', ...args]) },
    tm: { emit: (name: string, f: { data: unknown }) => void events.push({ name, data: f.data }) } as never,
    records: { all: () => [...records.values()], get: (id) => records.get(id), unread: () => o.unread ?? [] },
    locks: threadLocks(),
    containers: {
      inventory: async () => {
        log.push('inventory');
        if (o.inventory instanceof Error) throw o.inventory;
        return { containers: [], volumes: [], foreign: [], ...o.inventory };
      },
      stop: async (id) => void log.push(`stop ${id}`),
      remove: async (id) => (log.push(`remove ${id}`), o.remove ?? true),
    },
    runDir, runRoot, dataDir: runDir,
    serveTokens: (_run, id, session) => (log.push(`tokens ${id} ${session()}`), { close: () => void log.push(`tokens closed ${id}`) }),
    dial: async (socket) => (log.push(`dial ${path.relative(runDir, socket)}`), (o.sockets ?? []).some((id) => socket === path.join(runRoot(id), 'runners', `${id}.sock`)) ? ({ destroy: () => {} } as net.Socket) : undefined),
    adopt: async (r) => (log.push(`adopt ${r.id} ${r.key}`), o.adopt?.(r)),
    running: (id) => (o.running ?? []).includes(id),
    now: () => NOW,
    ...o.over,
  });
  /** A run directory last touched at `at`. */
  const dir = (id: string, at = OLD) => {
    mkdirSync(runRoot(id));
    utimesSync(runRoot(id), at / 1000, at / 1000);
    return runRoot(id);
  };
  return { s, log, events, runRoot, dir, ran: (word: string) => log.filter((l) => l.includes(word)) };
}

describe('host restart', () => {
  it('takes back a running container as its record: token socket, checked dial, adopt; in that order', async () => {
    const t = rig({ inventory: { containers: [box(A)] }, records: [record(A)], sockets: [A] });
    expect([...(await t.s.reconcile())]).toEqual([A]);
    expect(t.log).toEqual(['inventory', `tokens ${A} C1:${A}`, `dial ${A}/runners/${A}.sock`, `adopt ${A} C1:${A}`]);
  });

  it('stops a running container whose record says its spare was never claimed: it is not taken back, whatever its runner would report', async () => {
    const t = rig({ inventory: { containers: [box(A)] }, records: [{ ...record(A), unclaimed: true }], sockets: [A] });
    expect((await t.s.reconcile()).size).toBe(0);
    expect(t.log).toEqual(['inventory', `stop ${A}`]);
  });

  it('stops a running container whose socket does not answer, or whose runner is not the record\'s; removes neither', async () => {
    const silent = rig({ inventory: { containers: [box(A)] }, records: [record(A)] });
    expect((await silent.s.reconcile()).size).toBe(0);
    expect(silent.log.slice(-2)).toEqual([`stop ${A}`, `tokens closed ${A}`]);
    const other = rig({ inventory: { containers: [box(A)] }, records: [record(A)], sockets: [A], adopt: () => Promise.reject(new Error('it reports another key')) });
    expect((await other.s.reconcile()).size).toBe(0);
    expect(other.log.slice(-3)).toEqual([`adopt ${A} C1:${A}`, `stop ${A}`, `tokens closed ${A}`]);
    expect(other.ran('remove')).toEqual([]);
  });

  it('leaves a stopped container for its next message, and removes every container without a record whatever its age', async () => {
    const t = rig({ inventory: { containers: [box(A, 'exited'), box(B, 'created'), box(C, 'running', NOW)] }, records: [record(A), record(B)] });
    t.dir(C, NOW);
    await t.s.reconcile();
    // C14: a spare of the host before this one is never taken back, and its run directory goes with it.
    expect(t.log).toEqual(['inventory', `remove ${C}`, expect.stringMatching(new RegExp(`^podman unshare find .*${C}/runners`))]);
    expect(existsSync(t.runRoot(C))).toBe(false);
  });

  it('does nothing when the inventory fails', async () => {
    const t = rig({ inventory: new Error('timed out'), records: [record(A)] });
    expect((await t.s.reconcile()).size).toBe(0);
    expect(t.log).toEqual(['inventory']);
  });
});

describe('sweep', () => {
  it('does nothing when the inventory fails', async () => {
    const t = rig({ inventory: new Error('timed out') });
    t.dir(A);
    expect(await t.s.sweep()).toBeUndefined();
    expect(t.log).toEqual(['inventory']);
    expect(existsSync(t.runRoot(A))).toBe(true);
  });

  it('an id whose record file did not load has a record: its container, its home and its run directory stay, at the start and at every sweep', async () => {
    const t = rig({ inventory: { containers: [box(A), box(B, 'exited')], volumes: [{ id: A, createdAt: OLD }, { id: B, createdAt: OLD }, { id: C, createdAt: OLD }] }, unread: [A, B, C] });
    for (const id of [A, B, C]) t.dir(id);
    expect((await t.s.reconcile()).size).toBe(0);
    expect(t.log).toEqual(['inventory', `stop ${A}`]); // running with nobody who could take it back: stopped, as any other
    expect(await t.s.sweep()).toMatchObject({ containers: 0, volumes: 0, run_dirs: 0 });
    expect(t.ran('remove')).toEqual([]);
    expect(t.ran('volume rm')).toEqual([]);
    for (const id of [A, B, C]) expect(existsSync(t.runRoot(id))).toBe(true);
  });

  it('removes an old container with no record and no runner; never one with a record, a runner, or younger than 10 minutes', async () => {
    const D = 'dddddddddddddddd';
    const t = rig({ inventory: { containers: [box(A), box(B), box(C), box(D, 'exited', NOW - 9 * 60_000)] }, records: [record(B)], running: [C] });
    expect(await t.s.sweep()).toMatchObject({ containers: 1 });
    expect(t.ran('remove')).toEqual([`remove ${A}`]);
    expect(t.events).toEqual([{ name: 'sandbox.swept', data: { containers: 1, volumes: 0, run_dirs: 0, units: 0 } }]);
  });

  it('removes a home only with no container of its id anywhere, no record, and a run directory of this host; without --force', async () => {
    const [D, E] = ['dddddddddddddddd', 'eeeeeeeeeeeeeeee'];
    const vol = (id: string, createdAt = OLD) => ({ id, createdAt });
    const t = rig({ inventory: { containers: [box(B, 'exited')], volumes: [vol(A), vol(B), vol(C), vol(D), vol(E), vol('ffffffffffffffff', NOW)], foreign: [C] }, records: [record(B), record(D)] });
    for (const id of [A, B, C, D, 'ffffffffffffffff']) t.dir(id); // none for E: nothing says it was this host's
    expect(await t.s.sweep()).toMatchObject({ volumes: 1, containers: 0 });
    expect(t.ran('volume rm')).toEqual([`podman volume rm sp-home-${A}`]);
  });

  it('a home labelled as this host\'s goes without its run directory (a reboot empties /run); one labelled as another host\'s never; one without the label only with the directory', async () => {
    const [D, E, F, G] = ['dddddddddddddddd', 'eeeeeeeeeeeeeeee', 'ffffffffffffffff', '0000000000000000'];
    const vol = (id: string, mine?: boolean, createdAt = OLD) => ({ id, createdAt, ...(mine !== undefined && { mine }) });
    const t = rig({ inventory: { containers: [box(D, 'exited')], volumes: [vol(A, true), vol(B, false), vol(C), vol(D, true), vol(E, true), vol(F, true, NOW), vol(G, true)], foreign: [G] }, records: [record(D), record(E)] });
    t.dir(B); // even with a directory here, the label says whose it is
    expect(await t.s.sweep()).toMatchObject({ volumes: 1, containers: 0 });
    expect(t.ran('volume rm')).toEqual([`podman volume rm sp-home-${A}`]);
  });

  it('deletes an old run directory with no container, home or runner: the session\'s part inside the user namespace, then the rest', async () => {
    const [D, E] = ['dddddddddddddddd', 'eeeeeeeeeeeeeeee'];
    const t = rig({ inventory: { containers: [box(B, 'exited')], volumes: [{ id: C, createdAt: NOW }] }, records: [record(B), record(E, NOW)], running: [D] });
    for (const id of [A, B, C, D, E]) t.dir(id);
    t.dir('ffffffffffffffff', NOW);
    mkdirSync(path.join(t.runRoot(A), '..', 'not-an-id'));
    expect(await t.s.sweep()).toMatchObject({ run_dirs: 1 });
    expect(existsSync(t.runRoot(A))).toBe(false);
    expect(t.ran('unshare')).toEqual([`podman unshare find ${t.runRoot(A)}/runners ${t.runRoot(A)}/secrets -mindepth 1 -delete`]);
    for (const id of [B, C, D, E, 'ffffffffffffffff', 'not-an-id']) expect(existsSync(t.runRoot(id))).toBe(true);
  });

  it('a run directory of a thread that is starting is left: the sweep waits for the thread\'s turn, then looks again', async () => {
    const locks = threadLocks();
    let rec = record(A);
    const t = rig({ over: { locks, records: { all: () => [rec], get: () => rec, unread: () => [] } } });
    t.dir(A);
    let end!: () => void;
    // A start: it has the turn, writes its record, and makes its container on this directory.
    void locks.run('p', `C1:${A}`, () => new Promise<void>((r) => (end = () => ((rec = record(A, NOW)), r()))));
    const pass = t.s.sweep();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.ran('unshare')).toEqual([]);
    end();
    expect(await pass).toMatchObject({ run_dirs: 0 });
    expect(existsSync(t.runRoot(A))).toBe(true);
    // A thread nobody starts: its old run directory goes, in its turn.
    const idle = rig({ records: [record(B)] });
    idle.dir(B);
    expect(await idle.s.sweep()).toMatchObject({ run_dirs: 1 });
  });

  it('keeps a run directory whose content could not be removed, and one whose home could not be', async () => {
    const t = rig({ answer: (a) => (a[2] === 'find' ? new PodmanError('x', 1, 'find: cannot delete: Permission denied\n', false) : '') });
    t.dir(A);
    expect(await t.s.sweep()).toMatchObject({ run_dirs: 0 });
    expect(existsSync(t.runRoot(A))).toBe(true);
    const home = rig({ inventory: { volumes: [{ id: A, createdAt: OLD }] }, answer: (a) => (a[1] === 'volume' ? new PodmanError('in use', 2, 'volume is being used', false) : '') });
    home.dir(A);
    expect(await home.s.sweep()).toMatchObject({ volumes: 0, run_dirs: 0 });
    expect(existsSync(home.runRoot(A))).toBe(true);
  });

  it('a container that Remove left a part of keeps its run directory for the next pass', async () => {
    const t = rig({ inventory: { containers: [box(A)], volumes: [{ id: A, createdAt: OLD }] }, remove: false });
    t.dir(A);
    expect(await t.s.sweep()).toEqual({ containers: 0, volumes: 0, run_dirs: 0, units: 0 });
    expect(existsSync(t.runRoot(A))).toBe(true);
    expect(t.events).toEqual([]);
  });

  it('resets the failed units of its own sandboxes only', async () => {
    const t = rig({
      records: [record(A)],
      inventory: { containers: [box(A, 'exited')] },
      answer: (a) => (a.includes('list-units') ? `sp-runner-${A}.service loaded failed failed x\nsp-runner-${B}.service loaded failed failed x\nsp-runner-${C}.service loaded failed failed x\n` : ''),
    });
    t.dir(B); // deleted in this very pass, and its unit is still this host's
    expect(await t.s.sweep()).toMatchObject({ units: 2, run_dirs: 1 });
    expect(t.ran('reset-failed')).toEqual([`/usr/bin/systemctl --user reset-failed sp-runner-${A}.service sp-runner-${B}.service`]);
  });

  it('health: containers by state and Podman\'s total, as of the last sweep', async () => {
    const df = JSON.stringify([{ Type: 'Images', RawSize: 3000 }, { Type: 'Containers', RawSize: 200 }, { Type: 'Local Volumes', RawSize: 1 }]);
    const t = rig({ inventory: { containers: [box(A), box(B, 'exited'), box(C, 'stopping')] }, records: [record(A), record(B), record(C)], answer: (a) => (a[1] === 'system' ? df : '') });
    expect(t.s.health()).toBeUndefined();
    await t.s.sweep();
    expect(t.s.health()).toMatchObject({ containers_running: 1, containers_exited: 1, containers_created: 0, containers_other: 1, podman_bytes: 3201 });
    expect(t.s.health()?.data_used_pct).toBeGreaterThanOrEqual(0);
  });
});
