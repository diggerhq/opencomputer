// When a sandboxed thread was last used, and pruning the build and dependency
// directories of idle ones (work 071, for work 103): what workspaces/idle.ts
// does for a fork on the host, without the host running git or a shell on
// anything a session wrote.
//
// Invariants:
// - The host only lists (readdir) and looks (lstat) in a workspace and a
//   registry, and follows no link there: idle.ts walks only directories that
//   lstat says are no links, and `stillInside` resolves what is to be removed
//   once more after git answered. Git is asked in a helper container
//   that sees the workspace read-only, with no network.
// - Directories are removed inside Podman's user namespace (`podman unshare
//   rm -rf`): what a session made as root belongs to subordinate uids.
// - Only a thread with no runner is pruned, and its directories are removed
//   in the thread's turn (thread-lock.ts): a thread that has a runner then, or
//   whose record a start wrote since git was asked, loses nothing, and a start
//   that arrives during the removal waits for it.
// - A thread is looked at again only once it was used again.

import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { log } from '../../log.js';
import { artifactQuestion, artifactsIdle, ignoredArtifacts, stillInside } from '../../workspaces/idle.js';
import type { ScriptRunner } from '../../workspaces/script-runner.js';
import { CLONES, type Mounts, WORKSPACE } from './mounts.js';
import type { AsRunner } from './podman.js';
import { type Bind, unshareRmArgs } from './podman-args.js';
import type { Records, SandboxRecord } from './records.js';
import type { ThreadLocks } from './thread-lock.js';

const INSPECT_TIMEOUT_MS = 60_000;
const REMOVE_TIMEOUT_MS = 120_000;

export interface ArtifactsDeps {
  as: AsRunner;
  records: Records;
  /** The threads' turns, shared with the starts. */
  locks: ThreadLocks;
  mounts: Mounts;
  /** `sandboxScripts.helperScripts`. */
  helper(person: string, binds: Bind[]): ScriptRunner;
  /** True while the thread of this record has a runner. */
  running(id: string): boolean;
}

export type SandboxArtifacts = ReturnType<typeof sandboxArtifacts>;

const mtime = async (p: string) => (await lstat(p).catch(() => undefined))?.mtimeMs ?? 0;

export function sandboxArtifacts(d: ArtifactsDeps) {
  const { mounts: m } = d;
  /** Threads already pruned, by their last use then. */
  const pruned = new Map<string, number>();

  /** Latest use: the record (every start and delivery) and each worktree's index and HEAD log, which live in the thread's registries. */
  async function lastUsed(r: SandboxRecord): Promise<number> {
    const times = [Date.parse(r.usedAt) || 0];
    for (const name of Object.keys(r.repos ?? {})) {
      const admin = path.join(m.registry(r, name), name);
      times.push(await mtime(path.join(admin, 'index')), await mtime(path.join(admin, 'logs', 'HEAD')));
    }
    return Math.max(...times);
  }

  /** Remove the git-ignored build and dependency directories of a stopped thread's worktrees. Returns the directories removed, as host paths. */
  async function pruneArtifacts(r: SandboxRecord): Promise<string[]> {
    const ws = m.workspace(r);
    const q = await artifactQuestion(ws);
    if (!q.asked.length) return [];
    const binds: Bind[] = [
      { src: ws, dst: WORKSPACE, ro: true },
      ...Object.keys(r.repos ?? {}).map((name) => ({ src: m.registry(r, name), dst: `${CLONES}/${name}/.git/worktrees` })),
    ];
    const out = await d.helper(r.person, binds).run('ws-inspect.sh', ['--only=ignored', CLONES, WORKSPACE, ...q.names], { stdin: q.lines, timeoutMs: INSPECT_TIMEOUT_MS });
    return d.locks.run(r.person, r.key, async () => {
      // No runner and no start since git was asked first, then the paths: a thread that is not running cannot move them after they were resolved.
      if (d.running(r.id) || d.records.get(r.id)?.usedAt !== r.usedAt) return [];
      const ignored = await stillInside(ws, ignoredArtifacts(q, out));
      if (!ignored.length) return [];
      await d.as.podman(unshareRmArgs(ignored), { timeoutMs: REMOVE_TIMEOUT_MS });
      return ignored;
    });
  }

  /** Prune the build and dependency directories of `person`'s threads idle for SP_ARTIFACTS_IDLE_HOURS, except those with a runner. */
  async function pruneIdle(person: string): Promise<void> {
    for (const r of d.records.all()) {
      if (r.person !== person || d.running(r.id)) continue;
      const used = await lastUsed(r);
      if (Date.now() - used < artifactsIdle() || pruned.get(r.id) === used) continue;
      const ws = m.workspace(r);
      const removed = await pruneArtifacts(r).catch((e) => (log.warn(`workspaces: artifacts of ${ws}: ${(e as Error)?.message ?? e}`), [] as string[]));
      if (removed.length) log.info(`workspaces: removed ${removed.length} build/dependency dirs from idle thread ${r.key} (${r.person}): ${removed.map((x) => path.relative(ws, x)).join(', ')}`);
      pruned.set(r.id, used);
    }
  }

  return { lastUsed, pruneArtifacts, pruneIdle };
}
