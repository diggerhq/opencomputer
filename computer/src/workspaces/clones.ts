// A person's clones on a host (work 045, item S4; split out of index.ts for
// work 103): where things live under <SP_DATA>/people/<dir>, how git runs on
// them, the locks, cloning, and preparing a person's workspace. fork.ts,
// housekeep.ts and prune.ts build on this; index.ts has the overview.
//
// Invariants:
// - Worktree operations on one clone are serialized (`serial`), and so are its
//   fetches, in a separate lane (`fetchLane`, fetch-schedule.ts).
// - Git runs as the runners' user (as-runner.ts) and never prompts.
// - No session waits on a clone (work 056): eager repositories are cloned in
//   the background, one preparation per person at a time.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { log } from '../log.js';
import { HOST_DATA, type Person } from '../protocol.js';
import { type Definition, isLazy, loadDefinition, type RepoDef } from './definition.js';
import { command, copyFile, mkdir, rename, rm, writeFile } from './as-runner.js';
import { Freshness, keyedQueue } from './fetch-schedule.js';

const exec = promisify(execFile);

// ---------------------------------------------------------------- config

/** Durations: `300` (seconds), `500ms`, `30s`, `5m`, `2h`. */
function duration(value: string | undefined, fallback: string): number {
  const m = (value || fallback).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
  if (!m) return duration(fallback, fallback);
  return Number(m[1]) * { ms: 1, s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[(m[2] ?? 's') as 'ms'];
}
export const fetchInterval = () => duration(process.env.SP_FETCH_INTERVAL, '5m');
export const fetchTimeout = () => duration(process.env.SP_FETCH_TIMEOUT, '2m');
export const forkFetchTimeout = () => duration(process.env.SP_FORK_FETCH_TIMEOUT, '5s');
/** A fork skips its fetch of a clone fetched this recently and not pushed to since (fetch-schedule.ts). */
export const forkFetchFresh = () => duration(process.env.SP_FORK_FETCH_FRESH, '60s');
export const HOUSEKEEPING_FETCHES = 4;
export const retention = () => duration(process.env.SP_FORK_RETENTION_DAYS ? `${process.env.SP_FORK_RETENTION_DAYS}d` : undefined, '14d');
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

export async function git(cwd: string, args: string[], timeout = 0) {
  const c = command('git', args, { GIT_TERMINAL_PROMPT: '0' });
  return (await exec(c.cmd, c.args, { cwd, timeout, env: c.env, maxBuffer: 20 << 20 })).stdout.trim();
}
export const ok = (p: Promise<unknown>) => p.then(() => true, () => false);
export function errText(e: any): string {
  if (e?.killed) return 'timed out';
  const lines = String(e?.stderr || e?.message || e).trim().split('\n').filter(Boolean);
  return lines.find((l) => /^(fatal|error):/.test(l)) ?? lines.pop() ?? 'failed';
}
export const isClone = (dir: string) => existsSync(path.join(dir, '.git'));
export const fetchErrorType = (e: unknown) => ((e as { killed?: boolean })?.killed ? 'timeout' : 'git_fetch');

/** Timings the host agent reports as telemetry (work 054); calls never affect the work. */
export interface WorkspaceObserver {
  repoForked?(t: { repo: string; ms: number; fetchMs: number; worktreeMs: number; lockWaitMs: number; fetchSkipped: boolean; fetchError?: string }): void;
  repoFetched?(t: { repo: string; ms: number; fastForwarded: boolean; trigger: FetchTrigger; fetchError?: string }): void;
}
/** Why housekeeping fetched a clone: its periodic pass, or a push to the branch it forks from. */
export type FetchTrigger = 'periodic' | 'pushed';
let observer: WorkspaceObserver = {};
export const observeWorkspaces = (o: WorkspaceObserver) => void (observer = o);
/** The observer now (fork.ts and housekeep.ts report through it). */
export const observed = () => observer;
export const observe = (f: () => void) => {
  try {
    f();
  } catch {}
};

// One queue per clone: no concurrent clone, worktree add, prune or fast-forward on the same repository.
export const serial = keyedQueue();
// Fetches have their own lane per clone, so worktree operations never wait behind one.
export const fetchLane = keyedQueue();
export const freshness = new Freshness();

const branches = new Map<string, string>();
export async function defaultBranch(clone: string, repo: RepoDef) {
  if (repo.branch) return repo.branch;
  const cached = branches.get(clone);
  if (cached) return cached;
  const head = () => git(clone, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const ref = await head().catch(async () => (await git(clone, ['remote', 'set-head', 'origin', '--auto'], fetchTimeout()), head()));
  const b = ref.replace(/^origin\//, '');
  branches.set(clone, b);
  return b;
}

export const fetchedAt = new Map<string, string>();
const PREPARED_FILE = '.workspace-prepared';

export async function cloneRepo(clone: string, repo: RepoDef): Promise<boolean> {
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

export async function copyRootFiles(def: Definition, dir: string) {
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
