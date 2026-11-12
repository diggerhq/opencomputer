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
import { errText, git, personRoot, retention, scriptsFor, serial } from './clones.js';
import { removeCodexHome } from './codex-homes.js';
import { forkInfo } from './fork.js';
import { clonesOf, lastUsed, worktrees } from './idle.js';
import { hostScripts, row } from './script-runner.js';

type RepoStatus = WorkspaceStatus['repos'][number];

/** Remove a fork unless a worktree has uncommitted changes or commits on no remote. Returns why it was kept. */
export async function pruneFork(forkPath: string): Promise<string | undefined> {
  const wts = await worktrees(forkPath);
  // ws-inspect.sh reads without refreshing the index, whose new mtime would make the fork look used (lastUsed).
  const s = hostScripts(clonesOf(forkPath));
  const names = wts.map((wt) => path.basename(wt));
  const out = names.length ? await s.run('ws-inspect.sh', ['--only=state', s.clones, s.workspace(forkPath), ...names], { timeoutMs: 0 }) : '';
  const state = new Map(names.map((name) => [name, row(out, name)] as const));
  const reasons: string[] = [];
  for (const name of names) {
    const [dirty, unpushed] = state.get(name)!;
    if (dirty !== 'clean') {
      reasons.push(`${name} has uncommitted changes`);
      continue;
    }
    const n = Number(unpushed);
    if (n) reasons.push(n > 0 ? `${name} has ${n} unpushed commit${n > 1 ? 's' : ''}` : `${name}: cannot count unpushed commits`);
  }
  if (reasons.length) return reasons.join(', ');
  const key = forkInfo(forkPath)?.key;
  for (const wt of wts) {
    const [, , branch, common] = state.get(path.basename(wt))!;
    if (!common) throw new Error(`${path.basename(wt)}: no git directory`);
    const clone = path.dirname(path.resolve(wt, common));
    await serial(clone, async () => {
      // --force only for ignored files (build output): tracked and untracked changes were checked above.
      await git(clone, ['worktree', 'remove', '--force', wt]);
      const c = scriptsFor(clone);
      if (branch.startsWith('sp/')) await c.s.run('ws-forget.sh', [c.s.clones, branch, c.repo], { timeoutMs: 0 }).catch(() => {});
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
