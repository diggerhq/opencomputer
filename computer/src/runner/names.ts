// Who is speaking and where, by name (work 048 U13). A person's message reaches
// the model after a header naming the sender and the conversation, and the
// bare `@U…` mentions in its text (the gateway decodes `<@U…>` to `@U…`) carry
// the person's name. Names come from SlackThread's cached lookups; a lookup
// that fails or is slow leaves the id and never holds the message. A message
// typed outside Slack (the app, opc, an API client) gets the same kind of
// header from the actor its write carried, so the model always knows who is
// speaking and from where.
//
// Invariants: the Slack header is part of the message the event log records
// (the app strips it); the header of a message from outside Slack is not, it
// only reaches the model. A harness's own command (`/compact`) gets none.

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

/** How the model reads where a message was typed, by its actor's `via`; a platform's or an agent's own message has no header. */
const TYPED_IN: Record<string, string> = { dashboard: 'App', app: 'App', opc: 'opc', api: 'API' };

/** A name as one short stretch of a header line: it cannot close the bracket or start a line of its own. */
const label = (name: string) => name.replace(/[\[\]\r\n\u2028\u2029]/g, ' ').trim().slice(0, 80);

/** `[App: from Sam]` and the text, for a message a person typed outside Slack; `text` as it is otherwise. */
export function typedIn(text: string, actor?: { id: string; name?: string | null; via: string }): string {
  const where = actor && TYPED_IN[actor.via];
  if (!where || text.startsWith('/')) return text;
  // An actor known only by its id (a key, a member whose name the write did not carry) is not named.
  const who = actor.name && actor.name !== actor.id ? `: from ${label(actor.name)}` : '';
  return `[${where}${who}]\n${text}`;
}
