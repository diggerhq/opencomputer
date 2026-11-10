// What every harness's session naming shares (work 093): when to name a
// session, what the model is asked and reads, and what its reply becomes.
// The asking is each harness's own (claude/title.ts, codex/title.ts), on the
// session's credentials.

/** Messages from people before a session is named; fewer and the opening message is name enough. */
export const TITLE_AFTER = 3;
const MAX_CHARS = 4000;
export const TITLE_PROMPT =
  'You name conversations between people and a coding agent. Reply with a title for the conversation below: ' +
  'at most 6 words, plain text, sentence case, no quotes, no trailing period, no names of people or of the agent. ' +
  'Say what the work is about, e.g. "Fix login redirect loop" or "Compare hosting costs".';

/** A session's title after a turn: `done` once it is final, so the caller can stop asking. */
export interface Naming {
  title?: string;
  done: boolean;
}

/** One message of the main conversation: a person's, or the agent's. */
export interface Said {
  person: boolean;
  text: string;
}

/** What the model reads: who said what, in order, cut at `MAX_CHARS`; `said` counts the people's messages. */
export function conversation(messages: Said[]): { said: number; text: string } {
  const lines: string[] = [];
  let said = 0;
  for (const m of messages) {
    const text = m.text.trim();
    if (!text) continue;
    if (m.person) said++;
    lines.push(`${m.person ? 'Person' : 'Agent'}: ${text}`);
  }
  return { said, text: lines.join('\n\n').slice(0, MAX_CHARS) };
}

/** The model's reply as a title: its first line, unquoted, without a trailing period; empty if unusable. */
export function cleanTitle(reply: string): string {
  const line = reply.trim().split('\n')[0]!.trim();
  const t = line.replace(/^title:\s*/i, '').replace(/^["'`*]+|["'`*]+$/g, '').replace(/\.$/, '').trim();
  return t.length > 80 ? '' : t;
}
