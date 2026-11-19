// The knowledge repository's git hooks (work tracking, design 3.4): the
// release's hooks/knowledge/ scripts, installed by the host into the shared
// clone of the definition's `role: "knowledge"` repository. Session forks are
// worktrees of that clone, and linked worktrees run the hooks of the clone's
// common directory, so every session's commits and pushes go through them.
//
// Invariants:
// - Installed on every sync (housekeeping, a push, a workspace preparation),
//   not only at clone time: existing clones never pass through a clone again.
//   Idempotent: an up-to-date hook is not rewritten; a stale one is replaced
//   atomically (written beside it, then renamed), so a commit never sees half a hook.
// - Only hooks carrying HOOK_MARK are ever replaced or removed; someone else's hook
//   of the same name stays, reported as a problem.
// - A clone that is not (or no longer) the knowledge repository has none of
//   ours: they are removed from its hooks directory, so no other repository's
//   pushes are checked.

import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { chmod, command, mkdir, rename, rm, writeFile } from './as-runner.js';
import { isKnowledge, type RepoDef } from './definition.js';

const exec = promisify(execFile);

export const KNOWLEDGE_HOOKS = ['prepare-commit-msg', 'pre-push'] as const;
/** In every hook we install: what tells ours from a hook someone else put there. */
export const HOOK_MARK = 'opencomputer-knowledge-hook';
const SOURCE = path.resolve(import.meta.dirname, '..', '..', 'hooks', 'knowledge');

const read = (file: string) => readFile(file, 'utf8').catch(() => undefined);
const executable = (file: string) =>
  stat(file).then(
    (s) => (s.mode & 0o111) === 0o111,
    () => false,
  );

/**
 * Bring the clone's hooks in line with the repository's role: ours installed
 * and current for the knowledge repository, ours removed from any other.
 * Throws when a hook of ours cannot be installed (its name is taken by another hook).
 */
export async function syncKnowledgeHooks(clone: string, repo: RepoDef, source = SOURCE): Promise<void> {
  if (!isKnowledge(repo)) {
    // Where an earlier pass would have put them; no git call for the many repositories that never had them.
    for (const name of KNOWLEDGE_HOOKS) {
      const dest = path.join(clone, '.git', 'hooks', name);
      if ((await read(dest))?.includes(HOOK_MARK)) await rm(dest);
    }
    return;
  }
  // Where git looks for this clone and its worktrees: core.hooksPath if set, else the common directory's hooks/.
  const c = command('git', ['rev-parse', '--git-path', 'hooks'], { GIT_TERMINAL_PROMPT: '0' });
  const dir = path.resolve(clone, (await exec(c.cmd, c.args, { cwd: clone, env: c.env })).stdout.trim());
  await mkdir(dir, { recursive: true });
  const taken: string[] = [];
  for (const name of KNOWLEDGE_HOOKS) {
    const dest = path.join(dir, name);
    const want = await readFile(path.join(source, name), 'utf8');
    const have = await read(dest);
    if (have === want && (await executable(dest))) continue;
    if (have !== undefined && !have.includes(HOOK_MARK)) {
      taken.push(name);
      continue;
    }
    const tmp = `${dest}.installing`;
    await writeFile(tmp, want);
    await chmod(tmp, 0o755);
    await rename(tmp, dest);
  }
  if (taken.length)
    throw new Error(`${taken.join(', ')} in ${dir} ${taken.length > 1 ? 'are' : 'is'} not ours; work-tracking hooks not installed there`);
}
