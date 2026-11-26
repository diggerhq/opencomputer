// spawn_thread (work 047): a session starts another Slack thread to run work
// in parallel. The runner offers it as a tool of the in-process `calvin` MCP
// server (see session.ts); the request
// goes runner → host → gateway, and the gateway posts a short message and
// starts a session on it, owned by the same person, as a mention would.
//
// The brief lives in a repository, not in the message: before asking, the
// tool fetches the brief's repository and checks the file is on its default
// branch, which is what the new thread's fork starts from.

import path from 'node:path';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tool } from './tool.js';
import { z } from 'zod';
import type { SpawnRequest, SpawnResult } from '../protocol.js';

export const SPAWN_TOOL = 'mcp__calvin__spawn_thread';
/** Bounds fan-out per runner, which matters in bypass mode where nobody approves each spawn. */
const MAX_SPAWNS = 8;

const git = (cwd: string, ...args: string[]) =>
  promisify(execFile)('git', ['-C', cwd, ...args], { encoding: 'utf8' }).then((r) => r.stdout.trim());

/** Checks the brief is on its repository's fetched default branch; returns its GitHub URL when there is one. */
export async function checkBrief(cwd: string, brief: string): Promise<string | undefined> {
  const [file, anchor] = brief.split('#', 2);
  if (!file.endsWith('.md')) throw new Error(`brief must be a Markdown file: ${brief}`);
  const abs = path.resolve(cwd, file);
  if (!abs.startsWith(cwd + path.sep)) throw new Error(`brief must be inside the workspace: ${brief}`);
  if (!existsSync(path.dirname(abs))) throw new Error(`no such directory for the brief: ${brief}`);
  const top = await git(path.dirname(abs), 'rev-parse', '--show-toplevel').catch(() => {
    throw new Error(`brief is not in a git repository: ${brief}`);
  });
  const rel = path.relative(top, abs);
  await git(top, 'fetch', '--quiet', 'origin').catch((e) => {
    throw new Error(`could not fetch ${path.basename(top)}: ${e?.stderr?.trim() || e?.message}`);
  });
  const head = await git(top, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').catch(() => 'origin/main');
  await git(top, 'cat-file', '-e', `${head}:${rel}`).catch(() => {
    throw new Error(`${rel} is not on ${head}. Commit and push the brief to the default branch first; the new thread forks from it.`);
  });
  const remote = await git(top, 'remote', 'get-url', 'origin').catch(() => '');
  const gh = remote.match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/)?.[1];
  return gh && `https://github.com/${gh}/blob/${head.replace(/^origin\//, '')}/${rel}${anchor ? `#${anchor}` : ''}`;
}

/** The tool; `spawn` asks the gateway through the host. */
export function spawnTool(cwd: () => string, spawn: (req: SpawnRequest) => Promise<SpawnResult>) {
  let spawned = 0;
  const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
  return tool(
    'spawn_thread',
    'Start a new Slack thread that works on a task in parallel, as the same person, in its own fresh workspace fork. ' +
      'Put everything the thread needs (goal, constraints, sources, done criteria, where to report) in a Markdown brief in the ' +
      'knowledge repository work doc that owns the topic, commit and push it to the default branch, then call this with a one-line ' +
      'task and the brief path. The posted message is only the task and a link, so never put the brief in `task`. ' +
      'The new thread claims and reports in the brief; returns its link.',
    {
      task: z.string().min(3).max(150).describe('One line, imperative: what the new thread should do'),
      brief: z
        .string()
        .describe('Workspace-relative path of the brief, with an optional anchor, e.g. docs/work/047-x.md#item-2'),
      model: z
        .enum(['smart', 'fast', 'default'])
        .optional()
        .describe('Model for the new thread: `smart` for hard, open-ended work, `fast` for quick mechanical work, `default` otherwise. Omit to keep this thread\'s model.'),
    },
    async ({ task, brief, model }) => {
      if (spawned >= MAX_SPAWNS) return fail(`this session already started ${MAX_SPAWNS} threads; ask the person before starting more`);
      if (/\n/.test(task.trim())) return fail('task must be one line; the brief holds the rest');
      let briefUrl: string | undefined;
      try {
        briefUrl = await checkBrief(cwd(), brief.trim());
      } catch (e: any) {
        return fail(e?.message ?? String(e));
      }
      try {
        const r = await spawn({ task: task.trim(), brief: brief.trim(), briefUrl, ...(model ? { tier: model } : {}) });
        spawned++;
        return { content: [{ type: 'text' as const, text: `Started ${r.url ?? r.key}. It reads the brief and reports there.` }] };
      } catch (e: any) {
        return fail(`could not start the thread: ${e?.message ?? e}`);
      }
    },
    { alwaysLoad: true },
  );
}
