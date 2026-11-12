// Housekeeping of a person's workspace (work 045; split out of index.ts for
// work 103): the periodic pass (clone what is missing, fetch and fast-forward
// the rest, prune idle forks and their build directories), and the fetch after
// a push to the branch forks start from.
//
// Invariants:
// - At most HOUSEKEEPING_FETCHES housekeeping fetches run at once on the host,
//   each in its clone's fetch lane; the fast-forward runs under the worktree lock.
// - One pass per person at a time.
// - A clone's checkout is only ever fast-forwarded: never when it is on another
//   branch, has local changes or has diverged.

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { log } from '../log.js';
import type { Person, WorkspaceStatus } from '../protocol.js';
import { isLazy, loadDefinition, type RepoDef, repoSlug, workspacesEnabled } from './definition.js';
import { mkdir } from './as-runner.js';
import {
  cloneRepo, copyRootFiles, defaultBranch, errText, type FetchTrigger, fetchedAt, fetchErrorType, fetchInterval, fetchLane, fetchTimeout, freshness, git,
  HOUSEKEEPING_FETCHES, isClone, observe, observed, ok, personRoot, serial, workspaceDir,
} from './clones.js';
import { limit } from './fetch-schedule.js';
import { pruneIdleArtifacts } from './idle.js';
import { pruneForks } from './prune.js';

type RepoStatus = WorkspaceStatus['repos'][number];

const housekeepingFetch = limit(HOUSEKEEPING_FETCHES);

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
      observe(() => observed().repoFetched?.({ repo: repo.name, ms, fastForwarded: ff === true, trigger, fetchError }));
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
