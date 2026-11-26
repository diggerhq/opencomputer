// Who may drive a Slack thread, as Slack shows it (copied from computer/access.ts and
// access-views.ts, without `drivers`: a session's writers are Org's now, changed by
// `thread.writers`). Pure: the commands as typed, the texts, and the `ac:` buttons.

/** Held context: text cut to this when stored, the newest rows read, rows older than this deleted. */
export const CONTEXT_MAX_CHARS = 4_000;
export const CONTEXT_MAX_ROWS = 40;
export const CONTEXT_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/**
 * The text a `!` command is parsed from: without one wrapping pair of backticks (or a code fence),
 * because Slack keeps the code formatting of a command copied from a web page.
 */
export function commandText(text: string): string {
  const trimmed = text.trim();
  const code = /^```\s*([\s\S]*?)\s*```$/.exec(trimmed) ?? /^`([^`]+)`$/.exec(trimmed);
  return code?.[1]?.trim() ?? trimmed;
}

/** The first word after `!`, lower-cased; undefined when `text` is not a command. */
export function commandWord(text: string): string | undefined {
  const t = text.trim();
  if (!t.startsWith("!") || t.startsWith("!!")) return undefined;
  return (t.slice(1).trim().split(/\s+/)[0] ?? "").toLowerCase();
}

/** What follows the command word. */
export function commandArgs(text: string): string {
  return text.trim().slice(1).trim().replace(/^\S+\s*/, "");
}

/** The commands that are calls (spec 40.11 step 3); every other `!word` is a turn the runner reads. */
export type SlackCommand = "secret" | "var" | "claude" | "codex" | "link" | "access" | "stop";
const COMMANDS: Record<string, SlackCommand> = {
  secret: "secret",
  secrets: "secret",
  var: "var",
  vars: "var",
  variable: "var",
  variables: "var",
  claude: "claude",
  codex: "codex",
  link: "link",
  access: "access",
  stop: "stop",
  esc: "stop",
};

export function slackCommand(word: string | undefined): SlackCommand | undefined {
  return word !== undefined && Object.hasOwn(COMMANDS, word) ? COMMANDS[word] : undefined;
}

/** `!access …` as typed: `open` → `members`, `owner` → nobody else, `@a @b` → those Slack ids. */
export type AccessCommand =
  | { kind: "show" }
  | { kind: "set"; people: "members" | string[] }
  | { kind: "add"; ids: string[] }
  | { kind: "remove"; ids: string[] }
  | { kind: "usage" };

const MENTION = /@([UW][A-Z0-9]{6,})/g;
const MENTION_ONLY = /^@[UW][A-Z0-9]{6,}$/;

export function mentionedIds(text: string): string[] {
  return [...new Set([...text.matchAll(MENTION)].map((m) => m[1] ?? ""))];
}

/** Decoded text: Slack's `<@U123>` read as `@U123`. */
export function parseAccessCommand(text: string): AccessCommand {
  const [word, ...args] = text.replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, "@$1").trim().slice(1).trim().split(/\s+/);
  if (word?.toLowerCase() !== "access") return { kind: "usage" };
  const first = (args[0] ?? "").toLowerCase();
  if (!first) return { kind: "show" };
  if (args.length === 1 && first === "open") return { kind: "set", people: "members" };
  if (args.length === 1 && first === "owner") return { kind: "set", people: [] };
  const people = (tokens: string[]) => (tokens.length && tokens.every((t) => MENTION_ONLY.test(t)) ? mentionedIds(tokens.join(" ")) : undefined);
  if (first === "add" || first === "remove") {
    const ids = people(args.slice(1));
    return ids ? { kind: first, ids } : { kind: "usage" };
  }
  const ids = people(args);
  return ids ? { kind: "set", people: ids } : { kind: "usage" };
}

export const ACCESS_USAGE = [
  "`!access`: who can drive this session",
  "`!access open`: everyone in this thread can drive",
  "`!access owner`: only the owner can drive",
  "`!access @a @b`: the owner and these people can drive",
  "`!access add @a @b` / `!access remove @a`: change who is named",
].join("\n");

// ------------------------------------------------------------------ strings

export const mention = (id: string) => `<@${id}>`;

export function joinPeople(names: readonly string[]): string {
  if (names.length < 2) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** A person as Slack shows them: a mention for a Slack id, else the subject as is. */
const shown = (who: string) => (/^[UW][A-Z0-9]+$/.test(who) ? mention(who) : who);

export const requestText = (owner: string, requester: string) => `${shown(owner)}, ${mention(requester)} wants to drive this session.`;
export const requestSentText = (owner: string) => `${shown(owner)} decides who can drive this session and has been asked. Your message runs if they allow it.`;
export const ownerDecidesText = (owner: string) => `${shown(owner)} decides who can drive this session.`;
export const grantedText = (by: string, requester: string) => `${mention(by)} let ${mention(requester)} drive this session.`;
export const declinedText = (requester: string) => `${mention(requester)} asked to drive · not now`;
export const onlyGrantorAnswersText = (owner: string) => `Only ${shown(owner)} or an admin can answer this.`;
export const onlyGrantorChangesText = (owner: string) => `Only ${shown(owner)} or an admin can change who drives this session.`;
export const noSessionText = () => "There is no session in this thread.";
export const notAskedText = () => "This is waiting on someone else.";
export const listIsOpenText = () => "Everyone in this thread can drive already; `!access @a @b` names who can.";

/** The state line: `writers` as Slack ids (or subjects), the owner left out. */
export function stateText(owner: string, writers: "members" | string[]): string {
  const who =
    writers === "members"
      ? "Everyone in this thread can drive."
      : writers.length
        ? `${joinPeople(["They", ...writers.map(shown)])} can drive.`
        : "Only they can drive.";
  return `Runs as ${shown(owner)}. ${who}`;
}

// ------------------------------------------------------------------ Computer's interactions

/** Model access's buttons (computer/model-access.ts). */
const MODEL_ACTIONS = new Set(["mc:connect", "md:disconnect", "cx:connect", "cx:disconnect"]);

/** Whether an interaction's state is Computer's: any modal's submission, and the secret, connection, variable and subscription buttons. */
export function computerHeld(interaction: { type?: string; actions?: Array<{ action_id?: string }> }): boolean {
  if (interaction.type === "view_submission") return true;
  const actionId = interaction.actions?.[0]?.action_id ?? "";
  return /^(s|cn|v):/.test(actionId) || MODEL_ACTIONS.has(actionId);
}

export const sessionGoneText = () => "That session is gone; nothing was set.";

// ------------------------------------------------------------------ the request's buttons

export type AccessVerb = "allow" | "deny";

function toBase64url(s: string): string {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64url(s: string): string | undefined {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

export function encodeAccessId(sessionKey: string, verb: AccessVerb, userId: string): string {
  return `ac:${toBase64url(sessionKey)}:${verb}:${userId}`;
}

export function decodeAccessId(actionId: string): { sessionKey: string; verb: AccessVerb; userId: string } | undefined {
  const m = actionId.match(/^ac:([A-Za-z0-9_-]+):(allow|deny):([A-Z0-9]+)$/);
  const sessionKey = m?.[1] && fromBase64url(m[1]);
  if (!m || !sessionKey) return undefined;
  return { sessionKey, verb: m[2] as AccessVerb, userId: m[3]! };
}

export interface AccessPost {
  text: string;
  blocks: unknown[];
}

const section = (text: string) => ({ type: "section", text: { type: "mrkdwn", text } });
const button = (label: string, actionId: string, value: string, style?: "primary") => ({
  type: "button",
  text: { type: "plain_text", text: label },
  action_id: actionId,
  value,
  ...(style ? { style } : {}),
});

/** The request in the thread, with Allow and Not now. */
export function requestPost(sessionKey: string, owner: string, requester: string): AccessPost {
  const text = requestText(owner, requester);
  return {
    text,
    blocks: [
      section(text),
      { type: "actions", elements: [button("Allow", encodeAccessId(sessionKey, "allow", requester), "allow", "primary"), button("Not now", encodeAccessId(sessionKey, "deny", requester), "deny")] },
    ],
  };
}

/** The request after an answer: one context block. */
export function answeredPost(text: string): AccessPost {
  return { text, blocks: [{ type: "context", elements: [{ type: "mrkdwn", text }] }] };
}
