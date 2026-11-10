// A session's display name, so the Slack sidebar shows what a thread is about
// instead of its opening message (work 093). Two stages:
//
// 1. From the first turn: the title Claude Code writes itself from the first
//    prompt (its `ai-title`, which the SDK reports as `customTitle`). Free.
// 2. Once people have sent `TITLE_AFTER` messages: a title a model writes from
//    the conversation so far, kept in the transcript as a custom title and
//    marked with the `TITLED` tag, so a runner that restarts does not ask again.
//
// Invariants:
// - It runs after a turn, off the turn's path, and never fails: no title is an
//   answer (the one before stays).
// - The call is a one-shot Claude Code with no tools, no settings and no
//   transcript of its own, on the session's credentials (it inherits this
//   process's environment, as the harness does).

import { getSessionInfo, getSessionMessages, query, renameSession, type SessionMessage, tagSession } from '@anthropic-ai/claude-agent-sdk';
import { log } from '../../../log.js';
import { cleanTitle, conversation, type Naming, TITLE_AFTER, TITLE_PROMPT } from '../title.js';

const MODEL = 'haiku';
/** The session tag that says stage 2 is done. */
const TITLED = 'calvin-titled';

type Block = { type?: string; text?: string };

/** The text of a message: a string, or its text blocks; tool results and tool calls are not conversation. */
export function textOf(m: SessionMessage): string {
  const content = (m.message as { content?: string | Block[] } | undefined)?.content;
  if (typeof content === 'string') return content;
  return (content ?? []).filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n');
}

/** What the model reads: the main conversation only (no subagents, no tool results). */
export function transcript(messages: SessionMessage[]): { said: number; text: string } {
  const main = messages.filter((m) => !m.parent_tool_use_id && (m.type === 'user' || m.type === 'assistant'));
  return conversation(main.map((m) => ({ person: m.type === 'user', text: textOf(m) })));
}

async function ask(convo: string): Promise<string> {
  let reply = '';
  for await (const m of query({
    prompt: convo,
    options: {
      model: MODEL,
      systemPrompt: TITLE_PROMPT,
      tools: [],
      settingSources: [],
      persistSession: false,
      maxTurns: 1,
      thinking: { type: 'disabled' },
    },
  })) {
    if (m.type === 'result' && m.subtype === 'success') reply = m.result;
  }
  return reply;
}

/**
 * The session's title after this turn: Claude Code's own until the
 * conversation is long enough, then the model's, written once; `done` once
 * that has happened, so the caller can stop asking. Undefined on any failure.
 */
export async function nameSession(sdkSessionId: string, cwd: string): Promise<Naming | undefined> {
  try {
    const info = await getSessionInfo(sdkSessionId, { dir: cwd });
    if (!info) return undefined;
    if (info.tag === TITLED) return { done: true };
    const own = info.customTitle?.trim() || undefined;
    const { said, text } = transcript(await getSessionMessages(sdkSessionId, { dir: cwd }));
    if (said < TITLE_AFTER) return { title: own, done: false };
    const title = cleanTitle(await ask(text));
    if (!title) return { title: own, done: false };
    await renameSession(sdkSessionId, title, { dir: cwd });
    await tagSession(sdkSessionId, TITLED, { dir: cwd });
    return { title, done: true };
  } catch (e) {
    log.warn(`naming the session failed: ${(e as Error).message}`);
    return undefined;
  }
}
