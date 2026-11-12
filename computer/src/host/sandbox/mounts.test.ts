import { describe, expect, it } from 'vitest';
import { mounts } from './mounts.js';
import type { AsRunner, RunOptions } from './podman.js';

const ID = '00aa11bb22cc33dd';
const r = { person: 'pat', key: 'C1:1.1' };

function rig() {
  const calls: { args: string[]; o: RunOptions }[] = [];
  const as: AsRunner = { run: async () => '', podman: async (args, o) => (calls.push({ args, o }), '') };
  return { m: mounts({ as, root: '/opt/slack-presence/releases/r1', dataDir: '/data' }), calls };
}

describe('mounts (work 103, "Mount helper")', () => {
  it('a thread\'s paths are below its person, named by the safe key', () => {
    const { m } = rig();
    expect(m.workspace(r)).toBe('/data/people/pat/sessions/C1-1-1');
    expect(m.clones('pat')).toBe('/data/people/pat/ws');
    expect(m.clone('pat', 'alpha')).toBe('/data/people/pat/ws/alpha');
    expect(m.registry(r, 'alpha')).toBe('/data/people/pat/wt/C1-1-1/alpha');
  });

  it('order: the workspace, every clone, every registry inside its clone, the journal last at its own path', () => {
    const { m } = rig();
    expect(m.bindsFor(r, ['alpha', 'beta'], '/data/journals/cs_1')).toEqual([
      { src: '/data/people/pat/sessions/C1-1-1', dst: '/workspace' },
      { src: '/data/people/pat/ws/alpha', dst: '/clones/alpha' },
      { src: '/data/people/pat/ws/beta', dst: '/clones/beta' },
      { src: '/data/people/pat/wt/C1-1-1/alpha', dst: '/clones/alpha/.git/worktrees' },
      { src: '/data/people/pat/wt/C1-1-1/beta', dst: '/clones/beta/.git/worktrees' },
      { src: '/data/journals/cs_1', dst: '/data/journals/cs_1' },
    ]);
    expect(m.bindsFor(r, [])).toEqual([{ src: '/data/people/pat/sessions/C1-1-1', dst: '/workspace' }]);
    expect(m.repoBinds(r, ['alpha']).map((b) => b.dst)).toEqual(['/clones/alpha', '/clones/alpha/.git/worktrees']);
  });

  it('a name that is not one path component names nothing', () => {
    const { m } = rig();
    for (const bad of ['..', '.', '', 'a/b', '.git', '-x', 'a b']) {
      expect(() => m.clone('pat', bad)).toThrow('bad repository name');
      expect(() => m.registry(r, bad)).toThrow('bad repository name');
    }
    expect(() => m.workspace({ person: '../quinn', key: 'k' })).toThrow('bad person name');
    expect(() => m.clones('')).toThrow('bad person name');
  });

  it('applyMounts hands the pairs to the helper with the host\'s SP_DATA, within 10 s; nothing to mount runs nothing', async () => {
    const { m, calls } = rig();
    await m.applyMounts(ID, 4242, 'pat', []);
    expect(calls).toEqual([]);
    await m.applyMounts(ID, 4242, 'pat', m.repoBinds(r, ['alpha']));
    expect(calls[0].args).toEqual([
      'unshare', 'python3', '-I', '/opt/slack-presence/releases/r1/bin/sandbox-mount.py', '4242', ID, 'pat',
      '/data/people/pat/ws/alpha:/clones/alpha', '/data/people/pat/wt/C1-1-1/alpha:/clones/alpha/.git/worktrees',
    ]);
    expect(calls[0].o).toEqual({ timeoutMs: 10_000, env: { SP_DATA: '/data' } });
    await expect(m.applyMounts(ID, 4242, '../quinn', m.repoBinds(r, ['alpha']))).rejects.toThrow('bad person name');
  });
});
