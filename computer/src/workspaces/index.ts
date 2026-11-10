// Workspaces and housekeeping on a host (work 045, item S4). Other items
// import personRoot, ensureWorkspace, forkSession, startHousekeeping and
// fetchRepo; the rest is exported for the host agent and the dev check.
//
// <SP_DATA>/people/<dir>/
//   ws/AGENTS.md, ws/<repo>/    clones from the workspace definition. Sessions never edit them:
//                               they are each repository's object store and fetch target.
//   sessions/<key>/             a session's fork: AGENTS.md, .fork.json, and one git worktree per
//                               repository on branch sp/<key>, from origin/<default>: fetched at fork
//                               time unless already fresh (fetch-schedule.ts).
//
// The definition is the gateway's if it sent one, else the JSON file named by
// SP_DEFINITION (definitions/computer.json); see definition.ts.
// No session waits on a clone (work 056): a fork gets the clones that exist,
// eager repositories are cloned in the background, lazy ones (partially) when
// a session checks them out with checkoutRepos, and the fork's AGENTS.md
// lists everything the definition grants (repo-index.ts).
// Remotes are plain HTTPS; git authenticates through the credential helper configured
// globally on the host (bin/git-credential-slack-presence), never through tokens in
// remotes. Worktree operations on one clone are serialized, and so are its
// fetches, in a separate lane (fetch-schedule.ts); at most HOUSEKEEPING_FETCHES
// housekeeping fetches run at once on the host.

import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { log } from '../log.js';
import { type CheckoutResult, HOST_DATA, type Person, type WorkspaceStatus } from '../protocol.js';
import { type Definition, isLazy, loadDefinition, type RepoDef, repoSlug, workspacesEnabled } from './definition.js';
import { repoIndex } from './repo-index.js';
import { appendFile, command, copyFile, mkdir, rename, rm, touch, writeFile } from './as-runner.js';
import { Freshness, keyedQueue, limit } from './fetch-schedule.js';
import { FORK_FILE, lastUsed, pruneIdleArtifacts, worktrees } from './idle.js';
import { removeCodexHome } from './codex-homes.js';

export * from './definition.js';
export { configureAsRunner, mkdir as mkdirAsRunner } from './as-runner.js';

const exec = promisify(execFile);

type RepoStatus = WorkspaceStatus['repos'][number];


// ---------------------------------------------------------------- config

/** Durations: `300` (seconds), `500ms`, `30s`, `5m`, `2h`. */
function duration(value: string | undefined, fallback: string): number {
  const m = (value || fallback).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
  if (!m) return duration(fallback, fallback);
  return Number(m[1]) * { ms: 1, s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[(m[2] ?? 's') as 'ms'];
}
const fetchInterval = () => duration(process.env.SP_FETCH_INTERVAL, '5m');
const fetchTimeout = () => duration(process.env.SP_FETCH_TIMEOUT, '2m');
const forkFetchTimeout = () => duration(process.env.SP_FORK_FETCH_TIMEOUT, '5s');
/** A fork skips its fetch of a clone fetched this recently and not pushed to since (fetch-schedule.ts). */
const forkFetchFresh = () => duration(process.env.SP_FORK_FETCH_FRESH, '60s');
const HOUSEKEEPING_FETCHES = 4;
const retention = () => duration(process.env.SP_FORK_RETENTION_DAYS ? `${process.env.SP_FORK_RETENTION_DAYS}d` : undefined, '14d');
const CLONE_TIMEOUT = 30 * 60e3;

// ---------------------------------------------------------------- layout

/** A session key as a directory and branch name: `C0B:1791.82` → `C0B-1791-82`. */
export function safeKey(key: string) {
  return key.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Root of a person's area on the host: <SP_DATA>/people/<dir>. */
export function personRoot(person: Person): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(person.dir)) throw new Error(`bad person dir: ${person.dir}`);
  return path.join(HOST_DATA, 'people', person.dir);
}
export const workspaceDir = (person: Person) => path.join(personRoot(person), 'ws');
export const forkDir = (person: Person, sessionKey: string) => path.join(personRoot(person), 'sessions', safeKey(sessionKey));

// ---------------------------------------------------------------- git

async function git(cwd: string, args: string[], timeout = 0) {
  const c = command('git', args, { GIT_TERMINAL_PROMPT: '0' });
  return (await exec(c.cmd, c.args, { cwd, timeout, env: c.env, maxBuffer: 20 << 20 })).stdout.trim();
}
const ok = (p: Promise<unknown>) => p.then(() => true, () => false);
function errText(e: any): string {
  if (e?.killed) return 'timed out';
  const lines = String(e?.stderr || e?.message || e).trim().split('\n').filter(Boolean);
  return lines.find((l) => /^(fatal|error):/.test(l)) ?? lines.pop() ?? 'failed';
}
const isClone = (dir: string) => existsSync(path.join(dir, '.git'));
const fetchErrorType = (e: unknown) => ((e as { killed?: boolean })?.killed ? 'timeout' : 'git_fetch');

/** Timings the host agent reports as telemetry (work 054); calls never affect the work. */
export interface WorkspaceObserver {
  repoForked?(t: { repo: string; ms: number; fetchMs: number; worktreeMs: number; lockWaitMs: number; fetchSkipped: boolean; fetchError?: string }): void;
  repoFetched?(t: { repo: string; ms: number; fastForwarded: boolean; trigger: FetchTrigger; fetchError?: string }): void;
}
/** Why housekeeping fetched a clone: its periodic pass, or a push to the branch it forks from. */
export type FetchTrigger = 'periodic' | 'pushed';
let observer: WorkspaceObserver = {};
export const observeWorkspaces = (o: WorkspaceObserver) => void (observer = o);
const observe = (f: () => void) => {
  try {
    f();
  } catch {}
};

// One queue per clone: no concurrent clone, worktree add, prune or fast-forward on the same repository.
const serial = keyedQueue();
// Fetches have their own lane per clone, so worktree operations never wait behind one.
const fetchLane = keyedQueue();
const freshness = new Freshness();
const housekeepingFetch = limit(HOUSEKEEPING_FETCHES);

const branches = new Map<string, string>();
async function defaultBranch(clone: string, repo: RepoDef) {
  if (repo.branch) return repo.branch;
  const cached = branches.get(clone);
  if (cached) return cached;
  const head = () => git(clone, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const ref = await head().catch(async () => (await git(clone, ['remote', 'set-head', 'origin', '--auto'], fetchTimeout()), head()));
  const b = ref.replace(/^origin\//, '');
  branches.set(clone, b);
  return b;
}

const fetchedAt = new Map<string, string>();
const PREPARED_FILE = '.workspace-prepared';

async function cloneRepo(clone: string, repo: RepoDef): Promise<boolean> {
  return serial(clone, async () => {
    if (isClone(clone)) return false;
    const tmp = `${clone}.cloning`;
    await rm(tmp);
    await mkdir(path.dirname(clone), { recursive: true });
    const t0 = Date.now();
    // A lazy repository is cloned while a session waits: blobs come on demand (checkout fetches HEAD's).
    const partial = isLazy(repo) ? ['--filter=blob:none'] : [];
    await git(path.dirname(clone), ['clone', '--quiet', ...partial, ...(repo.branch ? ['-b', repo.branch] : []), repo.remote, tmp], CLONE_TIMEOUT);
    await rename(tmp, clone);
    fetchedAt.set(clone, new Date().toISOString());
    freshness.fetchedFrom(clone, t0);
    log.info(`workspaces: cloned ${repo.name} into ${clone} in ${Date.now() - t0} ms`);
    for (const cmd of repo.setup ?? []) {
      const c = command('sh', ['-c', cmd]);
      await exec(c.cmd, c.args, { cwd: clone, env: c.env, timeout: CLONE_TIMEOUT, maxBuffer: 20 << 20 }).catch((e) => {
        throw new Error(`setup \`${cmd}\`: ${errText(e)}`);
      });
    }
    return true;
  });
}

async function copyRootFiles(def: Definition, dir: string) {
  for (const [target, source] of Object.entries(def.rootFiles)) {
    const dest = path.join(dir, target);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(source, dest).catch((e) => log.warn(`workspaces: root file ${target}: ${errText(e)}`));
  }
}

// ---------------------------------------------------------------- workspace

/** Ensure the person's workspace exists (clone its eager repositories if missing). Idempotent; nothing waits on it. */
export async function ensureWorkspace(person: Person): Promise<void> {
  const def = loadDefinition();
  const ws = workspaceDir(person);
  await mkdir(ws, { recursive: true });
  await copyRootFiles(def, ws);
  const failed: string[] = [];
  await Promise.all(
    def.repos
      .filter((r) => !r.unpublished && !isLazy(r))
      .map((r) =>
        cloneRepo(path.join(ws, r.name), r).catch((e) => {
          failed.push(`${r.name}: ${errText(e)}`);
        }),
      ),
  );
  // Housekeeping keeps retrying missing eager repositories in the background.
  await writeFile(path.join(ws, PREPARED_FILE), new Date().toISOString() + '\n');
  if (failed.length) throw new Error(`workspace ${person.dir}: ${failed.join('; ')}`);
}

// One background preparation per person at a time: forks in a row must not stack clones of the same failing repository.
const preparing = new Map<string, Promise<void>>();
/** ensureWorkspace without waiting: for forks, and for people the gateway just added. */
export function prepareInBackground(person: Person) {
  if (preparing.has(person.dir)) return;
  const run = ensureWorkspace(person)
    .catch((e) => log.warn(`workspaces: ${errText(e)}`))
    .finally(() => preparing.delete(person.dir));
  preparing.set(person.dir, run);
}

export function workspacePrepared(person: Person): boolean {
  return existsSync(path.join(workspaceDir(person), PREPARED_FILE));
}

// ---------------------------------------------------------------- forks

export interface ForkInfo {
  key: string;
  owner: string;
  createdAt: string;
  ms: number;
  repos: Record<string, { branch: string; from: string; base: string; fetchError?: string }>;
}

/**
 * Create the session's fork: <root>/sessions/<key>/ with a git worktree per
 * repository on a fresh branch from origin/<default>, fetched just before
 * unless the clone's refs are fresh (fetch-schedule.ts).
 * Returns the fork path (the runner's cwd). Idempotent: an existing fork is returned as is.
 */
export async function forkSession(person: Person, sessionKey: string): Promise<string> {
  const fork = forkDir(person, sessionKey);
  if (existsSync(path.join(fork, FORK_FILE))) return fork;
  const t0 = Date.now();
  const def = loadDefinition();
  const ws = workspaceDir(person);
  // Nothing here waits on a clone (work 056): the fork gets the clones that
  // exist. Eager repositories still missing (a first session, or ones the
  // definition just gained) are cloned in the background; the session checks
  // out any repository it needs with checkoutRepos, which waits for that one.
  if (!workspacePrepared(person) || def.repos.some((r) => !r.unpublished && !isLazy(r) && !isClone(path.join(ws, r.name))))
    prepareInBackground(person);
  const repos = def.repos.filter((r) => isClone(path.join(ws, r.name)));
  await mkdir(fork, { recursive: true });
  await copyRootFiles(def, fork);
  const branch = `sp/${safeKey(sessionKey)}`;
  // A repository that cannot be forked (a partial clone whose remote is unreachable) is left out, not fatal to the session.
  const forked = await Promise.all(
    repos.map((r) =>
      forkRepo(path.join(ws, r.name), r, path.join(fork, r.name), branch).then(
        (f) => [r.name, f] as const,
        (e) => (log.warn(`workspaces: ${r.name} left out of ${sessionKey}: ${errText(e)}`), undefined),
      ),
    ),
  );
  const info: ForkInfo = {
    key: sessionKey,
    owner: person.dir,
    createdAt: new Date().toISOString(),
    ms: Date.now() - t0,
    repos: Object.fromEntries(forked.filter((f) => f !== undefined)),
  };
  const index = repoIndex(def.repos, new Set(Object.keys(info.repos)));
  if (index) await appendFile(path.join(fork, 'AGENTS.md'), `\n${index}`);
  await writeFile(path.join(fork, FORK_FILE), JSON.stringify(info, null, 2) + '\n');
  const stale = Object.entries(info.repos).filter(([, r]) => r.fetchError);
  log.info(`workspaces: forked ${Object.keys(info.repos).length} repos for ${sessionKey} (${person.dir}) in ${info.ms} ms`);
  for (const [name, r] of stale) log.warn(`workspaces: ${name} forked from cached ${r.from} (${r.base.slice(0, 8)}); fetch failed: ${r.fetchError}`);
  return fork;
}

async function forkRepo(clone: string, repo: RepoDef, dest: string, branch: string) {
  const queued = Date.now();
  const b = await defaultBranch(clone, repo);
  const fetch = await forkFetch(clone, b);
  const fetched = Date.now();
  return serial(clone, async () => {
    const locked = Date.now();
    if (!existsSync(dest)) {
      // A worktree whose directory the session deleted is still registered; forget it so it can be added again.
      await git(clone, ['worktree', 'prune']);
      const exists = await ok(git(clone, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]));
      // --no-track: the session pushes its own branch (`git push -u origin HEAD`), not origin/<default>.
      // On a partial clone this downloads the checkout's file contents, so it is bounded like a fetch.
      await git(clone, ['worktree', 'add', '--quiet', ...(exists ? [dest, branch] : ['--no-track', '-b', branch, dest, `origin/${b}`])], fetchTimeout()).catch(
        async (e) => {
          await rm(dest);
          await git(clone, ['worktree', 'prune']).catch(() => {});
          throw e;
        },
      );
    } else if (!(await isWorktreeOf(dest, clone))) {
      throw new Error(`./${path.basename(dest)} exists but is not a worktree of this workspace's ${repo.name}; move it away and check out again`);
    }
    const base = await git(dest, ['rev-parse', 'HEAD']);
    const end = Date.now();
    observe(() => observer.repoForked?.({ repo: repo.name, ms: end - queued, fetchMs: fetched - queued, worktreeMs: end - locked,
      lockWaitMs: locked - fetched, fetchSkipped: fetch.skipped, fetchError: fetch.kind }));
    return { branch, from: `origin/${b}`, base, ...(fetch.error && { fetchError: fetch.error }) };
  });
}

/**
 * Make origin/<b> current for a fork: nothing if the clone is fresh, else a
 * fetch of that branch alone (no prune: as fast as a fetch gets) in the
 * clone's fetch lane. Waiting in the lane and the fetch together are bounded
 * by SP_FORK_FETCH_TIMEOUT; past it the fork uses the cached ref.
 */
async function forkFetch(clone: string, b: string): Promise<{ skipped: boolean; error?: string; kind?: string }> {
  if (freshness.fresh(clone, forkFetchFresh())) return { skipped: true };
  const timeout = forkFetchTimeout();
  const run = fetchLane(clone, async () => {
    // A fetch that finished while this one waited (housekeeping's, another fork's) may be enough.
    if (freshness.fresh(clone, forkFetchFresh())) return { skipped: true };
    const started = Date.now();
    await git(clone, ['fetch', '--quiet', '--no-tags', 'origin', b], timeout);
    fetchedAt.set(clone, new Date().toISOString());
    freshness.fetchedFrom(clone, started);
    return { skipped: false };
  });
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timed out waiting for a fetch'), { killed: true })), timeout);
  });
  try {
    return await Promise.race([run, late]);
  } catch (e) {
    return { skipped: false, error: errText(e), kind: fetchErrorType(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function isWorktreeOf(dir: string, clone: string) {
  const common = await git(dir, ['rev-parse', '--git-common-dir']).catch(() => '');
  if (!common) return false;
  const real = (p: string) => realpath(p).catch(() => p);
  return (await real(path.resolve(dir, common))) === (await real(path.join(clone, '.git')));
}

/**
 * Check repositories out into an existing fork (the session's `checkout_repo`
 * tool): clone each if missing (waiting for a background clone already
 * running), then a worktree on the fork's branch. `wanted` holds definition
 * names or `owner/name`. Each repository succeeds or fails on its own; the
 * fork record gains the ones checked out.
 */
export async function checkoutRepos(forkPath: string, wanted: string[]): Promise<CheckoutResult[]> {
  const info = forkInfo(forkPath);
  if (!info) throw new Error(`not a session fork: ${forkPath}`);
  const person = { dir: info.owner } as Person;
  if (forkDir(person, info.key) !== path.resolve(forkPath)) throw new Error(`fork ${forkPath} is not where its record says`);
  const def = loadDefinition();
  const ws = workspaceDir(person);
  const branch = `sp/${safeKey(info.key)}`;
  const results = await Promise.all(
    [...new Set(wanted.map((w) => w.trim()).filter(Boolean))].map(async (want): Promise<CheckoutResult> => {
      const repo = findRepo(def.repos, want);
      const fail = (error: string) => ({ name: repo?.name ?? want, dir: repo?.name ?? want, branch, from: '', base: '', error });
      if (!repo) return fail(`no repository ${want} in this workspace; the list is in AGENTS.md`);
      if (repo.unpublished) return fail(`${repo.name} is not published yet`);
      const clone = path.join(ws, repo.name);
      try {
        const t0 = Date.now();
        if (await cloneRepo(clone, repo)) log.info(`workspaces: ${repo.name} cloned on demand for ${info.key} in ${Date.now() - t0} ms`);
        const r = await forkRepo(clone, repo, path.join(forkPath, repo.name), branch);
        return { name: repo.name, dir: repo.name, ...r };
      } catch (e) {
        return fail(errText(e));
      }
    }),
  );
  const done = results.filter((r) => !r.error);
  // Read-modify-write of the record, serialized: a session may check out in parallel tool calls.
  if (done.length)
    await serial(forkPath, async () => {
      const fresh = forkInfo(forkPath) ?? info;
      for (const { name, branch: b, from, base, fetchError } of done) fresh.repos[name] = { branch: b, from, base, ...(fetchError && { fetchError }) };
      await writeFile(path.join(forkPath, FORK_FILE), JSON.stringify(fresh, null, 2) + '\n');
    });
  return results;
}

function findRepo(repos: RepoDef[], want: string): RepoDef | undefined {
  const w = want.replace(/\.git$/, '').toLowerCase();
  return repos.find((r) => r.name.toLowerCase() === w) ?? repos.find((r) => repoSlug(r.remote).toLowerCase() === w);
}

/** Read a fork's record (bases, fetch failures), if it is complete. */
export function forkInfo(forkPath: string): ForkInfo | undefined {
  try {
    return JSON.parse(readFileSync(path.join(forkPath, FORK_FILE), 'utf8'));
  } catch {
    return undefined;
  }
}

/** Mark a fork as used now; pruning counts retention from the latest use. The host calls this per delivery. */
export async function touchFork(forkPath: string) {
  await touch(path.join(forkPath, FORK_FILE)).catch(() => {});
}

/** Remove a fork unless a worktree has uncommitted changes or commits on no remote. Returns why it was kept. */
export async function pruneFork(forkPath: string): Promise<string | undefined> {
  const wts = await worktrees(forkPath);
  const reasons: string[] = [];
  for (const wt of wts) {
    const name = path.basename(wt);
    // --no-optional-locks: no index refresh, whose new mtime would make the fork look used (lastUsed).
    const dirty = await git(wt, ['--no-optional-locks', 'status', '--porcelain']).catch((e) => `unreadable: ${errText(e)}`);
    if (dirty) {
      reasons.push(`${name} has uncommitted changes`);
      continue;
    }
    const n = Number(await git(wt, ['rev-list', '--count', 'HEAD', '--not', '--remotes']).catch(() => '-1'));
    if (n) reasons.push(n > 0 ? `${name} has ${n} unpushed commit${n > 1 ? 's' : ''}` : `${name}: cannot count unpushed commits`);
  }
  if (reasons.length) return reasons.join(', ');
  const key = forkInfo(forkPath)?.key;
  for (const wt of wts) {
    const clone = path.dirname(path.resolve(wt, await git(wt, ['rev-parse', '--git-common-dir'])));
    const branch = await git(wt, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '');
    await serial(clone, async () => {
      // --force only for ignored files (build output): tracked and untracked changes were checked above.
      await git(clone, ['worktree', 'remove', '--force', wt]);
      if (branch.startsWith('sp/')) await git(clone, ['branch', '-D', branch]).catch(() => {});
    });
  }
  await rm(forkPath);
  if (key) await removeCodexHome(key); // its rollouts outlive nothing else of the session
  return undefined;
}

async function pruneForks(person: Person): Promise<RepoStatus[]> {
  const sessions = path.join(personRoot(person), 'sessions');
  const kept: RepoStatus[] = [];
  for (const name of await readdir(sessions).catch(() => [] as string[])) {
    const fork = path.join(sessions, name);
    if (Date.now() - (await lastUsed(fork)) < retention()) continue;
    const why = await pruneFork(fork).catch((e) => `prune failed: ${errText(e)}`);
    if (why) kept.push({ name: `sessions/${name}`, problem: `idle beyond retention, kept: ${why}` });
    else log.info(`workspaces: pruned fork ${fork}`);
  }
  return kept;
}

// ---------------------------------------------------------------- housekeeping

/** Fast-forward the checkout; a string says why not, `true` that it moved. */
async function fastForward(clone: string, b: string): Promise<string | boolean | undefined> {
  const current = await git(clone, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => '');
  if (current !== b) return `checkout is on ${current || 'a detached HEAD'}, not ${b}; not fast-forwarded`;
  if (await git(clone, ['status', '--porcelain'])) return 'checkout has local changes; not fast-forwarded';
  const [head, remote] = [await git(clone, ['rev-parse', 'HEAD']), await git(clone, ['rev-parse', `origin/${b}`])];
  if (head === remote) return undefined;
  if (!(await ok(git(clone, ['merge-base', '--is-ancestor', head, remote])))) return `${b} has diverged from origin/${b}; not fast-forwarded`;
  await git(clone, ['merge', '--ff-only', '--quiet', `origin/${b}`], fetchTimeout()); // downloads contents on a partial clone
  return true;
}

/**
 * Clone if missing (eager only), else fetch --prune (in the clone's fetch
 * lane, at most HOUSEKEEPING_FETCHES at once) and fast-forward the clone's
 * default branch checkout (under the worktree lock).
 */
async function syncRepo(person: Person, repo: RepoDef, trigger: FetchTrigger): Promise<RepoStatus> {
  if (repo.unpublished) return { name: repo.name, problem: 'unpublished; not cloned' };
  const clone = path.join(workspaceDir(person), repo.name);
  // Lazy and not checked out by any session yet: nothing to keep fetched. Once cloned, it is kept warm like the rest.
  if (isLazy(repo) && !isClone(clone)) return { name: repo.name };
  try {
    await cloneRepo(clone, repo);
    const b = await defaultBranch(clone, repo);
    const problems: string[] = [];
    let fetchError: string | undefined;
    let ms = 0;
    await housekeepingFetch(() =>
      fetchLane(clone, async () => {
        const started = Date.now();
        await git(clone, ['fetch', '--quiet', '--prune', 'origin'], fetchTimeout()).then(
          () => (fetchedAt.set(clone, new Date().toISOString()), freshness.fetchedFrom(clone, started)),
          (e) => (problems.push(`fetch: ${errText(e)}`), (fetchError = fetchErrorType(e))),
        );
        ms = Date.now() - started;
      }), trigger === 'pushed');
    return await serial(clone, async () => {
      const ff = await fastForward(clone, b).catch((e) => `fast-forward: ${errText(e)}`);
      if (typeof ff === 'string') problems.push(ff);
      observe(() => observer.repoFetched?.({ repo: repo.name, ms, fastForwarded: ff === true, trigger, fetchError }));
      const head = await git(clone, ['rev-parse', '--short', `origin/${b}`]).catch(() => undefined);
      return { name: repo.name, fetchedAt: fetchedAt.get(clone), head, ...(problems.length && { problem: problems.join('; ') }) };
    });
  } catch (e) {
    return { name: repo.name, fetchedAt: fetchedAt.get(clone), problem: errText(e) };
  }
}

/**
 * One housekeeping pass for a person: root files, clone new repositories, fetch and
 * fast-forward the rest, report repositories removed from the definition, prune idle forks
 * and the build and dependency directories of forks idle a day, except forks in `active` (with a live runner).
 */
export async function housekeep(person: Person, active: Set<string> = new Set()): Promise<WorkspaceStatus> {
  const def = loadDefinition();
  const ws = workspaceDir(person);
  await mkdir(ws, { recursive: true });
  await copyRootFiles(def, ws);
  const repos = await Promise.all(def.repos.map((r) => syncRepo(person, r, 'periodic')));
  const defined = new Set(def.repos.map((r) => r.name));
  for (const name of (await readdir(ws)).sort()) {
    if (!defined.has(name) && isClone(path.join(ws, name))) repos.push({ name, problem: 'removed from the definition; clone kept' });
  }
  repos.push(...(await pruneForks(person)));
  await pruneIdleArtifacts(path.join(personRoot(person), 'sessions'), active);
  const status = { person: person.dir, repos };
  lastStatus.set(person.dir, status);
  return status;
}

/** Age of the least recently fetched clone this process fetched, in seconds. */
export function oldestFetchAgeS(now = Date.now()): number | undefined {
  const times = [...fetchedAt.values()].map(Date.parse);
  return times.length ? Math.round((now - Math.min(...times)) / 1000) : undefined;
}

const lastStatus = new Map<string, WorkspaceStatus>();
const running = new Map<string, Promise<void>>();
let reporter: ((s: WorkspaceStatus) => void) | undefined;
let activeForks: () => Set<string> = () => new Set();

function cycle(person: Person) {
  const busy = running.get(person.dir);
  if (busy) return busy;
  const run = housekeep(person, activeForks())
    .then((s) => reporter?.(s))
    .catch((e) => log.warn(`workspaces: housekeeping ${person.dir}: ${errText(e)}`))
    .finally(() => running.delete(person.dir));
  running.set(person.dir, run);
  return run;
}

/**
 * Start periodic housekeeping for these people; calls `report` with each workspace's
 * status. `active` names the forks with a live runner, never pruned of build and dependency directories.
 */
export function startHousekeeping(
  people: () => Person[],
  report: (s: WorkspaceStatus) => void,
  active: () => Set<string> = () => new Set(),
): { now(): void; stop(): void } {
  reporter = report;
  activeForks = active;
  const tick = () => {
    if (workspacesEnabled()) for (const p of people()) void cycle(p);
  };
  tick();
  const timer = setInterval(tick, fetchInterval());
  return {
    /** A pass right away (the definition changed); people already in a pass are left to it. */
    now: tick,
    stop() {
      clearInterval(timer);
      if (reporter === report) reporter = undefined;
    },
  };
}

/**
 * A push to `ref` of one repository (by remote name, e.g. `acme/widgets`):
 * every clone of it that forks from that branch stops being fresh now. Returns
 * those clones by person. Pushes to other branches (sessions' own `sp/*`) touch nothing.
 */
export async function markPushed(repo: string, people: Person[], ref?: string): Promise<{ person: Person; repo: RepoDef }[]> {
  const want = repo.replace(/\.git$/, '').toLowerCase();
  const matches = loadDefinition().repos.filter((r) => !r.unpublished && (repoSlug(r.remote).toLowerCase() === want || r.name === repo));
  const hit: { person: Person; repo: RepoDef }[] = [];
  for (const person of people)
    for (const r of matches) {
      const clone = path.join(workspaceDir(person), r.name);
      if (!isClone(clone)) continue;
      // An unknown default branch counts as a match: fetching once too often is cheaper than a stale fork.
      const b = ref && (await defaultBranch(clone, r).catch(() => undefined));
      if (b && ref !== `refs/heads/${b}`) continue;
      freshness.pushedNow(clone);
      hit.push({ person, repo: r });
    }
  return hit;
}

/** Fetch one repository in every workspace that has it, after a push to `ref` (any branch if omitted). Returns the clones fetched. */
export async function fetchRepo(repo: string, people: Person[], ref?: string): Promise<number> {
  const hit = await markPushed(repo, people, ref);
  await Promise.all(
    people.map(async (p) => {
      const present = hit.filter((h) => h.person === p).map((h) => h.repo);
      if (!present.length) return;
      const updated = await Promise.all(present.map((r) => syncRepo(p, r, 'pushed')));
      const prev = lastStatus.get(p.dir);
      if (!prev) return;
      const status = { ...prev, repos: prev.repos.map((s) => updated.find((u) => u.name === s.name) ?? s) };
      lastStatus.set(p.dir, status);
      reporter?.(status);
    }),
  );
  return hit.length;
}
