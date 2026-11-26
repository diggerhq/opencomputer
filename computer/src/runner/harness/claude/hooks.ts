// Claude Code's compaction hooks (work 068 §1): what it is told to keep, and
// the summary's length on the way out, which the harness reports as a
// `compaction` record (compaction.ts reads it); and the workspace
// instructions a subagent gets (workspace-prompt.ts).

import type { HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk';
import { subagentWorkspaceHook } from './workspace-prompt.js';

/**
 * Calvin's keep-list, sent as the compaction's custom instructions through a
 * `PreCompact` hook's `systemMessage` (Claude Code appends what PreCompact
 * hooks print to the instructions; verified with a marker word).
 */
export const KEEP_LIST = [
  'This conversation is a Slack thread where people direct the work; the summary is all later turns will have. Keep, in their own words where short:',
  '- the task as the person asked it, and any change to it since;',
  '- every decision made and its reason;',
  '- the file paths created, edited or relied on;',
  '- branch names, commits, and pull request and issue links;',
  '- open questions, and what is waiting on whom;',
  '- preferences and constraints the person stated (style, scope, what not to do).',
  'Drop tool output that can be read again.',
].join('\n');

/** The harness's hooks: the compaction's keep-list in, the summary's length out; a subagent's workspace instructions (workspace-prompt.ts). */
export function compactionHooks(onSummary: (chars: number) => void): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    SubagentStart: [subagentWorkspaceHook()],
    PreCompact: [{ hooks: [async () => ({ systemMessage: KEEP_LIST })] }],
    PostCompact: [
      {
        hooks: [
          async (input) => {
            if (input.hook_event_name === 'PostCompact') onSummary(input.compact_summary?.length ?? 0);
            return {};
          },
        ],
      },
    ],
  };
}
