// The mount helper (bin/sandbox-mount.py, work 103) is Python, because Node
// cannot setns. What needs a container (a mount landing, a symlinked source,
// another container's pid) is gate G3 of deploy/vm/sandbox-gates.sh; this
// covers what it refuses before it touches a namespace, which needs none.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(import.meta.dirname, '../../bin/sandbox-mount.py');
const ID = '00112233aabbccdd';
const PAIR = '/data/people/p/sessions/k:/workspace';

function mount(args: string[], env: Record<string, string> = { SP_DATA: '/data' }) {
  const r = spawnSync('python3', ['-I', SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });
  return { code: r.status, stderr: r.stderr };
}

// Needs Linux (pidfd, /proc/<pid>/cgroup) and a python3 on PATH.
const runnable = process.platform === 'linux' && spawnSync('python3', ['--version']).status === 0;

describe.skipIf(!runnable)('bin/sandbox-mount.py', () => {
  it.each([
    ['too few arguments', [String(process.pid), ID, 'p']],
    ['a pid that is not a number', ['1x', ID, 'p', PAIR]],
    ['an id that is not 16 hex', [String(process.pid), 'ABC', 'p', PAIR]],
    ['a person that is a path', [String(process.pid), ID, '../q', PAIR]],
    ['a relative source', [String(process.pid), ID, 'p', 'sessions/k:/workspace']],
    ['a relative destination', [String(process.pid), ID, 'p', '/data/people/p/sessions/k:workspace']],
    ['a source with ..', [String(process.pid), ID, 'p', '/data/people/p/../q/sessions/k:/workspace']],
    ['a destination with ..', [String(process.pid), ID, 'p', '/data/people/p/sessions/k:/workspace/../etc']],
  ])('exits 2 on %s', (_, args) => {
    const r = mount(args);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^usage .+: .+\n$/);
  });

  it('exits 2 without SP_DATA', () => {
    expect(mount([String(process.pid), ID, 'p', PAIR], {}).code).toBe(2);
  });

  it('exits 3 on a pid that is gone', () => {
    const gone = spawnSync('true').pid;
    const r = mount([String(gone), ID, 'p', PAIR]);
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/^(pidfd_open|open) .+: .+\n$/);
  });

  it.each(['4194305', '4294967296', '9999999999'])('exits 3 on pid %s, which no process can have', (pid) => {
    const r = mount([pid, ID, 'p', PAIR]);
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/^pidfd_open \d+: .+\n$/);
  });

  it('exits 3 on a process that is not in that runner unit, before opening any source', () => {
    const r = mount([String(process.pid), ID, 'p', PAIR]);
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(new RegExp(`^cgroup /proc/${process.pid}/cgroup: .*sp-runner-${ID}\\.service\n$`));
  });
});
