import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ScriptRunner } from '../../workspaces/script-runner.js';
import { mounts } from './mounts.js';
import type { AsRunner } from './podman.js';
import type { Bind } from './podman-args.js';
import { sandboxPrune } from './prune.js';
import { type SandboxRecord, sandboxRecords } from './records.js';

const DAY = 24 * 3600e3;
const ID = '00aa11bb22cc33dd';
const repos = { alpha: { branch: 'sp/C1-1-1', from: 'origin/main', base: 'abc' }, beta: { branch: 'sp/C1-1-1', from: 'origin/main', base: 'abc' } };
const CLEAN = '1\tok\tclean\t0\tsp/C1-1-1\t/x\n2\tok\tclean\t0\tsp/C1-1-1\t/y\n';

/** One person's stopped thread, last used `usedDaysAgo` days ago, with two worktrees. Everything done is in `log`, in order. */
function rig(o: { usedDaysAgo?: number; state?: string | Error; running?: () => boolean; remove?: boolean; repos?: SandboxRecord['repos'] | null; during?: () => void } = {}) {
  const data = mkdtempSync(path.join(os.tmpdir(), 'sp-prune-'));
  const log: string[] = [];
  const helped: { person: string; binds?: Bind[]; args: string[] }[] = [];
  const as: AsRunner = { run: async () => '', podman: async (args) => (log.push(`podman ${args.join(' ').replaceAll(data, '')}`), '') };
  const m = mounts({ as, root: '/opt/r1', dataDir: data });
  const records = sandboxRecords(path.join(data, 'records'));
  const real = records.delete;
  records.delete = (id) => (log.push(`record deleted ${id}`), real(id));
  const used = Date.now() - (o.usedDaysAgo ?? 15) * DAY;
  const record: SandboxRecord = { id: ID, person: 'pat', key: 'C1:1.1', createdAt: '', usedAt: new Date(used).toISOString(), ...(o.repos !== null && { repos: o.repos ?? repos }) };
  records.write(record);
  mkdirSync(m.workspace(record), { recursive: true });
  const helper = (person: string, binds?: Bind[]): ScriptRunner => ({
    clones: '/clones', workspace: () => '/workspace',
    run: async (script, args) => {
      helped.push({ person, binds, args: [script, ...args] });
      log.push(script);
      if (script !== 'ws-inspect.sh') return '';
      o.during?.();
      if (o.state instanceof Error) throw o.state;
      return o.state ?? CLEAN;
    },
  });
  let clock = Date.now();
  const p = sandboxPrune({
    as, records, mounts: m, helper, running: o.running ?? (() => false), lastUsed: async (r) => Date.parse(r.usedAt),
    remove: async (id) => (log.push(`remove ${id}`), o.remove ?? true), deleteRun: async (id) => (log.push(`run deleted ${id}`), true), now: () => clock,
  });
  return { p, log, helped, record, records, m, data, later: (ms: number) => void (clock += ms) };
}

describe('pruning a sandboxed thread (work 103, Prune)', () => {
  it('clean and pushed: Remove, the workspace and its registries, the branch, the run directory, and the record last', async () => {
    const t = rig();
    expect(await t.p.pruneIdle('pat')).toEqual([]);
    expect(t.log).toEqual([
      'ws-inspect.sh', `remove ${ID}`, 'podman unshare rm -rf -- /people/pat/sessions/C1-1-1 /people/pat/wt/C1-1-1', 'ws-forget.sh', `run deleted ${ID}`, `record deleted ${ID}`,
    ]);
    expect(t.records.get(ID)).toBeUndefined();
    const [inspect, forget] = t.helped;
    expect(inspect.args).toEqual(['ws-inspect.sh', '--only=state', '/clones', '/workspace', 'alpha', 'beta']);
    expect(inspect.binds).toEqual([
      { src: t.m.workspace(t.record), dst: '/workspace', ro: true },
      { src: t.m.registry(t.record, 'alpha'), dst: '/clones/alpha/.git/worktrees' },
      { src: t.m.registry(t.record, 'beta'), dst: '/clones/beta/.git/worktrees' },
    ]);
    expect(forget).toEqual({ person: 'pat', binds: undefined, args: ['ws-forget.sh', '/clones', 'sp/C1-1-1', 'alpha', 'beta'] });
  });

  it('not clean: only the container goes, and the reason is reported', async () => {
    const t = rig({ state: '1\tok\tdirty\t0\tsp/C1-1-1\t/x\n2\tok\tclean\t2\tsp/C1-1-1\t/y\n' });
    expect(await t.p.pruneIdle('pat')).toEqual([{ name: 'sessions/C1-1-1', problem: 'idle beyond retention, kept: alpha has uncommitted changes, beta has 2 unpushed commits' }]);
    expect(t.log).toEqual(['ws-inspect.sh', `podman rm --force sp-runner-${ID}`]);
    expect(t.records.get(ID)).toBeDefined();
    expect(existsSync(t.m.workspace(t.record))).toBe(true);
  });

  it('a count git could not make keeps the thread too', async () => {
    const t = rig({ state: '1\tok\tclean\t-1\tsp/C1-1-1\t/x\n2\tok\tclean\t0\tsp/C1-1-1\t/y\n' });
    expect((await t.p.pruneIdle('pat'))[0].problem).toContain('alpha: cannot count unpushed commits');
  });

  it('a kept thread is reported at every pass, and asked about again only after an hour or a use', async () => {
    const t = rig({ state: '1\tok\tdirty\t0\tb\t/x\n2\tok\tclean\t0\tb\t/y\n' });
    await t.p.pruneIdle('pat');
    expect(await t.p.pruneIdle('pat')).toHaveLength(1);
    expect(t.log.filter((l) => l === 'ws-inspect.sh')).toHaveLength(1);
    t.later(3600e3);
    expect(await t.p.pruneIdle('pat')).toHaveLength(1);
    expect(t.log.filter((l) => l === 'ws-inspect.sh')).toHaveLength(2);
  });

  it('leaves a thread used within the retention, one with a runner, and another person\'s', async () => {
    for (const t of [rig({ usedDaysAgo: 13 }), rig({ running: () => true })]) {
      expect(await t.p.pruneIdle('pat')).toEqual([]);
      expect(t.log).toEqual([]);
    }
    const other = rig();
    await other.p.pruneIdle('quinn');
    expect(other.log).toEqual([]);
  });

  it('a thread that got a runner, or was used, while git was asked is left whole', async () => {
    let running = false;
    const t = rig({ running: () => running, during: () => void (running = true) });
    expect(await t.p.pruneIdle('pat')).toEqual([]);
    expect(t.log).toEqual(['ws-inspect.sh']);
    const used = rig({ during: () => used.records.write({ ...used.record, usedAt: new Date().toISOString() }) });
    expect(await used.p.pruneIdle('pat')).toEqual([]);
    expect(used.log).toEqual(['ws-inspect.sh']);
  });

  it('a failed inspection or a failed Remove keeps everything, says so, and is tried again at the next pass', async () => {
    const t = rig({ state: new Error('helper timed out') });
    expect(await t.p.pruneIdle('pat')).toEqual([{ name: 'sessions/C1-1-1', problem: 'idle beyond retention, kept: prune failed: helper timed out' }]);
    await t.p.pruneIdle('pat');
    expect(t.log).toEqual(['ws-inspect.sh', 'ws-inspect.sh']);
    const stuck = rig({ remove: false });
    expect((await stuck.p.pruneIdle('pat'))[0].problem).toContain('prune failed: its container or its home was not removed');
    expect(stuck.log).toEqual(['ws-inspect.sh', `remove ${ID}`]);
    expect(stuck.records.get(ID)).toBeDefined();
  });

  it('a thread with no repositories has nothing git could say: it goes, and no branch is forgotten', async () => {
    const t = rig({ repos: null });
    expect(await t.p.pruneIdle('pat')).toEqual([]);
    expect(t.log).toEqual([`remove ${ID}`, 'podman unshare rm -rf -- /people/pat/sessions/C1-1-1 /people/pat/wt/C1-1-1', `run deleted ${ID}`, `record deleted ${ID}`]);
  });

  it('a branch the host did not make is not forgotten', async () => {
    const t = rig({ repos: { alpha: { branch: 'main', from: 'origin/main', base: 'abc' } }, state: '1\tok\tclean\t0\tmain\t/x\n' });
    await t.p.pruneIdle('pat');
    expect(t.log).not.toContain('ws-forget.sh');
    expect(t.records.get(ID)).toBeUndefined();
  });
});
