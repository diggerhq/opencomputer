// Checks src/workspaces and bin/ against local bare repositories, no network:
//   npx tsx src/dev/workspaces-check.ts            synthetic remotes
//   npx tsx src/dev/workspaces-check.ts --real     also time a fork of local mirrors of the seed repos
// Everything lives in a temp dir (kept with --keep).

import { execFile, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Person } from '../protocol.js';

const run = promisify(execFile);
const tmp = mkdtempSync(path.join(os.tmpdir(), 'sp-ws-check-'));
const BIN = path.resolve(import.meta.dirname, '..', '..', 'bin');
const gitconfig = path.join(tmp, 'gitconfig');
writeFileSync(gitconfig, '[user]\n\tname = check\n\temail = check@localhost\n[init]\n\tdefaultBranch = main\n');
Object.assign(process.env, {
  SP_DATA: path.join(tmp, 'data'),
  SP_RUN: path.join(tmp, 'run'),
  SP_DEFINITION: path.join(tmp, 'def', 'test.json'),
  GIT_CONFIG_GLOBAL: gitconfig,
  GIT_CONFIG_NOSYSTEM: '1',
});
const ws = await import('../workspaces/index.js');
ws.configureAsRunner(undefined, process.env);
const forked: { repo: string; fetchSkipped: boolean }[] = [];
const fetched: { repo: string; trigger: string }[] = [];
ws.observeWorkspaces({ repoForked: (t) => forked.push(t), repoFetched: (t) => fetched.push(t) });
const skipped = (from: number) => forked.slice(from).map((t) => t.fetchSkipped);

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let failures = 0;
function check(what: string, cond: unknown, detail = '') {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
}
async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t0 = performance.now();
  const r = await fn();
  return [r, Math.round(performance.now() - t0)];
}

// ---- remotes: acme/<name>.git bare repos, a scratch clone each to push from
const remotes = path.join(tmp, 'remotes', 'acme');
const scratch = path.join(tmp, 'scratch');
const names = ['alpha', 'beta', 'gamma', 'delta'];
async function makeRemote(name: string, files = 200) {
  const bare = path.join(remotes, `${name}.git`);
  git(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
  git(bare, 'config', 'uploadpack.allowFilter', 'true'); // partial clones of lazy repositories, as GitHub allows
  const s = path.join(scratch, name);
  git(tmp, 'clone', '-q', bare, s);
  for (let i = 0; i < files; i++) {
    await mkdir(path.join(s, `d${i % 10}`), { recursive: true });
    await writeFile(path.join(s, `d${i % 10}`, `f${i}.txt`), `${name} ${i}\n`.repeat(50));
  }
  git(s, 'add', '-A');
  git(s, 'commit', '-qm', 'init');
  git(s, 'push', '-q', 'origin', 'main');
}
function push(name: string, msg: string) {
  const s = path.join(scratch, name);
  writeFileSync(path.join(s, `${msg}.txt`), msg);
  git(s, 'add', '-A');
  git(s, 'commit', '-qm', msg);
  git(s, 'push', '-q', 'origin', 'main');
  return git(s, 'rev-parse', 'HEAD');
}
for (const n of names) await makeRemote(n);
await makeRemote('epsilon', 5);

const def = (repos: string[], lazy: string[] = []) => {
  execFileSync('mkdir', ['-p', path.join(tmp, 'def')]);
  writeFileSync(path.join(tmp, 'def', 'root.md'), '# test workspace\n');
  writeFileSync(
    process.env.SP_DEFINITION!,
    JSON.stringify({
      name: 'test',
      repos: [
        ...repos.map((n) => ({ name: n, remote: `file://${remotes}/${n}.git`, ...(lazy.includes(n) && { clone: 'lazy' }) })),
        { name: 'ghost', remote: 'https://github.com/acme/ghost', unpublished: true },
      ],
      rootFiles: { 'AGENTS.md': 'root.md' },
    }),
  );
};
def(names);

const owner: Person = { slackUserId: 'U1', dir: 'owner', gitName: 'Owner', gitEmail: 'owner@example.com' };
const root = ws.personRoot(owner);
const clone = (n: string) => path.join(root, 'ws', n);

// ---- ensureWorkspace
let [, ms] = await timed(() => ws.ensureWorkspace(owner));
check('ensureWorkspace clones 4 repos and the root AGENTS.md', names.every((n) => existsSync(path.join(clone(n), '.git'))) && existsSync(path.join(root, 'ws', 'AGENTS.md')), `${ms} ms`);
check('unpublished repo not cloned', !existsSync(clone('ghost')));
[, ms] = await timed(() => ws.ensureWorkspace(owner));
check('ensureWorkspace again is a no-op', true, `${ms} ms`);

// ---- forks
const k1 = 'C0TEST:1791495325.000001';
const [f1, forkMs] = await timed(() => ws.forkSession(owner, k1));
check('fork path', f1 === path.join(root, 'sessions', 'C0TEST-1791495325-000001'), f1);
check('fork has a worktree per repo on sp/<key>', names.every((n) => git(path.join(f1, n), 'symbolic-ref', '--short', 'HEAD') === 'sp/C0TEST-1791495325-000001'), `${forkMs} ms for 4 repos`);
check('fork has root AGENTS.md', readFileSync(path.join(f1, 'AGENTS.md'), 'utf8').includes('test workspace'));
check('fork branch has no upstream', (() => { try { git(path.join(f1, 'alpha'), 'rev-parse', '--abbrev-ref', '@{u}'); return false; } catch { return true; } })());
const [again, againMs] = await timed(() => ws.forkSession(owner, k1));
check('forkSession again returns the same fork', again === f1, `${againMs} ms`);

// ---- fork-time fetch: skipped while the clones are fresh; a push notification makes the next fork fetch
check('the first fork, right after the clones, skips its fetch', skipped(0).length === 4 && skipped(0).every((s) => s));
const base1 = git(path.join(f1, 'alpha'), 'rev-parse', 'HEAD');
const p1 = push('alpha', 'pushed-1');
let mark = forked.length;
const [fFresh, freshMs] = await timed(() => ws.forkSession(owner, 'C0TEST:7'));
check('a fork right after a fetch skips it and uses the fetched refs (no notification yet)', skipped(mark).every((s) => s) &&
  git(path.join(fFresh, 'alpha'), 'rev-parse', 'HEAD') === base1, `${freshMs} ms`);
check('a push to a session branch marks nothing', (await ws.markPushed('acme/alpha', [owner], 'refs/heads/sp/C0TEST-7')).length === 0);
check('a push to the default branch marks that clone', (await ws.markPushed('acme/alpha', [owner], 'refs/heads/main')).length === 1);
mark = forked.length;
const [f2, f2ms] = await timed(() => ws.forkSession(owner, 'C0TEST:2'));
check('next fork starts from the pushed commit (fetch at fork)', git(path.join(f2, 'alpha'), 'rev-parse', 'HEAD') === p1, `${f2ms} ms`);
check('only the pushed repository was fetched', forked.slice(mark).filter((t) => !t.fetchSkipped).map((t) => t.repo).join() === 'alpha');
check('the first fork keeps its base', git(path.join(f1, 'alpha'), 'rev-parse', 'HEAD') !== p1);

// ---- housekeeping: fetch + fast-forward of the clone's checkout
const p2 = push('beta', 'pushed-2');
let [status, hkMs] = await timed(() => ws.housekeep(owner));
check('housekeeping fast-forwards the clone', git(clone('beta'), 'rev-parse', 'HEAD') === p2, `${hkMs} ms`);
check('status reports fetchedAt and head for every repo', names.every((n) => status.repos.find((r) => r.name === n)?.fetchedAt && status.repos.find((r) => r.name === n)?.head));
check('status reports the unpublished repo', status.repos.find((r) => r.name === 'ghost')?.problem?.includes('unpublished'));
check('no problems otherwise', status.repos.filter((r) => r.problem && r.name !== 'ghost').length === 0, JSON.stringify(status.repos.filter((r) => r.problem)));

// a dirty clone is reported, not forced
writeFileSync(path.join(clone('gamma'), 'local.txt'), 'x');
push('gamma', 'pushed-3');
status = await ws.housekeep(owner);
check('dirty clone reported, not fast-forwarded', status.repos.find((r) => r.name === 'gamma')?.problem?.includes('local changes'));
await rm(path.join(clone('gamma'), 'local.txt'));

// ---- fetch failure at fork: proceed with cached refs and record it
await rename(path.join(remotes, 'delta.git'), path.join(remotes, 'delta.moved'));
await ws.markPushed('acme/delta', [owner], 'refs/heads/main'); // else housekeeping's fetch just now would be fresh
const f3 = await ws.forkSession(owner, 'C0TEST:3');
const info3 = ws.forkInfo(f3);
check('fork proceeds when a fetch fails, and records it', existsSync(path.join(f3, 'delta')) && !!info3?.repos.delta.fetchError, info3?.repos.delta.fetchError);
await rename(path.join(remotes, 'delta.moved'), path.join(remotes, 'delta.git'));

// ---- fetchRepo (push events), concurrent with housekeeping on the same clones
const p4 = push('alpha', 'pushed-4');
const reports: string[] = [];
const hk = ws.startHousekeeping(() => [owner], (s) => reports.push(s.person));
await Promise.all([ws.fetchRepo('acme/alpha', [owner]), ws.fetchRepo('ACME/alpha.git', [owner]), ws.housekeep(owner)]);
check('fetchRepo by owner/name fast-forwards that clone (concurrent fetches serialized)', git(clone('alpha'), 'rev-parse', 'HEAD') === p4);
check('housekeeping fetches say why', fetched.some((t) => t.trigger === 'pushed') && fetched.some((t) => t.trigger === 'periodic'));
check('fetchRepo for a push to a session branch fetches nothing', (await ws.fetchRepo('acme/alpha', [owner], 'refs/heads/sp/C0TEST-2')) === 0);
await new Promise((r) => setTimeout(r, 300));
hk.stop();
check('startHousekeeping reports', reports.includes('owner'), reports.join(','));

// ---- definition changes: added repo cloned, removed one reported
def([...names.filter((n) => n !== 'gamma'), 'epsilon']);
status = await ws.housekeep(owner);
check('newly defined repo is cloned', existsSync(path.join(clone('epsilon'), '.git')));
check('removed repo is reported and kept', status.repos.find((r) => r.name === 'gamma')?.problem?.includes('removed') && existsSync(clone('gamma')));
def(names);

// ---- no session waits on a clone (work 056): a new person's first fork, a lazy repository, checkout_repo
const ada: Person = { slackUserId: 'U2', dir: 'ada', gitName: 'Ada', gitEmail: 'ada@example.com' };
const adaClone = (n: string) => path.join(ws.personRoot(ada), 'ws', n);
def([...names, 'epsilon'], ['epsilon']);
const [fm, fmMs] = await timed(() => ws.forkSession(ada, 'C0TEST:5'));
check('first fork of a new person does not wait for clones', names.every((n) => !existsSync(path.join(fm, n))), `${fmMs} ms`);
const moAgents = readFileSync(path.join(fm, 'AGENTS.md'), 'utf8');
check('its AGENTS.md lists every repository, none checked out', moAgents.includes('test workspace') && moAgents.includes('5 repositories are available') && moAgents.includes('`epsilon` (acme/epsilon) | —'));
await ws.ensureWorkspace(ada); // joins the background clones (serialized per clone)
check('eager repositories are cloned in the background, the lazy one is not', names.every((n) => existsSync(path.join(adaClone(n), '.git'))) && !existsSync(adaClone('epsilon')));
status = await ws.housekeep(ada);
check('housekeeping leaves an unchecked-out lazy repository alone', !existsSync(adaClone('epsilon')) && !status.repos.find((r) => r.name === 'epsilon')?.problem);
const [co, coMs] = await timed(() => ws.checkoutRepos(fm, ['epsilon', 'acme/alpha', 'nope']));
check('checkout_repo clones a lazy repository partially', git(adaClone('epsilon'), 'config', 'remote.origin.partialclonefilter') === 'blob:none', `${coMs} ms for 2`);
check('checked-out repositories are worktrees on the session branch', ['epsilon', 'alpha'].every((n) => git(path.join(fm, n), 'symbolic-ref', '--short', 'HEAD') === 'sp/C0TEST-5'));
check('an unknown repository fails alone', co.find((r) => r.name === 'nope')?.error?.includes('no repository') && co.filter((r) => !r.error).length === 2);
check('the fork record gains them', !!ws.forkInfo(fm)?.repos.epsilon && !!ws.forkInfo(fm)?.repos.alpha);
const again2 = await ws.checkoutRepos(fm, ['epsilon']);
check('checking out again is a no-op', !again2[0].error && again2[0].base === co[0].base);
status = await ws.housekeep(ada);
check('a lazy repository, once cloned, is kept fetched', !!status.repos.find((r) => r.name === 'epsilon')?.head);
await rm(path.join(fm, 'epsilon'), { recursive: true, force: true });
const redo = await ws.checkoutRepos(fm, ['epsilon']);
check('a worktree the session deleted can be checked out again', !redo[0].error && existsSync(path.join(fm, 'epsilon', '.git')), redo[0].error);
git(fm, 'clone', '-q', `file://${remotes}/beta.git`, 'beta');
const foreign = await ws.checkoutRepos(fm, ['beta']);
check('a directory the session cloned itself is not reported as checked out', !!foreign[0].error?.includes('not a worktree'), foreign[0].error);
await rm(path.join(fm, 'beta'), { recursive: true, force: true });
// A partial clone whose origin moved past contents it never downloaded, then lost its remote: forks go on without it.
push('epsilon', 'pushed-5');
git(adaClone('epsilon'), 'fetch', '-q', 'origin');
await rename(path.join(remotes, 'epsilon.git'), path.join(remotes, 'epsilon.moved'));
const [fu, fuMs] = await timed(() => ws.forkSession(ada, 'C0TEST:6'));
check('a repository that cannot be forked is left out, not fatal', !existsSync(path.join(fu, 'epsilon')) && existsSync(path.join(fu, 'alpha')) && !ws.forkInfo(fu)?.repos.epsilon, `${fuMs} ms`);
check('and the index lists it as not here', readFileSync(path.join(fu, 'AGENTS.md'), 'utf8').includes('`epsilon` (acme/epsilon) | —'));
await rename(path.join(remotes, 'epsilon.moved'), path.join(remotes, 'epsilon.git'));
def(names);

// ---- prune: f1 has an unpushed commit, f2 is clean, f3 has a dirty file; age them all
writeFileSync(path.join(f1, 'beta', 'work.txt'), 'work');
await mkdir(path.join(f1, 'beta', 'rs'), { recursive: true });
writeFileSync(path.join(f1, 'beta', 'rs', 'Cargo.toml'), '[package]\n');
git(path.join(f1, 'beta'), 'add', '-A');
git(path.join(f1, 'beta'), 'commit', '-qm', 'unpushed work');
writeFileSync(path.join(f3, 'alpha', 'scratch.txt'), 'wip');
const f4 = await ws.forkSession(owner, 'C0TEST:4'); // recent: left alone
const old = new Date(Date.now() - 30 * 86400e3);
async function age(fork: string) {
  const paths = [fork, path.join(fork, '.fork.json')];
  for (const wt of [...names.map((n) => path.join(fork, n)), path.join(fork, '.wt', 'beta-b')]) {
    if (!existsSync(wt)) continue;
    for (const f of ['index', 'logs/HEAD']) paths.push(path.resolve(wt, git(wt, 'rev-parse', '--git-path', f)));
  }
  for (const p of paths) if (existsSync(p)) await utimes(p, old, old);
}
// Build and dependency dirs (work 071): ignored ones in idle f1 go, nested too, and in its .wt/ worktree;
// a target/ without Cargo.toml stays; f3 has a live runner and keeps its own.
for (const n of ['alpha', 'beta']) appendFileSync(path.join(git(clone(n), 'rev-parse', '--absolute-git-dir'), 'info', 'exclude'), 'node_modules/\ntarget/\n.venv/\n');
git(path.join(f1, 'beta'), 'worktree', 'add', '-q', '-b', 'sp/C0TEST-1-b', path.join(f1, '.wt', 'beta-b'));
const f1Gone = ['beta/node_modules', 'beta/pkg/a/node_modules', 'beta/rs/target', 'beta/.venv', '.wt/beta-b/node_modules'].map((d) => path.join(f1, d));
for (const d of [...f1Gone, path.join(f1, 'beta', 'other', 'target'), path.join(f3, 'alpha', 'node_modules')]) await mkdir(path.join(d, 'x'), { recursive: true });
for (const f of [f1, f2, f3]) await age(f);
const branch2 = 'sp/C0TEST-2';
const [pruned, pruneMs] = await timed(() => ws.housekeep(owner, new Set([f3])));
check('idle fork loses its ignored build/dependency dirs (nested, Rust target, venv, .wt worktree)', f1Gone.every((d) => !existsSync(d)) && existsSync(path.join(f1, 'beta', 'pkg', 'a')), f1Gone.filter(existsSync).join(', '));
check('a target/ without Cargo.toml is kept', existsSync(path.join(f1, 'beta', 'other', 'target', 'x')));
check('a fork with a live runner keeps its node_modules', existsSync(path.join(f3, 'alpha', 'node_modules', 'x')));
check('clean idle fork removed (worktrees, branch, dir)', !existsSync(f2) && !git(clone('alpha'), 'branch', '--list', branch2) && !git(clone('alpha'), 'worktree', 'list').includes(f2), `${pruneMs} ms housekeeping`);
check('fork with an unpushed commit kept and reported', existsSync(f1) && pruned.repos.some((r) => r.name.endsWith('C0TEST-1791495325-000001') && r.problem?.includes('unpushed')), pruned.repos.find((r) => r.name.includes('000001'))?.problem);
check('fork with uncommitted changes kept and reported', existsSync(f3) && pruned.repos.some((r) => r.name.endsWith('C0TEST-3') && r.problem?.includes('uncommitted')));
check('recent fork untouched', existsSync(path.join(f4, '.fork.json')));

// ---- credential helper and gh shim against a fake token socket
await mkdir(process.env.SP_RUN!, { recursive: true });
const requests: any[] = [];
const server = net.createServer((c) => {
  let buf = '';
  c.on('data', (d) => {
    buf += d;
    if (!buf.includes('\n')) return;
    requests.push(JSON.parse(buf.split('\n')[0]));
    c.end(JSON.stringify({ token: 'ghs_fake123', expiresAt: new Date(Date.now() + 3600e3).toISOString() }) + '\n');
  });
});
await new Promise<void>((r) => server.listen(path.join(process.env.SP_RUN!, 'token.sock'), r));
const helper = path.join(BIN, 'git-credential-slack-presence');
const helperCfg = path.join(tmp, 'gitconfig-helper');
writeFileSync(helperCfg, `[credential "https://github.com"]\n\thelper =\n\thelper = ${helper}\n\tuseHttpPath = true\n`);
const fill = await new Promise<string>((resolve, reject) => {
  const p = execFile('git', ['credential', 'fill'], { env: { ...process.env, GIT_CONFIG_GLOBAL: helperCfg, SP_SESSION_KEY: k1, GIT_TERMINAL_PROMPT: '0' } }, (e, out) => (e ? reject(e) : resolve(out)));
  p.stdin!.end('protocol=https\nhost=github.com\npath=example-org/blue.git\n\n');
});
check('git credential fill gets the token through the helper', fill.includes('username=x-access-token') && fill.includes('password=ghs_fake123'), fill.replace(/\n/g, ' '));
// The host names the session from the socket asked (work 080), so the helper sends none.
check('helper sends owner/name and no session key', requests[0]?.sessionKey === undefined && requests[0]?.repos?.[0] === 'example-org/blue', JSON.stringify(requests[0]));
const other = await new Promise<string>((resolve) => {
  const p = execFile(helper, ['get'], (_e, out) => resolve(out));
  p.stdin!.end('protocol=https\nhost=gitlab.com\n\n');
});
check('helper ignores other hosts', other === '' && requests.length === 1);

const fakebin = path.join(tmp, 'fakebin');
await mkdir(fakebin);
writeFileSync(path.join(fakebin, 'gh'), '#!/bin/sh\necho "real gh token=$GH_TOKEN args=$*"\n', { mode: 0o755 });
const viaPath = (await run(path.join(BIN, 'gh'), ['pr', 'list'], { env: { ...process.env, PATH: `${BIN}:${fakebin}:${process.env.PATH}` } })).stdout.trim();
check('gh shim finds the real gh on PATH and sets GH_TOKEN', viaPath === 'real gh token=ghs_fake123 args=pr list', viaPath);
const viaEnv = (await run(path.join(BIN, 'gh'), ['api', 'user'], { env: { ...process.env, SP_REAL_GH: path.join(fakebin, 'gh') } })).stdout.trim();
check('gh shim honors SP_REAL_GH', viaEnv === 'real gh token=ghs_fake123 args=api user', viaEnv);
server.close();

// ---- timings on local mirrors of the real seed repositories (no network)
if (process.argv.includes('--real')) {
  const wsRoot = path.resolve(import.meta.dirname, '..', '..', '..');
  const seed = ['opencomputer', 'slack-presence'].filter((n) => existsSync(path.join(wsRoot, n, '.git')));
  const mirrors = path.join(tmp, 'remotes', 'real');
  for (const n of seed) git(tmp, 'clone', '-q', '--bare', '--no-local', path.join(wsRoot, n), path.join(mirrors, `${n}.git`));
  writeFileSync(
    process.env.SP_DEFINITION!,
    JSON.stringify({ repos: seed.map((n) => ({ name: n, remote: `file://${mirrors}/${n}.git`, branch: 'main' })), rootFiles: { 'AGENTS.md': 'root.md' } }),
  );
  const real: Person = { ...owner, dir: 'real' };
  const [, cloneMs] = await timed(() => ws.ensureWorkspace(real));
  const files = seed.map((n) => `${n} ${git(path.join(ws.personRoot(real), 'ws', n), 'ls-files').split('\n').length} files`).join(', ');
  console.log(`real: cloned ${seed.length} repos in ${cloneMs} ms (${files})`);
  for (const k of ['R:1', 'R:2', 'R:3']) {
    const [, t] = await timed(() => ws.forkSession(real, k));
    console.log(`real: fork ${k} of ${seed.length} repos in ${t} ms (fetch included)`);
  }
}

// ---- timings: the same fork with a fetch per repository (SP_FORK_FETCH_FRESH=0) and from fresh refs
process.env.SP_FORK_FETCH_FRESH = '0';
const [, fetchingMs] = await timed(() => ws.forkSession(owner, 'C0TEST:8'));
delete process.env.SP_FORK_FETCH_FRESH;
const [, freshAgainMs] = await timed(() => ws.forkSession(owner, 'C0TEST:9'));

console.log(`\nfork of 4 synthetic repos: ${forkMs} ms first, ${fetchingMs} ms fetching, ${freshAgainMs} ms from fresh refs (${freshMs} ms earlier); ${failures ? `${failures} FAILED` : 'all checks passed'}; ${tmp}`);
if (!process.argv.includes('--keep')) await rm(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
