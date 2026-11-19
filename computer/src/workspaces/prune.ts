// Removing idle forks (work 045; split out of index.ts for work 103): a fork
// unused for SP_FORK_RETENTION_DAYS goes, with its worktrees and its branch.
// idle.ts says when a fork was last used and prunes build directories.
//
// Invariant: a fork with uncommitted changes or commits on no remote is never
// removed; the reason it was kept is reported.

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { log } from '../log.js';
import type { Person, WorkspaceStatus } from '../protocol.js';
import { rm } from './as-runner.js';
import { errText, git, personRoot, retention, serial } from './clones.js';
import { removeCodexHome } from './codex-homes.js';
import { forkInfo } from './fork.js';
import { lastUsed, worktrees } from './idle.js';

type RepoStatus = WorkspaceStatus['repos'][number];

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

export async function pruneForks(person: Person): Promise<RepoStatus[]> {
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
