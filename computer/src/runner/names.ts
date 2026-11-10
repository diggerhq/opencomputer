// Who is speaking and where, by name (work 048 U13). A person's message reaches
// the model after a header naming the sender and the conversation, and the
// bare `@U…` mentions in its text (the gateway decodes `<@U…>` to `@U…`) carry
// the person's name. Names come from SlackThread's cached lookups; a lookup
// that fails or is slow leaves the id and never holds the message.

export interface Names {
  /** A person's Slack name, or undefined when it can't be had. */
  nameOf(id: string): Promise<string | undefined>;
  /** The conversation: `#name`, `a DM`, `a group DM`, or `channel C…`. */
  where(): Promise<string>;
}

/** A decoded user mention; not one already written as `<@U…>`. */
const MENTION = /(?<![\w<])@([UW][A-Z0-9]{6,})\b/g;
/** Distinct people looked up per message; more keep their ids. */
const MAX_LOOKUPS = 20;

/** How the model sees a person: name plus the mention it can write to notify them. */
export const person = (id: string, name?: string) => (name ? `${name} (<@${id}>)` : `<@${id}>`);

/** Whether a message mentions the bot; `inline`: only mid-message, maybe not addressed to it. */
export type Mentioned = boolean | 'inline';

const MENTIONS: Record<string, string> = { true: 'mentions you', false: 'does not mention you', inline: 'mentions you mid-message' };

/** `[Slack: from Sam (<@U…>) in #eng, mentions you]` and the text with mentions named. */
export async function labelled(names: Names, text: string, from: string, mentioned: Mentioned): Promise<string> {
  const ids = [...new Set([from, ...[...text.matchAll(MENTION)].map((m) => m[1])])].slice(0, MAX_LOOKUPS);
  const [where, ...found] = await Promise.all([names.where(), ...ids.map((id) => names.nameOf(id))]);
  const known = new Map(ids.map((id, i) => [id, found[i]]));
  const body = text.replace(MENTION, (_, id: string) => (known.get(id) ? `@${person(id, known.get(id))}` : `<@${id}>`));
  return `[Slack: from ${person(from, known.get(from))} in ${where}, ${MENTIONS[String(mentioned)]}]\n${body}`;
}

/** What `conversations.info` says about a conversation, as the model reads it. */
export function describeChannel(id: string, ch?: { name?: string; is_im?: boolean; is_mpim?: boolean }): string {
  if (ch?.is_im) return 'a DM';
  if (ch?.is_mpim) return 'a group DM';
  return ch?.name ? `#${ch.name}` : `channel ${id}`;
}
