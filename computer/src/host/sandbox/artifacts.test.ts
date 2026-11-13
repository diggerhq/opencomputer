import { lutimesSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ScriptRunner } from '../../workspaces/script-runner.js';
import { sandboxArtifacts } from './artifacts.js';
import { mounts } from './mounts.js';
import type { AsRunner } from './podman.js';
import type { Bind } from './podman-args.js';
import { type SandboxRecord, sandboxRecords } from './records.js';
import { threadLocks } from './thread-lock.js';
import { sandboxUses } from './use.js';

const HOUR = 3600e3;
const ago = (ms: number) => new Date(Date.now() - ms);
/** As git would answer: of the lines asked, the one that names node_modules. */
const ignoredLine = (stdin: string) => stdin.split('\n').indexOf('1\tnode_modules') + 1;
const repos = { alpha: { branch: 'sp/k', from: 'origin/main', base: 'abc' } };

/** One person's stopped thread with a worktree `alpha` holding node_modules (ignored) and .venv (tracked). */
function rig(o: { usedHoursAgo?: number; answer?: string; running?: () => boolean; asked?: () => void } = {}) {
  const locks = threadLocks();
  const data = mkdtempSync(path.join(os.tmpdir(), 'sp-art-'));
  const log: string[] = [];
  const helped: { person: string; binds: Bind[]; args: string[]; stdin?: string | Buffer }[] = [];
  const as: AsRunner = { settled: async () => {}, run: async () => '', podman: async (args) => (log.push(`podman ${args.join(' ').replaceAll(data, '')}`), '') };
  const m = mounts({ as, root: '/opt/r1', dataDir: data });
  const records = sandboxRecords(path.join(data, 'records'));
  const record: SandboxRecord = { id: '00aa11bb22cc33dd', person: 'pat', key: 'C1:1.1', createdAt: '', usedAt: ago((o.usedHoursAgo ?? 48) * HOUR).toISOString(), repos };
  records.write(record);
  const wt = path.join(m.workspace(record), 'alpha');
  for (const d of ['node_modules', '.venv', 'src']) mkdirSync(path.join(wt, d), { recursive: true });
  writeFileSync(path.join(wt, '.git'), 'gitdir: /clones/alpha/.git/worktrees/alpha\n');
  const admin = path.join(m.registry(record, 'alpha'), 'alpha');
  mkdirSync(path.join(admin, 'logs'), { recursive: true });
  for (const f of ['index', 'logs/HEAD']) {
    writeFileSync(path.join(admin, f), '');
    utimesSync(path.join(admin, f), ago(72 * HOUR), ago(72 * HOUR));
  }
  const helper = (person: string, binds: Bind[]): ScriptRunner => ({
    clones: '/clones', workspace: () => '/workspace',
    run: async (script, args, r) => (helped.push({ person, binds, args: [script, ...args], stdin: r.stdin }), o.asked?.(), o.answer ?? `1\tok\t-\t-\t-\t-\t${ignoredLine(String(r.stdin))}\n`),
  });
  const uses = sandboxUses({ as, records, workspace: m.workspace, unitActive: async () => false });
  const a = sandboxArtifacts({ as, records, locks, mounts: m, helper, running: o.running ?? (() => false), claim: uses.claim });
  return { a, uses, log, helped, record, records, locks, wt, admin, data };
}

describe('artifacts of a sandboxed thread (work 103, without host git)', () => {
  it('last use: the record, or a worktree\'s index or HEAD log in the thread\'s registry, whichever is latest', async () => {
    const t = rig();
    expect(await t.a.lastUsed(t.record)).toBe(Date.parse(t.record.usedAt));
    const recent = ago(HOUR);
    utimesSync(path.join(t.admin, 'logs', 'HEAD'), recent, recent);
    expect(await t.a.lastUsed(t.record)).toBe(recent.getTime());
    expect(await t.a.lastUsed({ ...t.record, repos: undefined })).toBe(Date.parse(t.record.usedAt));
  });

  it('last use follows no link a session left in a registry', async () => {
    const t = rig();
    const elsewhere = path.join(t.data, 'elsewhere');
    writeFileSync(elsewhere, '');
    const link = path.join(t.admin, 'index');
    const old = ago(96 * HOUR);
    rmSync(link);
    symlinkSync(elsewhere, link);
    lutimesSync(link, old, old);
    expect(await t.a.lastUsed(t.record)).toBe(Date.parse(t.record.usedAt)); // the link's own time, not its target's (now)
  });

  it('git is asked in a helper that sees the workspace read-only and the thread\'s registries; only what it calls ignored is removed, in the user namespace', async () => {
    const t = rig();
    const removed = await t.a.pruneArtifacts(t.record);
    expect(removed).toEqual([path.join(t.wt, 'node_modules')]);
    expect(t.helped).toEqual([{
      person: 'pat',
      binds: [
        { src: path.join(t.data, 'people/pat/sessions/C1-1-1'), dst: '/workspace', ro: true },
        { src: path.join(t.data, 'people/pat/wt/C1-1-1/alpha'), dst: '/clones/alpha/.git/worktrees' },
      ],
      args: ['ws-inspect.sh', '--only=ignored', '/clones', '/workspace', 'alpha'],
      stdin: expect.any(String),
    }]);
    expect(String(t.helped[0].stdin).split('\n').sort()).toEqual(['', '1\t.venv', '1\tnode_modules']);
    expect(t.log).toEqual(['podman unshare rm -rf -- /people/pat/sessions/C1-1-1/alpha/node_modules']);
  });

  it('a .wt that links to another workspace: nothing there is listed, asked about or removed', async () => {
    const t = rig();
    const other = path.join(t.data, 'people/quinn/sessions/C2-2-2');
    mkdirSync(path.join(other, 'theirs', 'node_modules'), { recursive: true });
    writeFileSync(path.join(other, 'theirs', '.git'), 'gitdir: /clones/theirs/.git/worktrees/theirs\n');
    symlinkSync(other, path.join(path.dirname(t.wt), '.wt'));
    expect(await t.a.pruneArtifacts(t.record)).toEqual([path.join(t.wt, 'node_modules')]);
    expect(t.helped[0].args).toEqual(['ws-inspect.sh', '--only=ignored', '/clones', '/workspace', 'alpha']);
    expect(t.log).toEqual(['podman unshare rm -rf -- /people/pat/sessions/C1-1-1/alpha/node_modules']);
  });

  it('a directory that became a link while git was asked is not removed', async () => {
    const t = rig();
    const other = path.join(t.data, 'people/quinn/sessions/C2-2-2/theirs');
    mkdirSync(path.join(other, 'node_modules'), { recursive: true });
    const a = sandboxArtifacts({
      as: { settled: async () => {}, run: async () => '', podman: async (args) => (t.log.push(args.join(' ')), '') }, records: t.records, locks: t.locks, mounts: mounts({ as: { settled: async () => {}, run: async () => '', podman: async () => '' }, root: '/opt/r1', dataDir: t.data }),
      helper: () => ({ clones: '/clones', workspace: () => '/workspace', run: async (_s, _a, r) => {
        rmSync(t.wt, { recursive: true });
        symlinkSync(other, t.wt);
        return `1\tok\t-\t-\t-\t-\t${ignoredLine(String(r.stdin))}\n`;
      } }), running: () => false, claim: () => () => {},
    });
    expect(await a.pruneArtifacts(t.record)).toEqual([]);
    expect(t.log).toEqual([]);
  });

  it('nothing is removed when git ignores nothing, or when the thread got a runner while git was asked', async () => {
    const none = rig({ answer: '1\tok\t-\t-\t-\t-\n' });
    expect(await none.a.pruneArtifacts(none.record)).toEqual([]);
    let asked = 0;
    const started = rig({ running: () => asked++ > 0 });
    await started.a.pruneIdle('pat');
    expect(started.helped.length).toBe(1);
    expect([none.log, started.log]).toEqual([[], []]);
  });

  it('nothing is removed under a /files script, nor after one that ran since git was asked (C13)', async () => {
    const reading = rig();
    const use = await reading.uses.enter(reading.record.id);
    expect(await reading.a.pruneArtifacts(reading.record)).toEqual([]);
    use.leave();
    let t: ReturnType<typeof rig>;
    const since = (t = rig({ asked: () => void t.uses.enter(t.record.id).then((u) => u.leave()) }));
    expect(await since.a.pruneArtifacts(since.record)).toEqual([]);
    expect([reading.log, since.log]).toEqual([[], []]);
  });

  it('nothing is removed while a start has the thread\'s turn, nor after it: the start wrote the record', async () => {
    let end: (() => void) | undefined;
    const t = rig({ asked: () => void t.locks.run('pat', 'C1:1.1', () => new Promise<void>((r) => (end = () => (t.records.write({ ...t.record, usedAt: new Date().toISOString() }), r())))) });
    const done = t.a.pruneArtifacts(t.record);
    // Git is asked after the worktrees were read from disk: however long that takes.
    while (!end) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 20));
    expect(t.log).toEqual([]);
    end();
    expect(await done).toEqual([]);
    expect(t.log).toEqual([]);
  });

  it('pruneIdle: only this person\'s threads, idle long enough, without a runner, and each once per use', async () => {
    const fresh = rig({ usedHoursAgo: 1 });
    await fresh.a.pruneIdle('pat');
    const running = rig({ running: () => true });
    await running.a.pruneIdle('pat');
    const other = rig();
    await other.a.pruneIdle('quinn');
    expect([fresh.helped, running.helped, other.helped]).toEqual([[], [], []]);
    const idle = rig();
    await idle.a.pruneIdle('pat');
    await idle.a.pruneIdle('pat');
    expect(idle.helped.length).toBe(1);
    expect(idle.log.length).toBe(1);
    idle.records.write({ ...idle.record, usedAt: ago(30 * HOUR).toISOString() });
    await idle.a.pruneIdle('pat');
    expect(idle.helped.length).toBe(2);
  });

  it('a helper that fails removes nothing and does not stop the others', async () => {
    const t = rig();
    const a = sandboxArtifacts({
      as: { settled: async () => {}, run: async () => '', podman: async (args) => (t.log.push(args.join(' ')), '') }, records: t.records, locks: t.locks, mounts: mounts({ as: { settled: async () => {}, run: async () => '', podman: async () => '' }, root: '/opt/r1', dataDir: t.data }),
      helper: () => ({ clones: '/clones', workspace: () => '/workspace', run: async () => Promise.reject(new Error('ws-inspect.sh: timed out')) }), running: () => false, claim: () => () => {},
    });
    await a.pruneIdle('pat');
    expect(t.log).toEqual([]);
  });
});
