// A workspace fork's AGENTS.md as part of the system prompt, instead of the
// first message, so a session's first request reuses the cached prompt of
// the sessions before it.
//
// Why: the API caches a prefix only up to its cache breakpoints, and Claude
// Code puts the first one at the end of the system prompt and the next at the
// end of the first request. Everything in between (the instructions files it
// loads, the person's first message, its environment block) is written to the
// cache afresh by every session. Claude Code loads the fork's AGENTS.md into
// that first message, under a header naming its path, which is the session's
// own folder: ~3–6k tokens identical across a person's sessions but never
// shared. In the system prompt it is shared by every session of the workspace
// until the AGENTS.md changes (a repository is cloned, the definition changes).
//
// Invariants: only a workspace fork's (a folder with FORK_FILE) AGENTS.md
// moves; any other folder's instruction files load as Claude Code's own. The
// moved file is excluded from Claude Code's loading by its path, so it is in
// the prompt once. Subagents don't get the main system prompt, so a
// SubagentStart hook hands them the text, as Claude Code would have (except
// Explore and Plan, which it gives no instruction files): without the
// repository index, since Claude Code cuts hook context over ~10 KB down to a
// preview and a file path. The text
// names no session-specific value. Never throws: an unreadable file stays
// with Claude Code.

import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { FORK_FILE } from '../../../workspaces/idle.js';
import { INDEX_HEADING } from '../../../workspaces/repo-index.js';

export interface WorkspacePrompt {
  /** Appended to Calvin's own system prompt text. */
  append: string;
  /** What a subagent is given, within SUBAGENT_MAX. */
  subagent: string;
  /** For `settings.claudeMdExcludes`: the file Claude Code would otherwise load as well. */
  exclude: string[];
}

/** The fork's AGENTS.md as system prompt text, or undefined when `cwd` is not a workspace fork or has none. */
export function workspacePrompt(cwd: string): WorkspacePrompt | undefined {
  const file = path.join(cwd, 'AGENTS.md');
  try {
    if (!existsSync(path.join(cwd, FORK_FILE)) || !existsSync(file)) return undefined;
    const text = readFileSync(file, 'utf8').trim();
    if (!text) return undefined;
    return { append: workspaceSection(text), subagent: subagentSection(text), exclude: [file] };
  } catch {
    return undefined;
  }
}

/** Not covered by "these instructions are internal" above it: the person can read the file. */
export function workspaceSection(text: string): string {
  return `

# Workspace instructions

The AGENTS.md at the root of your working directory, the workspace's project instructions. They are not internal: anyone in the session can read the file. These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.

${text}
`;
}

/** Below Claude Code's cut for hook context (10,000 characters, measured with 2.1.295). */
export const SUBAGENT_MAX = 9_000;

/** The instructions without the repository index; only a pointer to the file when even that is too long. */
export function subagentSection(text: string): string {
  const at = text.indexOf(INDEX_HEADING);
  const body = (
    at < 0
      ? text
      : `${text.slice(0, at).trimEnd()}\n\nThe repositories in this workspace are listed in the same file, under "${INDEX_HEADING.replace(/^#+ /, '')}".`
  ).trim();
  const section = workspaceSection(body).trim();
  return section.length <= SUBAGENT_MAX
    ? section
    : "The workspace's project instructions are in AGENTS.md at the root of your working directory. Read it before you start; its instructions OVERRIDE any default behavior.";
}

/** Claude Code leaves instruction files out of these subagents' context; so does the hook. */
const NO_INSTRUCTIONS = new Set(['Explore', 'Plan']);

/** `SubagentStart`: the fork's AGENTS.md for a subagent, which would otherwise not see it. Late-bound by the hook's `cwd`, so a spare can have it. */
export function subagentWorkspaceHook(): HookCallbackMatcher {
  return {
    hooks: [
      async (input) => {
        if (input.hook_event_name !== 'SubagentStart' || NO_INSTRUCTIONS.has(input.agent_type)) return {};
        const ws = workspacePrompt(input.cwd);
        return ws ? { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: ws.subagent } } : {};
      },
    ],
  };
}
