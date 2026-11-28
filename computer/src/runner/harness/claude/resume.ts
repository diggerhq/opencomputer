// Whether a Claude conversation can be resumed here, asked before the harness starts.
//
// Invariants:
// - Claude Code exits on a `resume` it has no transcript for, at every message; the id stays
//   reported, so nothing would replace it. A session whose id names no transcript in this home
//   (a Codex thread's id after a change of harness, a home made anew) starts a new conversation.
// - Only a transcript known to be absent starts over. A lookup that fails says nothing about the
//   transcript, so the id is kept: a conversation is never dropped on a doubt.

import { getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
import { log } from '../../../log.js';

type Lookup = (sdkSessionId: string, o: { dir: string }) => Promise<unknown>;

/** `sdkSessionId` when its transcript is under `cwd`'s project (or could not be looked up); undefined when there is none. */
export async function resumable(sdkSessionId: string | undefined, cwd: string, lookup: Lookup = getSessionInfo): Promise<string | undefined> {
  if (!sdkSessionId) return undefined;
  try {
    if (await lookup(sdkSessionId, { dir: cwd })) return sdkSessionId;
  } catch (e) {
    log.warn(`claude: session ${sdkSessionId} not looked up (${(e as Error).message}); resuming it`);
    return sdkSessionId;
  }
  log.warn(`claude: session ${sdkSessionId} has no transcript here; starting a new conversation`);
  return undefined;
}
