// bin/ws-*.sh against real git in a temp dir: the line each prints, and that a second run gives the same.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { configureAsRunner } from './as-runner.js';
import { hostScripts, row, rows, ScriptError } from './script-runner.js';

const tmp = mkdtempSync(path.join(tmpdir(), 'ws-scripts-'));
const gitconfig = path.join(tmp, 'gitconfig');
writeFileSync(gitconfig, '[user]\n\tname = check\n\temail = check@localhost\n[init]\n\tdefaultBranch = main\n');
const env = { PATH: process.env.PATH, HOME: tmp, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const remote = path.join(tmp, 'remotes', 'alpha.git');
const clones = path.join(tmp, 'ws');
const workspace = path.join(tmp, 'sessions', 'k1');
const s = hostScripts(clones);
const run = (script: string, args: string[], stdin?: string) => s.run(script, args, { stdin, timeoutMs: 20_000 });
/** A commit on the remote's main, through a throwaway checkout. */
function push(file: string, text: string) {
  const co = mkdtempSync(path.join(tmp, 'co-'));
  git(co, 'clone', '--quiet', remote, '.');
  writeFileSync(path.join(co, file), text);
  git(co, 'add', '-A');
  git(co, 'commit', '--quiet', '-m', file);
  git(co, 'push', '--quiet', 'origin', 'HEAD:main');
  return git(co, 'rev-parse', 'HEAD');
}

beforeAll(() => {
  configureAsRunner(undefined, env);
  mkdirSync(remote, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  git(remote, 'init', '--quiet', '--bare');
  const seed = mkdtempSync(path.join(tmp, 'seed-'));
  git(seed, 'init', '--quiet');
  writeFileSync(path.join(seed, '.gitignore'), 'node_modules/\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '--quiet', '-m', 'first');
  git(seed, 'push', '--quiet', remote, 'HEAD:main');
});

describe('script output', () => {
  it('is read by repository, a failed line as an error with its message', () => {
    const out = 'a\tok\tx\t\ty\nb\tfailed\tfatal: no\n';
    expect(rows(out).get('a')).toEqual(['ok', 'x', '', 'y']);
    expect(row(out, 'a')).toEqual(['x', '', 'y']);
    expect(() => row(out, 'b')).toThrow('fatal: no');
    expect(() => row(out, 'c')).toThrow('no result for c');
  });
});

describe('workspace scripts', () => {
  it('ws-clone.sh clones once, runs setup in the clone, and leaves a clone that exists alone', async () => {
    const args = [clones, 'alpha', remote, '', '', 'touch .git/set-up'];
    expect(await run('ws-clone.sh', args)).toBe('alpha\tok\tcloned\n');
    expect(existsSync(path.join(clones, 'alpha', '.git', 'set-up'))).toBe(true);
    expect(existsSync(path.join(clones, 'alpha.cloning'))).toBe(false);
    expect(await run('ws-clone.sh', [clones, 'alpha', remote, '', '', 'touch .git/again'])).toBe('alpha\tok\tpresent\n');
    expect(existsSync(path.join(clones, 'alpha', '.git', 'again'))).toBe(false);
  });

  it('ws-clone.sh says why a clone or a setup command failed, in one line', async () => {
    const [status, why] = rows(await run('ws-clone.sh', [clones, 'nowhere', path.join(tmp, 'remotes', 'none.git'), 'blob:none', 'main'])).get('nowhere')!;
    expect([status, why]).toEqual(['failed', expect.stringMatching(/^fatal: /)]);
    expect(existsSync(path.join(clones, 'nowhere'))).toBe(false);
    expect(await run('ws-clone.sh', [clones, 'beta', remote, '', 'main', 'echo broken >&2; exit 3', 'touch .not-reached'])).toBe(
      'beta\tfailed\tsetup `echo broken >&2; exit 3`: broken\n',
    );
    expect(existsSync(path.join(clones, 'beta', '.git'))).toBe(true); // the clone stays
    expect(existsSync(path.join(clones, 'beta', '.not-reached'))).toBe(false);
  });

  it('ws-clone.sh renames over an empty directory and never moves the clone into one that is not', async () => {
    // As rename(2) did before the script: an empty directory is replaced.
    mkdirSync(path.join(clones, 'empty'));
    expect(await run('ws-clone.sh', [clones, 'empty', remote, '', ''])).toBe('empty\tok\tcloned\n');
    expect(existsSync(path.join(clones, 'empty', '.git'))).toBe(true);
    // One with something in it fails the rename, with mv's message, and is left as it was.
    mkdirSync(path.join(clones, 'full'));
    writeFileSync(path.join(clones, 'full', 'mine.txt'), 'x');
    const [status, why] = rows(await run('ws-clone.sh', [clones, 'full', remote, '', '', 'touch .not-reached'])).get('full')!;
    expect([status, why]).toEqual(['failed', expect.stringMatching(/^mv: .*full/)]);
    expect(execFileSync('ls', ['-A', path.join(clones, 'full')], { encoding: 'utf8' })).toBe('mine.txt\n');
  });

  it('ws-clone.sh runs setup commands without GIT_TERMINAL_PROMPT, as before the script', async () => {
    const args = [clones, 'gamma', remote, '', '', 'echo "${GIT_TERMINAL_PROMPT-unset}" >.git/prompt'];
    expect(await run('ws-clone.sh', args)).toBe('gamma\tok\tcloned\n');
    expect(readFileSync(path.join(clones, 'gamma', '.git', 'prompt'), 'utf8')).toBe('unset\n');
  });

  it('ws-sync.sh names the base, fetches, and only ever fast-forwards the checkout', async () => {
    expect(await run('ws-sync.sh', ['--only=base', clones, 'alpha'])).toBe('alpha\tok\tmain\n');
    expect(await run('ws-sync.sh', ['--only=forward', clones, 'alpha', 'main'])).toMatch(/^alpha\tok\tcurrent\t[0-9a-f]{7,}\t\n$/);
    const pushed = push('one.txt', '1');
    expect(await run('ws-sync.sh', ['--only=fetch', clones, 'alpha'])).toBe('alpha\tok\n');
    expect(git(path.join(clones, 'alpha'), 'rev-parse', 'origin/main')).toBe(pushed);
    const moved = await run('ws-sync.sh', ['--only=forward', clones, 'alpha', 'main']);
    expect(row(moved, 'alpha')).toEqual(['moved', git(path.join(clones, 'alpha'), 'rev-parse', '--short', 'origin/main'), '']);
    expect(git(path.join(clones, 'alpha'), 'rev-parse', 'HEAD')).toBe(pushed);
    // All steps at once, twice: the second run finds nothing to do.
    push('two.txt', '2');
    expect(row(await run('ws-sync.sh', [clones, 'alpha']), 'alpha')[0]).toBe('moved');
    expect(row(await run('ws-sync.sh', [clones, 'alpha']), 'alpha')[0]).toBe('current');
    // Local changes are never overwritten.
    writeFileSync(path.join(clones, 'alpha', 'two.txt'), 'mine');
    push('three.txt', '3');
    expect(row(await run('ws-sync.sh', [clones, 'alpha']), 'alpha')).toEqual(['kept', expect.any(String), 'checkout has local changes; not fast-forwarded']);
    git(path.join(clones, 'alpha'), 'checkout', '--quiet', '--', 'two.txt');
    git(path.join(clones, 'alpha'), 'checkout', '--quiet', '-b', 'other');
    expect(row(await run('ws-sync.sh', ['--only=forward', clones, 'alpha', 'main']), 'alpha')[2]).toBe('checkout is on other, not main; not fast-forwarded');
    git(path.join(clones, 'alpha'), 'checkout', '--quiet', 'main');
    expect(row(await run('ws-sync.sh', ['--only=forward', clones, 'alpha', 'main']), 'alpha')[0]).toBe('moved');
  });

  it('ws-fetch.sh fetches the refs it is given', async () => {
    const pushed = push('four.txt', '4');
    expect(await run('ws-fetch.sh', [clones, 'alpha', 'main'])).toBe('alpha\tok\n');
    expect(git(path.join(clones, 'alpha'), 'rev-parse', 'origin/main')).toBe(pushed);
    expect(await run('ws-fetch.sh', [clones, 'alpha', 'main'])).toBe('alpha\tok\n');
    expect(rows(await run('ws-fetch.sh', [clones, 'alpha', 'no-such-branch'])).get('alpha')).toEqual(['failed', expect.stringMatching(/^fatal: .*no-such-branch/)]);
  });

  it('ws-add.sh makes a worktree on the branch from origin/<base>, once', async () => {
    const base = git(path.join(clones, 'alpha'), 'rev-parse', 'origin/main');
    const line = `alpha\tok\tsp/k1\tmain\t${base}\t\n`;
    expect(await run('ws-add.sh', [clones, workspace, 'sp/k1', '0', 'alpha=main'])).toBe(line);
    expect(git(path.join(workspace, 'alpha'), 'symbolic-ref', '--short', 'HEAD')).toBe('sp/k1');
    expect(git(path.join(workspace, 'alpha'), 'for-each-ref', '--format=%(upstream)', 'refs/heads/sp/k1')).toBe(''); // not tracking origin/main
    // Again, with a fetch and the base left to the script: the same line, the worktree untouched.
    writeFileSync(path.join(workspace, 'alpha', 'work.txt'), 'kept');
    expect(await run('ws-add.sh', [clones, workspace, 'sp/k1', '1', 'alpha'])).toBe(line);
    expect(existsSync(path.join(workspace, 'alpha', 'work.txt'))).toBe(true);
    // A worktree whose directory was deleted is added again, on the branch that exists.
    execFileSync('rm', ['-rf', path.join(workspace, 'alpha')]);
    expect(await run('ws-add.sh', [clones, workspace, 'sp/k1', '0', 'alpha=main'])).toBe(line);
  });

  it('ws-add.sh reports each repository on its own: not a worktree, no such clone, a failed fetch', async () => {
    mkdirSync(path.join(workspace, 'beta'));
    writeFileSync(path.join(workspace, 'beta', 'mine.txt'), 'x');
    const out = rows(await run('ws-add.sh', [clones, workspace, 'sp/k1', '0', 'beta=main', 'gone=main', 'alpha=main']));
    expect(out.get('beta')).toEqual(['failed', "./beta exists but is not a worktree of this workspace's beta; move it away and check out again"]);
    expect(existsSync(path.join(workspace, 'beta', 'mine.txt'))).toBe(true);
    expect(out.get('gone')?.[0]).toBe('failed');
    expect(existsSync(path.join(workspace, 'gone'))).toBe(false);
    expect(out.get('alpha')?.[0]).toBe('ok');
    git(path.join(clones, 'beta'), 'remote', 'set-url', 'origin', path.join(tmp, 'remotes', 'none.git'));
    const other = path.join(tmp, 'sessions', 'k2');
    mkdirSync(other);
    const [branch, from, head, fetchError] = row(await run('ws-add.sh', [clones, other, 'sp/k2', '1', 'beta=main']), 'beta');
    expect([branch, from, head]).toEqual(['sp/k2', 'main', git(path.join(clones, 'beta'), 'rev-parse', 'origin/main')]);
    expect(fetchError).toMatch(/^fatal: /);
  });

  it('ws-inspect.sh tells clean from dirty, counts unpushed commits and names the ignored directories, changing nothing', async () => {
    const wt = path.join(workspace, 'alpha');
    const common = git(wt, 'rev-parse', '--git-common-dir');
    const state = () => run('ws-inspect.sh', ['--only=state', clones, workspace, 'alpha']);
    expect(await state()).toBe(`1\tok\tclean\t0\tsp/k1\t${common}\n`);
    expect(await state()).toBe(`1\tok\tclean\t0\tsp/k1\t${common}\n`);
    writeFileSync(path.join(wt, 'new.txt'), 'n');
    expect(await state()).toBe(`1\tok\tdirty\t-\tsp/k1\t${common}\n`);
    git(wt, 'add', '-A');
    git(wt, 'commit', '--quiet', '-m', 'local');
    expect(await state()).toBe(`1\tok\tclean\t1\tsp/k1\t${common}\n`);
    mkdirSync(path.join(wt, 'node_modules'));
    mkdirSync(path.join(wt, 'pkg', 'node_modules'), { recursive: true });
    mkdirSync(path.join(wt, 'venv'));
    // Answered by position: the worktree's among the arguments, the directory's line on stdin.
    const asked = '1\tnode_modules\n1\tvenv\n2\tnode_modules\n1\tpkg/node_modules\n';
    expect(await run('ws-inspect.sh', ['--only=ignored', clones, workspace, 'alpha'], asked)).toBe('1\tok\t-\t-\t-\t-\t1\t4\n');
    expect(await run('ws-inspect.sh', [clones, workspace, 'alpha', 'missing'], asked)).toBe(
      `1\tok\tclean\t1\tsp/k1\t${common}\t1\t4\n2\tok\tdirty\t-\t\t\n`,
    );
  });

  it('ws-forget.sh deletes the branch, and has nothing to do the second time', async () => {
    const clone = path.join(clones, 'alpha');
    git(clone, 'worktree', 'remove', '--force', path.join(workspace, 'alpha'));
    expect(await run('ws-forget.sh', [clones, 'sp/k1', 'alpha'])).toBe('alpha\tok\n');
    expect(git(clone, 'branch', '--list', 'sp/k1')).toBe('');
    expect(await run('ws-forget.sh', [clones, 'sp/k1', 'alpha', 'gone'])).toMatch(/^alpha\tok\ngone\tfailed\t.+\n$/);
  });

  it('a script stopped at its timeout stops its command and rejects as killed', async () => {
    const started = Date.now();
    const e = await s.run('ws-clone.sh', [clones, 'slow', remote, '', '', 'sleep 5'], { timeoutMs: 1500 }).catch((e) => e);
    expect(e).toBeInstanceOf(ScriptError);
    expect(e.killed).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('a script signalled while it starts a command leaves none running', async () => {
    // The signal is sent as soon as the script says it is about to start one: it lands around the fork.
    const script = path.join(tmp, 'starting.sh');
    writeFileSync(script, '. "$1/ws-lib.sh"\necho ready\nwhile :; do ws_in / sleep 30; done\n');
    const bin = path.resolve(import.meta.dirname, '..', '..', 'bin');
    const started = Date.now();
    for (let n = 0; n < 20; n++) {
      const code = await new Promise((resolve) => {
        const p = spawn('sh', [script, bin], { env, stdio: ['ignore', 'pipe', 'ignore'] });
        p.stdout.once('data', () => p.kill('SIGTERM'));
        p.on('close', resolve); // not before the sleep, which holds stdout, is gone too
      });
      expect(code).toBe(143);
    }
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 20_000);

  it('a wrong call is a ScriptError with the exit code and stderr', async () => {
    const e = await run('ws-fetch.sh', []).catch((e) => e);
    expect(e).toBeInstanceOf(ScriptError);
    expect([e.code, e.killed]).toEqual([2, false]);
    expect(e.stderr).toMatch(/^usage: ws-fetch.sh/);
  });
});
