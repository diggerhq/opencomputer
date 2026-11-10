// Where sessions run. WORKDIR pins every session to one existing checkout;
// otherwise each session gets its own scratch git repo under ./workspaces.

import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..', 'workspaces');

async function git(cwd: string, ...args: string[]) {
  try {
    return (await exec('git', args, { cwd, maxBuffer: 20 << 20 })).stdout;
  } catch (e: any) {
    // `git diff --no-index` exits 1 when files differ; its stdout is the answer.
    if (typeof e?.stdout === 'string' && e.code === 1) return e.stdout as string;
    throw e;
  }
}

export async function ensureWorkdir(key: string): Promise<string> {
  if (process.env.WORKDIR) return path.resolve(process.env.WORKDIR);
  const dir = path.join(ROOT, key.replace(/[^a-zA-Z0-9]+/g, '-'));
  await mkdir(dir, { recursive: true });
  await git(dir, 'rev-parse', '--git-dir').catch(async () => {
    await git(dir, 'init', '-q');
    await git(dir, '-c', 'user.name=slack-presence', '-c', 'user.email=slack-presence@localhost', 'commit', '-q', '--allow-empty', '-m', 'init');
  });
  return dir;
}

export async function gitBranch(cwd: string) {
  return (await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').catch(() => '')).trim() || undefined;
}

/** Working-tree diff against HEAD, untracked files included, without touching the index. */
export async function gitDiff(cwd: string): Promise<string> {
  const tracked = await git(cwd, 'diff', 'HEAD', '--no-color').catch(() => '');
  const untracked = (await git(cwd, 'ls-files', '--others', '--exclude-standard').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .slice(0, 100);
  const added = await Promise.all(
    untracked.map((f) => git(cwd, 'diff', '--no-color', '--no-index', '/dev/null', f).catch(() => '')),
  );
  return [tracked, ...added].filter(Boolean).join('');
}
