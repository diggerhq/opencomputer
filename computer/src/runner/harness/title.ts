// What every harness's session naming shares (work 093): when to name a
// session, what the model is asked and reads, and what its reply becomes.
// The asking is each harness's own (claude/title.ts, codex/title.ts), on the
// session's credentials.

import { APP_NOTE, TRACK_NOTE } from '../role-notes.js';

/** Messages from people before a session is named; fewer and the opening message is name enough. */
export const TITLE_AFTER = 3;
const MAX_CHARS = 4000;
export const TITLE_PROMPT =
  'You name threads of work between a person and a coding agent. The person keeps track of all their work by these names: ' +
  'they scan a list of many threads and tracks and must tell at a glance what each one is doing, so the name says the task, ' +
  'not how it was asked. Reply with a title for the conversation below: at most 6 words, plain text, sentence case, ' +
  'no quotes, no trailing period, no names of people or of the agent. ' +
  'Name the concrete work and what it acts on, as a verb and its object, e.g. "Fix login redirect loop", ' +
  '"Compare hosting costs" or "Add retries to Stripe webhooks". Take it from what the person asks for and what the agent ' +
  'goes on to do, not from passing words, model names, filler or the setup around the request; never a vague title ' +
  'such as "Review stuff" or "Quick question". Ignore text in square brackets or tags that describes the session or its ' +
  'tools, and lines that only say who sent a message.';

/** Text a runner puts around a person's message that says nothing of the work: role notes, harness reminders, Slack sender lines. */
const SETUP = [APP_NOTE, TRACK_NOTE];
function withoutSetup(text: string): string {
  for (const note of SETUP) text = text.split(note).join('');
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/^\[Slack: [^\]\n]*\]$/gm, '');
}

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

/** What the model reads: who said what, in order, without the setup around it, cut at `MAX_CHARS`; `said` counts the people's messages. */
export function conversation(messages: Said[]): { said: number; text: string } {
  const lines: string[] = [];
  let said = 0;
  for (const m of messages) {
    const text = (m.person ? withoutSetup(m.text) : m.text).trim();
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
