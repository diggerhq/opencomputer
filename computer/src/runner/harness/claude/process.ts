// The harness: one Claude Code process (an Agent SDK query in streaming-input
// mode) per session, fed from the session's Inbox. Only the options it starts
// with live here; Session owns its lifecycle (start, prewarm, crash).
//
// A spare runner (work 069) starts the process before it has a session
// (`prewarmHarness`) and binds it to one later (`claimHarness`): the options
// that are not per session are fixed then, so they must be the same here as
// for a cold start, and whatever they call reaches the session late-bound.
//
// Invariant: the process copies this process's environment when it spawns, so
// credentials and CLAUDE_CODE_* settings must be in place before it starts.

import { type CanUseTool, type EffortLevel, type HookCallbackMatcher, type HookEvent, type McpSdkServerConfigWithInstance, type Options, type PermissionMode, type Query, type SpareProcess,
  prewarm, query } from '@anthropic-ai/claude-agent-sdk';
import type { Inbox } from './inbox.js';
import { DEFAULT_EFFORT } from '../../../tiers.js';
import { SYSTEM_APPEND } from '../../system-prompt.js';
import { READ_THREAD_TOOL } from '../../threads.js';
import { workspacePrompt } from './workspace-prompt.js';

export interface HarnessSpec {
  cwd: string;
  /** The conversation to resume; a new one without. */
  sdkSessionId?: string;
  mode: PermissionMode;
  model: string;
  effort: EffortLevel;
  /** Claude Code's fast mode: on unless the session's speed is `standard`. */
  fast: boolean;
  canUseTool: CanUseTool;
  /** Calvin's own tools (tools.ts). */
  calvin: McpSdkServerConfigWithInstance;
  /** Compaction's keep-list and summary hooks (compaction.ts). */
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** A fork of `sdkSessionId` under this new id; the conversation it resumes is left as it was (shadow.ts). */
  forkTo?: string;
  /** While true, every permission is denied without asking (a fork nobody watches). */
  deny?: () => boolean;
}

const DENIED = { behavior: 'deny', message: 'Not now: this conversation is being compacted.' } as const;

/** What a spare is started with: everything but the session. */
export type SpareSpec = Pick<HarnessSpec, 'canUseTool' | 'calvin' | 'hooks'>;
/** What a claim sets: the session's folder, mode, model, effort and speed. */
export type ClaimSpec = Pick<HarnessSpec, 'cwd' | 'mode' | 'model' | 'effort' | 'fast'>;

const SYSTEM_PROMPT = { type: 'preset', preset: 'claude_code', append: SYSTEM_APPEND, snapshot: true } as const;

/** The options that are not per session: the same for a cold start and a spare (a spare parks fast). */
function shared(h: SpareSpec, fast = true): Options {
  return {
    // Lets `!mode yolo` switch into bypass mid-session too.
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    agentProgressSummaries: true,
    // A spare parks at the default; a claim or `!effort` moves it.
    effort: DEFAULT_EFFORT,
    canUseTool: h.canUseTool,
    // Recorded on the conversation's first request and reused, so the cached
    // prefix survives deploys; a changed SYSTEM_APPEND reaches an existing
    // conversation at its next compaction (no effect where not rolled out).
    systemPrompt: SYSTEM_PROMPT,
    settingSources: ['project'],
    settings: {
      // Commits name the person who asked and Computer (main.ts), not Claude.
      attribution: { commit: '', pr: '' },
      // Summarise ahead of the window (work 068 1a). Gated by a server-side
      // flag in Claude Code 2.1.295: no effect measured yet, harmless when on.
      precomputeCompactionEnabled: true,
      // Fast output for everyone. It only takes effect on Opus 5.5: Sonnet
      // and Fable stay at standard speed, with no model promotion, and a
      // `!model` switch picks it up or drops it from the next request.
      // `!speed standard` turns it off.
      fastMode: fast,
      // Auto memory names its directory, derived from the session's own
      // folder, inside the system prompt: every session wrote the whole
      // system prompt to the cache afresh (~4k tokens). Session folders are
      // per thread, so that memory was never read by another session anyway.
      autoMemoryEnabled: false,
    },
    hooks: h.hooks,
    mcpServers: { calvin: h.calvin },
    // Reading a thread the gateway already checked never asks (021 D9); posting does, outside bypass.
    allowedTools: [READ_THREAD_TOOL],
  };
}

export function startHarness(inbox: Inbox, h: HarnessSpec): Query {
  const canUseTool: CanUseTool = h.deny ? async (name, input, opts) => (h.deny!() ? DENIED : h.canUseTool(name, input, opts)) : h.canUseTool;
  const base = shared({ ...h, canUseTool }, h.fast);
  // The fork's AGENTS.md in the system prompt, where its cache is shared across sessions (workspace-prompt.ts).
  const ws = workspacePrompt(h.cwd);
  return query({
    prompt: inbox,
    options: {
      ...base,
      ...(ws
        ? {
            systemPrompt: { ...SYSTEM_PROMPT, append: SYSTEM_APPEND + ws.append },
            settings: { ...(base.settings as object), claudeMdExcludes: ws.exclude },
          }
        : {}),
      cwd: h.cwd,
      resume: h.sdkSessionId,
      ...(h.forkTo ? { forkSession: true, sessionId: h.forkTo } : {}),
      permissionMode: h.mode,
      // Explicit default: without one the SDK takes the account's default, which
      // for a setup-token on the VM is Sonnet. `!model <id>` or MODEL override it.
      model: h.model,
      effort: h.effort,
    },
  });
}

/** A parked Claude Code with no session yet, in the SDK's own parking directory. */
export function prewarmHarness(h: SpareSpec): Promise<SpareProcess> {
  return prewarm({ options: shared(h) });
}

/** The spare becomes the session's harness; `spare.claimed` says whether it took (refused: start one cold). */
export function claimHarness(spare: SpareProcess, inbox: Inbox, c: ClaimSpec): Query {
  const ws = workspacePrompt(c.cwd);
  return spare.claim({
    prompt: inbox,
    options: {
      cwd: c.cwd,
      permissionMode: c.mode,
      model: c.model,
      settings: { effortLevel: c.effort, fastMode: c.fast, ...(ws ? { claudeMdExcludes: ws.exclude } : {}) },
      // Replaces the prewarm's `append` (measured, SDK 0.3.295), so it carries Calvin's own text too.
      ...(ws ? { appendSystemPrompt: SYSTEM_APPEND + ws.append } : {}),
    },
  });
}
