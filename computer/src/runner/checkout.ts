// checkout_repo (work 056): a session checks out one of the workspace's
// repositories when a task needs it, instead of every repository being cloned
// before the session starts. The runner offers it as a tool of the in-process
// `calvin` MCP server (see session.ts); the request goes runner → host, which
// clones if needed and adds a worktree on the session's branch
// (workspaces/fork.ts checkoutRepos). The fork's AGENTS.md lists what exists.

import { tool } from './tool.js';
import { z } from 'zod';
import type { CheckoutResult } from '../protocol.js';

/** Plain text for the model: one line per repository. Exported for the test. */
export function checkoutText(results: CheckoutResult[]): string {
  return results
    .map((r) =>
      r.error
        ? `${r.name}: not checked out: ${r.error}`
        : `${r.name}: checked out in ./${r.dir} on ${r.branch}, from ${r.from} (${r.base.slice(0, 8)})` +
          (r.fetchError ? `; the fetch failed (${r.fetchError}), so it starts from the cached ${r.from}` : ''),
    )
    .join('\n');
}

/** The tool; `checkout` asks the host. */
export function checkoutTool(checkout: (repos: string[]) => Promise<CheckoutResult[]>) {
  const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
  return tool(
    'checkout_repo',
    'Check out repositories from this workspace\'s list (the "Repositories in this workspace" section of AGENTS.md) ' +
      'into this session\'s directory, each as a git worktree on this session\'s branch, from the latest default branch. ' +
      'The first checkout of a repository clones it: seconds for most, longer for very large ones. Check out only what ' +
      'the task needs. Already checked-out repositories are returned as they are.',
    {
      repos: z.array(z.string().min(1)).min(1).max(10).describe('Repository names from the list, or owner/name'),
    },
    async ({ repos }) => {
      try {
        const results = await checkout(repos);
        const text = checkoutText(results);
        return results.every((r) => r.error) ? fail(text) : { content: [{ type: 'text' as const, text }] };
      } catch (e) {
        return fail(`could not check out: ${e instanceof Error ? e.message : e}`);
      }
    },
    { alwaysLoad: true },
  );
}
