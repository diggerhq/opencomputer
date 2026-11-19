// A session's fork (work 045; split out of index.ts for work 103):
// <root>/sessions/<key>/ with AGENTS.md, .fork.json and one git worktree per
// repository on branch sp/<key>, from origin/<default>. Making one
// (forkSession), adding repositories to it (checkoutRepos), reading and
// touching its record.
//
// Invariants:
// - .fork.json is written last: a fork without it is incomplete, and the host
//   gives no credentials to a runner in one (host/adoption.ts).
// - A fork never waits on a clone it was not asked for, and its fetch is
//   bounded by SP_FORK_FETCH_TIMEOUT; past it the cached ref is used.
// - A repository that cannot be forked is left out, not fatal to the session.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { log } from '../log.js';
import type { CheckoutResult, Person } from '../protocol.js';
import { isLazy, loadDefinition, type RepoDef, repoSlug } from './definition.js';
import { repoIndex } from './repo-index.js';
import { appendFile, mkdir, touch, writeFile } from './as-runner.js';
import {
  cloneRepo, copyRootFiles, defaultBranch, errText, fetchedAt, fetchErrorType, fetchLane, fetchTimeout, forkDir, forkFetchFresh, forkFetchTimeout,
  freshness, isClone, observe, observed, prepareInBackground, safeKey, scriptsFor, serial, workspaceDir, workspacePrepared,
} from './clones.js';
import { FORK_FILE } from './idle.js';
import { row } from './script-runner.js';

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
    // ws-add.sh: the branch if the clone has it, else a new one from origin/<b>; a destination that is already this
    // clone's worktree is left as it is. On a partial clone the checkout downloads file contents, so it is bounded like a fetch.
    const { s, repo: name } = scriptsFor(clone);
    const out = await s.run('ws-add.sh', [s.clones, s.workspace(path.dirname(dest)), branch, '0', `${name}=${b}`], { timeoutMs: fetchTimeout() });
    const [, , base] = row(out, name);
    const end = Date.now();
    observe(() => observed().repoForked?.({ repo: repo.name, ms: end - queued, fetchMs: fetched - queued, worktreeMs: end - locked,
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
    const { s, repo } = scriptsFor(clone);
    row(await s.run('ws-fetch.sh', [s.clones, repo, b], { timeoutMs: timeout }), repo);
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
