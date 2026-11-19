// Real git, real hooks: a bare remote, the host's shared clone of the
// knowledge repository with the hooks installed, and a session's worktree of
// it (as fork.ts makes them), committing and pushing the way an agent does.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureAsRunner } from './as-runner.js';
import { HOOK_MARK, KNOWLEDGE_HOOKS, syncKnowledgeHooks } from './knowledge-hooks.js';

const root = mkdtempSync(path.join(os.tmpdir(), 'sp-khooks-'));
const source = path.resolve(import.meta.dirname, '..', '..', 'hooks', 'knowledge');
const knowledge = { name: 'notes', remote: 'https://github.com/acme/notes', role: 'knowledge' as const };
const plain = { name: 'api', remote: 'https://github.com/acme/api' };

// A git of its own: no user or system configuration, a fixed author.
const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const { SP_SESSION_ID: _, ...rest } = process.env;
  return {
    ...rest,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig'),
    GIT_AUTHOR_NAME: 'Ada',
    GIT_AUTHOR_EMAIL: 'ada@example.com',
    GIT_COMMITTER_NAME: 'Ada',
    GIT_COMMITTER_EMAIL: 'ada@example.com',
    GIT_EDITOR: 'true',
    ...extra,
  };
};
function git(cwd: string, args: string[], extra: Record<string, string> = {}) {
  const r = spawnSync('git', args, { cwd, env: env(extra), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const push = (cwd: string, extra: Record<string, string> = {}) =>
  spawnSync('git', ['push', 'origin', 'HEAD:main'], { cwd, env: env(extra), encoding: 'utf8' });
function put(dir: string, files: Record<string, string>) {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), text);
  }
}
const item = (title: string) => `---\nowner: ada@example.com\n---\n# ${title}\n\nStarted.\n\n## Left\n\n- [ ] the rest\n`;
const trailers = (cwd: string, rev = 'HEAD') =>
  git(cwd, ['log', '-1', '--format=%(trailers:key=Session,valueonly)', rev]).split('\n').filter(Boolean);

const remote = path.join(root, 'notes.git');
const clone = path.join(root, 'ws', 'notes'); // the host's shared clone
const session = path.join(root, 'sessions', 's1'); // a session's fork of it
const other = path.join(root, 'other'); // someone else, elsewhere, without the hooks
const hooks = path.join(clone, '.git', 'hooks');

beforeAll(() => {
  configureAsRunner(undefined, process.env);
  writeFileSync(path.join(root, 'gitconfig'), '[init]\n\tdefaultBranch = main\n');
  git(root, ['init', '-q', '--bare', remote]);
  git(root, ['clone', '-q', remote, other]);
  // History already has a shared number (7): it must never block anyone.
  put(other, {
    'README.md': 'notes\n',
    'work/01-first.md': item('First'),
    'work/07-a.md': item('A'),
    'done/7-b.md': item('B'),
    'done/2-old.md': item('Old'),
  });
  git(other, ['add', '-A']);
  git(other, ['commit', '-q', '-m', 'Seed']);
  git(other, ['push', '-q', 'origin', 'HEAD:main']);
  git(root, ['clone', '-q', remote, clone]);
  git(clone, ['worktree', 'add', '-q', '-b', 'sp/s1', session, 'origin/main']);
});
afterAll(() => {
  configureAsRunner(undefined, {});
  rmSync(root, { recursive: true, force: true });
});

describe('syncKnowledgeHooks', () => {
  it('installs both hooks, executable, where the clone and its worktrees look', async () => {
    await syncKnowledgeHooks(clone, knowledge, source);
    expect(git(session, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'])).toBe(hooks);
    for (const name of KNOWLEDGE_HOOKS) {
      const file = path.join(hooks, name);
      expect(readFileSync(file, 'utf8')).toBe(readFileSync(path.join(source, name), 'utf8'));
      expect(statSync(file).mode & 0o777).toBe(0o755);
    }
  });

  it('leaves current hooks alone, and replaces stale ones of ours', async () => {
    const file = path.join(hooks, 'pre-push');
    const before = statSync(file).mtimeMs;
    await syncKnowledgeHooks(clone, knowledge, source);
    expect(statSync(file).mtimeMs).toBe(before);
    writeFileSync(file, `#!/bin/sh\n# ${HOOK_MARK}: an older release\nexit 1\n`);
    chmodSync(path.join(hooks, 'prepare-commit-msg'), 0o644);
    await syncKnowledgeHooks(clone, knowledge, source);
    expect(readFileSync(file, 'utf8')).toBe(readFileSync(path.join(source, 'pre-push'), 'utf8'));
    expect(statSync(path.join(hooks, 'prepare-commit-msg')).mode & 0o111).toBe(0o111);
    expect(existsSync(`${file}.installing`)).toBe(false);
  });

  it("never replaces someone else's hook, and says so", async () => {
    const dir = path.join(root, 'foreign');
    git(root, ['init', '-q', dir]);
    const theirs = '#!/bin/sh\necho theirs\n';
    writeFileSync(path.join(dir, '.git', 'hooks', 'pre-push'), theirs);
    await expect(syncKnowledgeHooks(dir, knowledge, source)).rejects.toThrow(/pre-push in .* is not ours/);
    expect(readFileSync(path.join(dir, '.git', 'hooks', 'pre-push'), 'utf8')).toBe(theirs);
    expect(readFileSync(path.join(dir, '.git', 'hooks', 'prepare-commit-msg'), 'utf8')).toContain(HOOK_MARK);
    // No longer the knowledge repository: ours go, theirs stays.
    await syncKnowledgeHooks(dir, plain, source);
    expect(existsSync(path.join(dir, '.git', 'hooks', 'prepare-commit-msg'))).toBe(false);
    expect(readFileSync(path.join(dir, '.git', 'hooks', 'pre-push'), 'utf8')).toBe(theirs);
    await syncKnowledgeHooks(path.join(root, 'nowhere'), plain, source); // nothing there: nothing to do
  });
});

describe('prepare-commit-msg', () => {
  const id = { SP_SESSION_ID: 'cs_s1' };

  it('adds the Session trailer once, through an amend', () => {
    put(session, { 'work/08-mine.md': item('Mine') });
    git(session, ['add', '-A']);
    git(session, ['commit', '-q', '-m', 'Track mine'], id);
    expect(trailers(session)).toEqual(['cs_s1']);
    git(session, ['commit', '-q', '--amend', '--no-edit'], id);
    git(session, ['commit', '-q', '--amend', '-m', 'Track mine\n\nWith a body.\n\nSession: cs_s1'], id);
    expect(trailers(session)).toEqual(['cs_s1']);
    expect(git(session, ['log', '-1', '--format=%B'])).toBe('Track mine\n\nWith a body.\n\nSession: cs_s1');
  });

  it('adds nothing without SP_SESSION_ID, or with one that is not an id', () => {
    put(session, { 'docs/x.md': 'x\n' });
    git(session, ['add', '-A']);
    git(session, ['commit', '-q', '-m', 'Unattributed']);
    expect(trailers(session)).toEqual([]);
    git(session, ['commit', '-q', '--amend', '--no-edit'], { SP_SESSION_ID: 'x\nSigned-off-by: someone' });
    expect(git(session, ['log', '-1', '--format=%B'])).toBe('Unattributed');
    git(session, ['reset', '-q', '--hard', 'HEAD~1']);
  });

  it('keeps one trailer per commit through a rebase onto new upstream work', () => {
    put(other, { 'docs/upstream.md': 'meanwhile\n' });
    git(other, ['add', '-A']);
    git(other, ['commit', '-q', '-m', 'Upstream']);
    git(other, ['push', '-q', 'origin', 'HEAD:main']);
    git(session, ['pull', '-q', '--rebase', 'origin', 'main'], id);
    expect(git(session, ['log', '-1', '--format=%s', 'HEAD~1'])).toBe('Upstream');
    expect(trailers(session)).toEqual(['cs_s1']);
    expect(trailers(session, 'HEAD~1')).toEqual([]);
  });
});

describe('pre-push', () => {
  it('lets a push with fresh numbers through, despite shared numbers in history', () => {
    const r = push(session);
    expect(r.stderr).not.toMatch(/refused/);
    expect(r.status).toBe(0);
  });

  it('refuses a number another session took first, naming the one to take instead', () => {
    // Both sessions take 9: the other one pushes first.
    put(other, { 'work/9-theirs.md': item('Theirs') });
    git(other, ['add', '-A']);
    git(other, ['commit', '-q', '-m', 'Track theirs']);
    git(other, ['pull', '-q', '--rebase', 'origin', 'main']);
    git(other, ['push', '-q', 'origin', 'HEAD:main']);
    put(session, { 'work/09-ours.md': item('Ours') });
    git(session, ['add', '-A']);
    git(session, ['commit', '-q', '-m', 'Track ours']);
    git(session, ['pull', '-q', '--rebase', 'origin', 'main']);
    const r = push(session);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('pre-push: refused');
    expect(r.stderr).toContain('9 is taken by work/9-theirs.md, renumber yours (work/09-ours.md) to 10');
    expect(git(other, ['ls-remote', 'origin', 'main'])).not.toContain(git(session, ['rev-parse', 'HEAD']));

    git(session, ['mv', 'work/09-ours.md', 'work/10-ours.md']);
    git(session, ['commit', '-q', '-m', 'Renumber ours']);
    expect(push(session).status).toBe(0);
  });

  it('warns about malformed items without refusing', () => {
    put(session, { 'work/11-bare.md': 'no title\n\n## Left\n\nnothing\n', 'work/notes.md': 'x\n', 'done/12-ok.md': item('Ok') });
    git(session, ['add', '-A']);
    git(session, ['commit', '-q', '-m', 'Odd files']);
    const r = push(session);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('work/11-bare.md has no "# " title');
    expect(r.stderr).toContain('work/11-bare.md: "## Left" has no checkboxes');
    expect(r.stderr).toContain('work/notes.md is not an item');
    expect(r.stderr).not.toContain('12-ok');
  });
});
