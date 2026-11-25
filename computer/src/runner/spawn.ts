// start_thread (work 047, then work 118 section 41): a session starts another
// thread to run work in parallel. It is `POST /sessions` on the public API
// with the session's own key (cloud.ts), so the new thread is owned by the
// same person and, with `track`, starts in this session's track.
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
import { keyOf, refusal, said, type Work } from './work.js';

export const START_THREAD_TOOL = 'mcp__calvin__start_thread';
/** Bounds fan-out per runner, which matters in bypass mode where nobody approves each start. */
const MAX_STARTS = 8;

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

/** The track this session is in: its own for a track's session, else what its row says. */
export async function trackOf(w: Work): Promise<string | undefined> {
  const me = w.session();
  if (me.role?.name === 'track') return me.role.trackId;
  const r = await w.api.call('GET', `/sessions/${me.id}`);
  const id = r?.session?.trackId;
  return typeof id === 'string' ? id : undefined;
}

export function startThreadTool(cwd: () => string, w: Work) {
  let started = 0;
  return tool(
    'start_thread',
    'Start a new thread that works on a task in parallel, as the same person, in its own fresh workspace fork. ' +
      'For anything beyond a one-line task, put what the thread needs (goal, constraints, sources, done criteria, where to report) in a ' +
      'Markdown brief in the knowledge repository work doc that owns the topic, commit and push it to the default branch, and pass its path: ' +
      'the new thread gets the task and a link to the brief, and claims and reports there. `track: true` starts it in the track this ' +
      'session is in. Returns the new thread\'s id, which read_thread reads.',
    {
      task: z.string().min(3).max(150).describe('One line, imperative: what the new thread should do'),
      brief: z.string().optional().describe('Workspace-relative path of the brief, with an optional anchor, e.g. docs/work/047-x.md#item-2'),
      track: z.boolean().optional().describe('Start it in this session\'s track'),
    },
    async ({ task, brief, track }, call) => {
      if (started >= MAX_STARTS) return said(`this session already started ${MAX_STARTS} threads; ask the person before starting more`, true);
      if (/\n/.test(task.trim())) return said('task must be one line; the brief holds the rest', true);
      let briefUrl: string | undefined;
      try {
        if (brief?.trim()) briefUrl = (await checkBrief(cwd(), brief.trim())) ?? brief.trim();
        const trackId = track ? await trackOf(w) : undefined;
        if (track && !trackId) return said('this session is in no track; start the thread without `track`', true);
        const input = briefUrl ? `Task: ${task.trim()}\nBrief: ${brief!.trim()} (${briefUrl})\nRead the brief first; claim and report there.` : task.trim();
        const r = await w.api.call('POST', '/sessions', { body: { input, ...(trackId ? { trackId } : {}) }, key: keyOf(call) });
        started++;
        return said(`Started ${r?.session?.id ?? 'the thread'}${trackId ? ' in the track' : ''}.${briefUrl ? ' It reads the brief and reports there.' : ''}`);
      } catch (e) {
        return said(`could not start the thread: ${refusal(e)}`, true);
      }
    },
    { alwaysLoad: true },
  );
}
