// A message sent while prompts are open (work 084 A6). An API steer declines
// every open prompt of its session: each ask closes `declined`, closed by the
// sender, with the answer `{ message, messageSeq }`, and the first prompt
// carries the text to the agent. A Slack typed reply keeps what Slack always
// did: it closes the latest prompt, answering its one open question or
// declining it.
//
// Invariants:
// - the message is journaled (its `message.received`, naming the asks it
//   declines) before any ask closes, so every `messageSeq` points back;
// - a queued message never reaches here: only a steer meets an open prompt.

import type { Actor } from '../api/schema-objects.js';
import { type PromptHost, prompts } from './prompts.js';

/** A message sent while prompts were open, as the journal has it (work 084 A6). */
export interface Reply {
  /** Its `message.received` seq (0 when not journaled). */
  messageSeq: number;
  /** An API sender: every open prompt is declined, a lone question included. Absent: a Slack typed reply. */
  by?: Actor;
  /** Another declined prompt carries the text to the agent. */
  quiet?: boolean;
}

/**
 * A message sent while prompts are open closes them: an API steer (`from`) declines every
 * open prompt of the session, a Slack reply the latest one (or answers its one open question).
 * `record` journals the message with the asks it declines and returns its seq. False when none was open.
 */
export async function replyToPrompts(
  host: PromptHost,
  text: string,
  user: string,
  from: { actor: Actor } | undefined,
  record: (declined: string[]) => number,
): Promise<boolean> {
  const mine = [...prompts.values()].filter((p) => p.session === host);
  const latest = host.openPrompt ? prompts.get(host.openPrompt) : undefined;
  const targets = from ? mine : latest ? [latest] : [];
  if (!targets.length) return false;
  const declined = targets.filter((p) => from || !p.answersText?.()).flatMap((p) => (p.askId ? [p.askId] : []));
  const messageSeq = record(declined);
  for (const [i, p] of targets.entries()) await p.onText(text, user, { messageSeq, by: from?.actor, quiet: i > 0 });
  return true;
}
