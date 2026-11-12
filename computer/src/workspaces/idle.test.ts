// pruneArtifacts and pruneFork against real git in a temp dir: names with a
// tab or a newline, which the scripts' line protocol cannot carry.
import { execFileSync } from 'node:child_process';
import { existsSync, lutimesSync, mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { configureAsRunner } from './as-runner.js';
import { allWorktrees, artifactQuestion, lastUsed, pruneArtifacts, stillInside, worktrees } from './idle.js';
import { pruneFork } from './prune.js';

const tmp = mkdtempSync(path.join(tmpdir(), 'ws-idle-'));
const gitconfig = path.join(tmp, 'gitconfig');
writeFileSync(gitconfig, '[user]\n\tname = check\n\temail = check@localhost\n[init]\n\tdefaultBranch = main\n');
const env = { PATH: process.env.PATH, HOME: tmp, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let forks = 0;
const newFork = () => {
  const fork = path.join(tmp, 'sessions', `k${++forks}`);
  mkdirSync(fork, { recursive: true });
  return fork;
};
/** A repository at `dir` with one commit of a .gitignore, and these directories. */
function repo(dir: string, gitignore: string, dirs: string[]) {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '--quiet');
  writeFileSync(path.join(dir, '.gitignore'), gitignore);
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', 'first');
  for (const d of dirs) mkdirSync(path.join(dir, d), { recursive: true });
}

beforeAll(() => configureAsRunner(undefined, env));

describe('pruneArtifacts', () => {
  it('removes the ignored directories and keeps the others', async () => {
    const fork = newFork();
    repo(path.join(fork, 'alpha'), '/node_modules/\n/pkg/.venv/\n', ['node_modules', 'pkg/.venv', 'pkg/node_modules']);
    repo(path.join(fork, '.wt', 'beta'), '.turbo/\n', ['.turbo', 'venv']);
    const rel = (await pruneArtifacts(fork)).map((d) => path.relative(fork, d)).sort();
    expect(rel).toEqual(['.wt/beta/.turbo', 'alpha/node_modules', 'alpha/pkg/.venv']);
    expect(existsSync(path.join(fork, 'alpha', 'node_modules'))).toBe(false);
    expect(existsSync(path.join(fork, 'alpha', 'pkg', 'node_modules'))).toBe(true);
    expect(existsSync(path.join(fork, '.wt', 'beta', 'venv'))).toBe(true);
  });

  it('keeps an unignored directory whose path ends an ignored one with a tab in its name', async () => {
    const fork = newFork();
    const wt = path.join(fork, 'alpha');
    // `x<TAB>vendor/` is ignored, `vendor/` is not.
    repo(wt, 'x?vendor/\n/node_modules/\n', ['x\tvendor/node_modules', 'vendor/node_modules', 'line\nbreak/node_modules', 'node_modules']);
    writeFileSync(path.join(wt, 'vendor', 'node_modules', 'kept.txt'), 'not ignored');
    expect(await pruneArtifacts(fork)).toEqual([path.join(wt, 'node_modules')]);
    expect(existsSync(path.join(wt, 'vendor', 'node_modules', 'kept.txt'))).toBe(true);
    // A path the line protocol cannot carry is not asked about, and stays.
    expect(existsSync(path.join(wt, 'x\tvendor', 'node_modules'))).toBe(true);
    expect(existsSync(path.join(wt, 'line\nbreak', 'node_modules'))).toBe(true);
  });

  it('prunes a fork that has a worktree with a tab or a newline in its name', async () => {
    const fork = newFork();
    repo(path.join(fork, 'alpha'), 'node_modules/\n', ['node_modules']);
    repo(path.join(fork, '.wt', 'a\tb'), 'node_modules/\n', ['node_modules', 'venv']);
    repo(path.join(fork, '.wt', 'c\nd'), 'node_modules/\n', ['node_modules']);
    const rel = (await pruneArtifacts(fork)).map((d) => path.relative(fork, d)).sort();
    expect(rel).toEqual(['.wt/a\tb/node_modules', '.wt/c\nd/node_modules', 'alpha/node_modules']);
    expect(existsSync(path.join(fork, '.wt', 'a\tb', 'venv'))).toBe(true);
  });
});

describe('links a session left in a fork (work 103 step 7 review)', () => {
  /** Another person's fork: a worktree `alpha` with an ignored node_modules. */
  const victim = () => {
    const other = path.join(tmp, 'other', `v${++forks}`);
    repo(path.join(other, 'alpha'), 'node_modules/\n', ['node_modules']);
    return other;
  };

  it('a .wt that links to another directory: nothing there is listed, asked about or removed', async () => {
    const fork = newFork();
    const other = victim();
    repo(path.join(fork, 'mine'), 'node_modules/\n', ['node_modules']);
    symlinkSync(other, path.join(fork, '.wt'));
    expect(await allWorktrees(fork)).toEqual([path.join(fork, 'mine')]);
    expect((await artifactQuestion(fork)).names).toEqual(['mine']);
    expect(await pruneArtifacts(fork)).toEqual([path.join(fork, 'mine', 'node_modules')]);
    expect(existsSync(path.join(other, 'alpha', 'node_modules'))).toBe(true);
  });

  it('a fork that is itself a link: nothing is listed or removed, and its target\'s use is not its own', async () => {
    const other = victim();
    const fork = path.join(tmp, 'sessions', `link${++forks}`);
    symlinkSync(other, fork);
    expect(await worktrees(fork)).toEqual([]);
    expect(await allWorktrees(fork)).toEqual([]);
    expect(await pruneArtifacts(fork)).toEqual([]);
    expect(existsSync(path.join(other, 'alpha', 'node_modules'))).toBe(true);
    expect(await pruneFork(fork)).toBeUndefined(); // only the link goes
    expect(existsSync(path.join(other, 'alpha', 'node_modules'))).toBe(true);
    const again = path.join(tmp, 'sessions', `link${++forks}`);
    symlinkSync(other, again);
    const old = new Date(Date.now() - 96 * 3600e3);
    lutimesSync(again, old, old);
    expect(await lastUsed(again)).toBe(old.getTime()); // the link's own time
  });

  it('a worktree or a directory in it that is a link is not walked into', async () => {
    const fork = newFork();
    const other = victim();
    repo(path.join(fork, 'mine'), 'node_modules/\n', []);
    symlinkSync(path.join(other, 'alpha'), path.join(fork, 'linked'));
    symlinkSync(path.join(other, 'alpha'), path.join(fork, 'mine', 'pkg'));
    symlinkSync(path.join(other, 'alpha', 'node_modules'), path.join(fork, 'mine', 'node_modules'));
    expect(await allWorktrees(fork)).toEqual([path.join(fork, 'mine')]);
    expect((await artifactQuestion(fork)).asked).toEqual([]);
    expect(await pruneArtifacts(fork)).toEqual([]);
  });

  it('stillInside: a directory found and then replaced by a link, or below one, is dropped before removal', async () => {
    const fork = newFork();
    const other = victim();
    repo(path.join(fork, 'mine'), 'node_modules/\n', ['node_modules', 'pkg/node_modules']);
    repo(path.join(fork, '.wt', 'beta'), 'node_modules/\n', ['node_modules']);
    const q = await artifactQuestion(fork);
    expect(await stillInside(fork, q.asked)).toEqual(q.asked);
    // Between the listing and the removal: .wt becomes a link, and so does a directory above an artifact.
    renameSync(path.join(fork, '.wt'), path.join(fork, 'was-wt'));
    symlinkSync(path.join(other), path.join(fork, '.wt'));
    mkdirSync(path.join(other, 'beta', 'node_modules'), { recursive: true });
    renameSync(path.join(fork, 'mine', 'pkg'), path.join(fork, 'mine', 'was-pkg'));
    symlinkSync(path.join(other, 'alpha'), path.join(fork, 'mine', 'pkg'));
    expect(await stillInside(fork, q.asked)).toEqual([path.join(fork, 'mine', 'node_modules')]);
    expect(await stillInside(path.join(fork, '.wt'), [path.join(fork, '.wt', 'beta', 'node_modules')])).toEqual([]);
  });
});

describe('pruneFork', () => {
  it('says why a fork is kept when a worktree has a tab in its name', async () => {
    const fork = newFork();
    repo(path.join(fork, 'alpha'), '', []);
    repo(path.join(fork, 'a\tb'), '', []);
    writeFileSync(path.join(fork, 'a\tb', 'new.txt'), 'uncommitted');
    // alpha has a commit on no remote; the other is dirty.
    expect(await pruneFork(fork)).toBe('a\tb has uncommitted changes, alpha has 1 unpushed commit');
    expect(existsSync(path.join(fork, 'a\tb', 'new.txt'))).toBe(true);
  });
});
