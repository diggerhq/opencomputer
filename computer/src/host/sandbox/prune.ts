// Removing a sandboxed thread nobody used for SP_FORK_RETENTION_DAYS (work
// 103, "Sequences", Prune): what workspaces/prune.ts does for a fork on the
// host, without the host running git on anything a session wrote. It is the
// second half of a `podman` host's fork keeper (host.ts); artifacts.ts is the
// first.
//
// Invariants:
// - A thread with uncommitted changes or commits on no remote is never
//   removed. Only its container goes (`podman rm --force`, which releases the
//   image and the writable layer); its home, workspace and record stay, and
//   the next message creates the container again. Why it was kept is reported.
// - Git is asked in a helper container that sees the workspace read-only, for
//   the repositories the record names; the branch forgotten is the record's.
// - Only a thread with no runner is pruned, asked again once git answered and
//   once more before the record goes: a thread that started meanwhile keeps
//   its record, and starts as one whose container and home are gone.
// - The record is deleted last, and only when the container and the home went:
//   until then the next pass finds the thread and tries again.
// - A thread that was kept is asked about again when it was used, or an hour
//   later (a helper container per thread is not free).

import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { log } from '../../log.js';
import type { WorkspaceStatus } from '../../protocol.js';
import { retention, safeKey } from '../../workspaces/clones.js';
import { type ScriptRunner, row } from '../../workspaces/script-runner.js';
import { CLONES, type Mounts, WORKSPACE } from './mounts.js';
import type { AsRunner } from './podman.js';
import { type Bind, recreateRemoveArgs, unshareRmArgs } from './podman-args.js';
import type { Records, SandboxRecord } from './records.js';

type RepoStatus = WorkspaceStatus['repos'][number];

const INSPECT_TIMEOUT_MS = 60_000;
const FORGET_TIMEOUT_MS = 30_000;
const REMOVE_TIMEOUT_MS = 120_000;
const ASK_AGAIN_MS = 3600e3;

export interface PruneDeps {
  as: AsRunner;
  records: Records;
  mounts: Mounts;
  /** `sandboxScripts.helperScripts`. */
  helper(person: string, binds?: Bind[]): ScriptRunner;
  /** True while the thread of this record has a runner. */
  running(id: string): boolean;
  /** When the thread was last used (artifacts.ts). */
  lastUsed(r: SandboxRecord): Promise<number>;
  /** Remove: the container and its home, and what the host keeps by the id; true when both went (containers.ts). */
  remove(id: string): Promise<boolean>;
  /** Delete the thread's run directory (sweep.ts); true when it is gone. */
  deleteRun(id: string): Promise<boolean>;
  now?: () => number;
}

export type SandboxPrune = ReturnType<typeof sandboxPrune>;

const msg = (e: unknown) => (e as Error)?.message ?? String(e);

export function sandboxPrune(d: PruneDeps) {
  const { mounts: m } = d;
  const now = d.now ?? Date.now;
  /** Threads that were kept: their last use then, why, and when git was asked. */
  const kept = new Map<string, { used: number; why: string; at: number }>();

  /** Why the thread's work is not all on a remote; undefined when it is. */
  async function unsaved(r: SandboxRecord): Promise<string | undefined> {
    const ws = m.workspace(r);
    const names = Object.keys(r.repos ?? {});
    // Nothing of it on disk (a start that never made it): nothing to lose.
    if (!names.length || !(await lstat(ws).catch(() => undefined))) return undefined;
    const binds: Bind[] = [{ src: ws, dst: WORKSPACE, ro: true }, ...names.map((name) => ({ src: m.registry(r, name), dst: `${CLONES}/${name}/.git/worktrees` }))];
    const out = await d.helper(r.person, binds).run('ws-inspect.sh', ['--only=state', CLONES, WORKSPACE, ...names], { timeoutMs: INSPECT_TIMEOUT_MS });
    const reasons: string[] = [];
    names.forEach((name, i) => {
      // Answered by position, from 1.
      const [dirty, unpushed] = row(out, String(i + 1));
      const n = Number(unpushed);
      if (dirty !== 'clean') reasons.push(`${name} has uncommitted changes`);
      else if (n) reasons.push(n > 0 ? `${name} has ${n} unpushed commit${n > 1 ? 's' : ''}` : `${name}: cannot count unpushed commits`);
    });
    return reasons.length ? reasons.join(', ') : undefined;
  }

  const inUse = (r: SandboxRecord) => d.running(r.id) || d.records.get(r.id)?.usedAt !== r.usedAt;

  /** Prune one thread. Returns why it was kept; undefined when it is gone, or in use again. */
  async function prune(r: SandboxRecord): Promise<string | undefined> {
    const why = await unsaved(r);
    if (inUse(r)) return undefined;
    if (why) {
      await d.as.podman(recreateRemoveArgs(r.id), { timeoutMs: REMOVE_TIMEOUT_MS });
      return why;
    }
    if (!(await d.remove(r.id))) throw new Error('its container or its home was not removed');
    await d.as.podman(unshareRmArgs([m.workspace(r), path.dirname(m.registry(r, 'x'))]), { timeoutMs: REMOVE_TIMEOUT_MS });
    // One branch per thread, normally; a branch the session did not get from the host (`sp/…`) is not the host's to delete.
    const byBranch = new Map<string, string[]>();
    for (const [name, repo] of Object.entries(r.repos ?? {})) if (repo.branch.startsWith('sp/')) byBranch.set(repo.branch, [...(byBranch.get(repo.branch) ?? []), name]);
    for (const [branch, names] of byBranch)
      await d.helper(r.person).run('ws-forget.sh', [CLONES, branch, ...names], { timeoutMs: FORGET_TIMEOUT_MS }).catch((e) => log.warn(`workspaces: branch ${branch} of ${r.key} not forgotten: ${msg(e)}`));
    await d.deleteRun(r.id);
    // It started again while it was removed: its record is what lets that start, and the next, find it.
    if (inUse(r)) return undefined;
    d.records.delete(r.id);
    log.info(`workspaces: pruned thread ${r.key} (${r.person}), sandbox ${r.id}`);
    return undefined;
  }

  /** Prune `person`'s threads unused for SP_FORK_RETENTION_DAYS, except those with a runner. Returns the ones kept, as housekeeping reports them. */
  async function pruneIdle(person: string): Promise<RepoStatus[]> {
    const rows: RepoStatus[] = [];
    for (const r of d.records.all()) {
      if (r.person !== person || d.running(r.id)) continue;
      const used = await d.lastUsed(r);
      if (now() - used < retention()) {
        kept.delete(r.id);
        continue;
      }
      const before = kept.get(r.id);
      let why = before && before.used === used && now() - before.at < ASK_AGAIN_MS ? before.why : undefined;
      if (!why) {
        kept.delete(r.id);
        try {
          why = await prune(r);
          if (why) kept.set(r.id, { used, why, at: now() });
        } catch (e) {
          why = `prune failed: ${msg(e)}`; // tried again at the next pass
        }
      }
      if (why) rows.push({ name: `sessions/${safeKey(r.key)}`, problem: `idle beyond retention, kept: ${why}` });
    }
    return rows;
  }

  return { prune, pruneIdle };
}
