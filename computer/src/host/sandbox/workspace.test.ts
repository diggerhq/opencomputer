import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ScriptRunner } from '../../workspaces/script-runner.js';
import type { AsRunner } from './podman.js';
import type { SandboxRecord } from './records.js';

// HOST_DATA is read when protocol.ts loads, so SP_DATA must be set first.
const data = mkdtempSync(path.join(os.tmpdir(), 'sp-wsp-'));
process.env.SP_DATA = data;
const definition = path.join(data, 'def', 'acme.json');
process.env.SP_DEFINITION = definition;
const { useScripts } = await import('../../workspaces/clones.js');
const { mounts } = await import('./mounts.js');
const { sandboxRecords } = await import('./records.js');
const { NO_DEFINITION, sandboxWorkspaces } = await import('./workspace.js');

mkdirSync(path.dirname(definition), { recursive: true });
writeFileSync(path.join(data, 'def', 'AGENTS.md'), 'house rules\n');
writeFileSync(definition, JSON.stringify({
  name: 'acme',
  repos: [
    { name: 'alpha', remote: 'https://github.com/acme/alpha' },
    { name: 'beta', remote: 'https://github.com/acme/beta', branch: 'trunk' },
    { name: 'lazy', remote: 'https://github.com/acme/lazy', clone: 'lazy', description: 'on demand' },
  ],
  rootFiles: { 'AGENTS.md': 'AGENTS.md' },
}));

const ID = '00aa11bb22cc33dd';
const ws = path.join(data, 'people', 'pat', 'ws');
const clone = (name: string) => mkdirSync(path.join(ws, name, '.git'), { recursive: true });
/** The names of the regular files in a tar stream. */
const tarNames = (tar: Buffer) => {
  const names: string[] = [];
  for (let at = 0; at + 512 <= tar.length && tar[at]; ) {
    names.push(tar.subarray(at, at + 100).toString().replace(/\0.*$/, ''));
    at += 512 + Math.ceil(Number.parseInt(tar.subarray(at + 124, at + 135).toString(), 8) / 512) * 512;
  }
  return names;
};
const tarText = (tar: Buffer, name: string) => {
  const at = tar.indexOf(Buffer.from(name.padEnd(100, '\0')));
  return tar.subarray(at + 512, at + 512 + Number.parseInt(tar.subarray(at + 124, at + 135).toString(), 8)).toString();
};

function rig(answer: (args: string[]) => string | Error = (args) => args.slice(4).map((a) => `${a.split('=')[0]}\tok\tsp/C1-1-1\t${a.split('=')[1] ?? 'main'}\tabc123\t\n`).join('')) {
  const log: string[] = [];
  const runs: { args: string[]; stdin?: Buffer; timeoutMs: number }[] = [];
  const as: AsRunner = { run: async (argv) => (log.push(argv.join(' ').replaceAll(data, '')), ''), podman: async (args) => (log.push(`podman ${args.slice(0, 7).join(' ').replaceAll(data, '')}`), '') };
  const records = sandboxRecords(mkdtempSync(path.join(data, 'records-')));
  const record: SandboxRecord = { id: ID, person: 'pat', key: 'C1:1.1', createdAt: '2026-11-12T00:00:00.000Z', usedAt: '2026-11-12T00:00:00.000Z' };
  records.write(record);
  const scripts = (): ScriptRunner => ({
    clones: '/clones', workspace: () => '/workspace',
    async run(script, args, o) {
      runs.push({ args, stdin: o.stdin as Buffer | undefined, timeoutMs: o.timeoutMs });
      log.push(`${script} ${args.slice(3).join(' ')}${o.stdin ? ' <tar' : ''}`);
      const a = o.stdin ? '' : answer(args);
      if (a instanceof Error) throw a;
      return a;
    },
  });
  const w = sandboxWorkspaces({ as, records, mounts: mounts({ as, root: '/opt/r1', dataDir: data }), scripts, pid: async () => 4242 });
  return { w, log, runs, records, record };
}

beforeEach(() => {
  rmSync(ws, { recursive: true, force: true });
  clone('alpha');
  clone('beta');
  writeFileSync(path.join(ws, '.workspace-prepared'), 'now\n'); // nothing is cloned in the background
  useScripts(() => ({
    clones: ws, workspace: () => '',
    run: async (_s, args) => (clone(args[1]), `${args[1]}\tok\n`),
  }));
});

describe('a sandboxed thread\'s workspace (work 103, "Sequences")', () => {
  it('a start mounts the definition\'s cloned repositories, then the record\'s once it has any', () => {
    const t = rig();
    expect(t.w.repos(t.record)).toEqual(['alpha', 'beta']); // lazy is not cloned
    expect(t.w.repos({ ...t.record, repos: {} })).toEqual([]);
    clone('lazy');
    expect(t.w.repos({ ...t.record, repos: { lazy: { branch: 'b', from: 'origin/main', base: 'x' }, gone: { branch: 'b', from: 'origin/main', base: 'x' } } })).toEqual(['lazy']);
  });

  it('dirs: the workspace and a registry per repository, made as the runners\' user in one command', async () => {
    const t = rig();
    await t.w.dirs(t.record, ['alpha', 'beta']);
    expect(t.log).toEqual(['/bin/mkdir -p -- /people/pat/sessions/C1-1-1 /people/pat/wt/C1-1-1/alpha /people/pat/wt/C1-1-1/beta']);
  });

  it('prepare: one ws-add.sh for all repositories, then the record\'s copy and the root files by tar, then `repos` in the record', async () => {
    const t = rig();
    const { record, addMs } = await t.w.prepare(ID, ['alpha', 'beta']);
    expect(t.log).toEqual(['ws-add.sh 1 alpha beta=trunk', 'ws-add.sh 0 <tar']);
    expect(t.runs[0].args.slice(0, 3)).toEqual(['/clones', '/workspace', 'sp/C1-1-1']);
    expect(t.runs[0].timeoutMs).toBe(60_000);
    expect(record.repos).toEqual({
      alpha: { branch: 'sp/C1-1-1', from: 'origin/main', base: 'abc123' },
      beta: { branch: 'sp/C1-1-1', from: 'origin/trunk', base: 'abc123' },
    });
    expect(t.records.get(ID)).toEqual(record);
    expect(addMs).toBeGreaterThanOrEqual(0);
    const tar = t.runs[1].stdin!;
    expect(tarNames(tar)).toEqual(['.fork.json', 'AGENTS.md']);
    expect(JSON.parse(tarText(tar, '.fork.json'))).toEqual({ key: 'C1:1.1', owner: 'pat', createdAt: t.record.createdAt, ms: addMs, repos: record.repos });
    const agents = tarText(tar, 'AGENTS.md');
    expect(agents).toContain('house rules');
    expect(agents).toContain('lazy'); // the index of what is not checked out
    // Fetched a moment ago: the next thread's run does not fetch again.
    const next = rig();
    await next.w.prepare(ID, ['alpha', 'beta']);
    expect(next.log[0]).toBe('ws-add.sh 0 alpha beta=trunk');
  });

  it('prepare: a repository that could not be added is left out; a run that failed whole leaves all out, and the thread still starts', async () => {
    const one = rig(() => 'alpha\tok\tsp/C1-1-1\tmain\tabc\tcould not resolve host\nbeta\tfailed\tno branch trunk\n');
    expect((await one.w.prepare(ID, ['alpha', 'beta'])).record.repos).toEqual({ alpha: { branch: 'sp/C1-1-1', from: 'origin/main', base: 'abc', fetchError: 'could not resolve host' } });
    const none = rig(() => new Error('ws-add.sh: timed out'));
    expect((await none.w.prepare(ID, ['alpha'])).record.repos).toEqual({});
    expect(tarNames(none.runs[1].stdin!)).toEqual(['.fork.json', 'AGENTS.md']);
  });

  it('prepare: no `repos` in the record when the root files could not be written, so the next start prepares again', async () => {
    const t = rig();
    const scripts = t.runs;
    const w = sandboxWorkspaces({
      as: { run: async () => '', podman: async () => '' }, records: t.records, mounts: mounts({ as: { run: async () => '', podman: async () => '' }, root: '/opt/r1', dataDir: data }), pid: async () => 1,
      scripts: () => ({ clones: '/clones', workspace: () => '/workspace', run: async (_s, args, o) => {
        scripts.push({ args, timeoutMs: o.timeoutMs });
        if (o.stdin) throw new Error('ws-add.sh: tar: write error');
        return 'alpha\tok\tb\tmain\tabc\t\n';
      } }),
    });
    await expect(w.prepare(ID, ['alpha'])).rejects.toThrow('write error');
    expect(t.records.get(ID)?.repos).toBeUndefined();
  });

  it('checkout: resolved against the definition, cloned by a helper, its two mounts added, its worktree added, the record and its copy updated', async () => {
    const t = rig();
    await t.w.prepare(ID, ['alpha']);
    t.log.length = 0;
    const out = await t.w.checkout(ID, ['acme/lazy', 'nope', '../alpha', 'lazy']);
    expect(out).toEqual(expect.arrayContaining([
      { name: 'lazy', dir: 'lazy', branch: 'sp/C1-1-1', from: 'origin/main', base: 'abc123' },
      { name: 'nope', dir: 'nope', branch: 'sp/C1-1-1', from: '', base: '', error: 'no repository nope in this workspace; the list is in AGENTS.md' },
      expect.objectContaining({ name: '../alpha', error: expect.stringContaining('no repository') }),
    ]));
    expect(out.length).toBe(3);
    expect(t.log).toEqual([
      '/bin/mkdir -p -- /people/pat/sessions/C1-1-1 /people/pat/wt/C1-1-1/lazy',
      `podman unshare python3 -I /opt/r1/bin/sandbox-mount.py 4242 ${ID} pat`,
      'ws-add.sh 0 lazy',
      'ws-add.sh 0 <tar',
    ]);
    expect(Object.keys(t.records.get(ID)!.repos!)).toEqual(['alpha', 'lazy']);
    const tar = t.runs.at(-1)!.stdin!;
    expect(tarNames(tar)).toEqual(['.fork.json']); // AGENTS.md is the session's by now
    expect(Object.keys(JSON.parse(tarText(tar, '.fork.json')).repos)).toEqual(['alpha', 'lazy']);
  });

  it('checkout: a repository whose worktree could not be added says why, and the record does not gain it', async () => {
    const t = rig((args) => (args.includes('alpha') ? 'alpha\tok\tb\tmain\tabc\t\n' : 'lazy\tfailed\tdisk full\n'));
    await t.w.prepare(ID, ['alpha']);
    expect(await t.w.checkout(ID, ['lazy'])).toEqual([{ name: 'lazy', dir: 'lazy', branch: 'sp/C1-1-1', from: '', base: '', error: 'disk full' }]);
    expect(Object.keys(t.records.get(ID)!.repos!)).toEqual(['alpha']);
  });

  it('checkout without a definition says so; touch marks the thread used', async () => {
    const t = rig();
    const before = t.records.get(ID)!.usedAt;
    t.w.touch(ID);
    expect(Date.parse(t.records.get(ID)!.usedAt)).toBeGreaterThan(Date.parse(before));
    t.w.touch('ffffffffffffffff'); // no record: nothing
    delete process.env.SP_DEFINITION;
    try {
      await expect(t.w.checkout(ID, ['alpha'])).rejects.toThrow(NO_DEFINITION);
      expect(t.w.repos(t.record)).toEqual([]);
    } finally {
      process.env.SP_DEFINITION = definition;
    }
  });
});
