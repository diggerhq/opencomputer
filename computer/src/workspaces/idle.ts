// When a session fork was last used, and pruning the build and dependency
// directories of idle ones (work 071): a Node worktree's node_modules is about
// 1 GiB, the bulk of a fork on disk, and an install or build brings each back.
// prune.ts prunes whole forks.
//
// Invariant: what is looked for in a fork (worktrees, artifact directories) is
// found with readdir and lstat alone and no link is followed: a session wrote
// everything there. host/sandbox/artifacts.ts does the same pruning for a
// thread that runs in a container, with these same lists.

import { execFile } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { log } from '../log.js';
import { command, rm } from './as-runner.js';
import { hostScripts, row } from './script-runner.js';

const exec = promisify(execFile);

export const FORK_FILE = '.fork.json';

/** A fork idle this long loses its ignored build and dependency directories (work 071). */
export const artifactsIdle = () => Number(process.env.SP_ARTIFACTS_IDLE_HOURS || 24) * 3600e3;
/** How deep below a worktree's root to look (packages/<name>/node_modules is 2). */
const ARTIFACT_DEPTH = 3;
/**
 * Directories an install or build regenerates, by name. Generic names (dist,
 * build) are left alone; `target` counts only next to a Cargo.toml.
 */
const ARTIFACTS = new Set(['node_modules', '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', '.wrangler',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.gradle']);
const isArtifact = (dir: string, name: string) =>
  ARTIFACTS.has(name) || (name === 'target' && there(path.join(dir, 'Cargo.toml')));
const there = (p: string) => !!lstatSync(p, { throwIfNoEntry: false });

/** A person's clones directory, from one of their forks: <root>/sessions/<key> and <root>/ws (clones.ts). */
export const clonesOf = (fork: string) => path.join(path.dirname(path.dirname(path.resolve(fork))), 'ws');

// As the runner user, like clones.ts: the host's own user fails git's ownership check on these repos.
// Only lastUsed runs git here; what pruneArtifacts asks goes through ws-inspect.sh.
const git = async (cwd: string, args: string[]) => {
  const c = command('git', args, { GIT_TERMINAL_PROMPT: '0' });
  return (await exec(c.cmd, c.args, { cwd, env: c.env })).stdout.trim();
};

const mtime = async (p: string) => (await stat(p).catch(() => undefined))?.mtimeMs ?? 0;

export async function worktrees(fork: string) {
  const entries = await readdir(fork, { withFileTypes: true }).catch(() => []);
  return entries.filter((d) => d.isDirectory() && there(path.join(fork, d.name, '.git'))).map((d) => path.join(fork, d.name));
}

/** A fork's worktrees, and those agents add under its `.wt/` (git worktree add .wt/<name>). */
export async function allWorktrees(fork: string) {
  return [...(await worktrees(fork)), ...(await worktrees(path.join(fork, '.wt')))];
}

/** Latest use: the fork record (touchFork) and each worktree's index and HEAD log (git activity). */
export async function lastUsed(fork: string) {
  const times = [await mtime(fork), await mtime(path.join(fork, FORK_FILE))];
  for (const wt of await allWorktrees(fork)) {
    for (const f of ['index', 'logs/HEAD']) {
      const p = await git(wt, ['rev-parse', '--git-path', f]).catch(() => '');
      if (p) times.push(await mtime(path.resolve(wt, p)));
    }
  }
  return Math.max(...times);
}

/** The artifact directories under `dir` (not below one another, not in .git), at most `depth` levels down. */
async function findArtifacts(dir: string, depth = ARTIFACT_DEPTH): Promise<string[]> {
  const found: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory() || d.name === '.git') continue;
    const p = path.join(dir, d.name);
    if (isArtifact(dir, d.name)) found.push(p);
    else if (depth > 0) found.push(...(await findArtifacts(p, depth - 1)));
  }
  return found;
}

/** What ws-inspect.sh `--only=ignored` is asked about a fork: its worktrees by name, and one line of stdin per artifact directory. */
export interface ArtifactQuestion {
  /** The worktrees with artifact directories, relative to the fork: the script's arguments. */
  names: string[];
  /** The directories asked about, in the order of the lines. */
  asked: string[];
  /** `<worktree, from 1>\t<path in it>` per directory. */
  lines: string;
}

/** The artifact directories of a fork's worktrees, as the question for ws-inspect.sh. */
export async function artifactQuestion(forkPath: string): Promise<ArtifactQuestion> {
  const names: string[] = [];
  const asked: string[] = [];
  let lines = '';
  for (const wt of await allWorktrees(forkPath)) {
    // A path with a tab or a newline does not fit a line of the script's input: not asked about, so kept.
    const dirs = (await findArtifacts(wt)).filter((dir) => !/[\t\n]/.test(path.relative(wt, dir)));
    if (!dirs.length) continue;
    names.push(path.relative(forkPath, wt));
    for (const dir of dirs) {
      asked.push(dir);
      lines += `${names.length}\t${path.relative(wt, dir)}\n`;
    }
  }
  return { names, asked, lines };
}

/**
 * The directories git ignores, from the script's answer: tracked files are never ignored. It answers a worktree by
 * its position and a directory by its line, both from 1: a name with a tab would not survive being printed.
 */
export function ignoredArtifacts(q: ArtifactQuestion, out: string): string[] {
  const ignored: string[] = [];
  for (const n of q.names.keys())
    for (const line of row(out, String(n + 1)).slice(4)) {
      const dir = q.asked[Number(line) - 1];
      if (dir) ignored.push(dir);
    }
  return ignored;
}

/**
 * Remove the git-ignored build and dependency directories of a fork's
 * worktrees: the bulk of a fork on disk and regenerable. Tracked or unignored
 * ones are kept. Returns the directories removed.
 */
export async function pruneArtifacts(forkPath: string): Promise<string[]> {
  const q = await artifactQuestion(forkPath);
  if (!q.asked.length) return [];
  const s = hostScripts(clonesOf(forkPath));
  const out = await s.run('ws-inspect.sh', ['--only=ignored', s.clones, s.workspace(forkPath), ...q.names], { stdin: q.lines, timeoutMs: 0 });
  const removed: string[] = [];
  for (const dir of ignoredArtifacts(q, out)) {
    await rm(dir);
    removed.push(dir);
  }
  return removed;
}

/** Forks already pruned, by their last use then: a fork is looked at again only once used again. */
const artifactsPruned = new Map<string, number>();

/** Prune the build and dependency directories of the forks in `sessions` idle for SP_ARTIFACTS_IDLE_HOURS, except `active` ones. */
export async function pruneIdleArtifacts(sessions: string, active: Set<string>) {
  for (const name of await readdir(sessions).catch(() => [] as string[])) {
    const fork = path.join(sessions, name);
    if (active.has(fork)) continue;
    const used = await lastUsed(fork);
    if (Date.now() - used < artifactsIdle() || artifactsPruned.get(fork) === used) continue;
    const removed = await pruneArtifacts(fork).catch((e) => (log.warn(`workspaces: artifacts of ${fork}: ${(e as Error)?.message ?? e}`), []));
    if (removed.length) log.info(`workspaces: removed ${removed.length} build/dependency dirs from idle fork ${fork}: ${removed.map((d) => path.relative(fork, d)).join(', ')}`);
    artifactsPruned.set(fork, used);
  }
}
