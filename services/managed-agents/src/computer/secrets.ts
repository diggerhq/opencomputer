// Secrets people give their sessions on the computer (work 046, decision 5;
// ported from dash-cal src/secrets.ts), the parts that need no Durable
// Object: names, encryption, `!secret` parsing, and the Slack blocks and
// modal. secrets-store.ts stores them and drives the flow.
//
// No value is ever typed into a message: Slack keeps messages in history and
// sends them to the app in events. A modal's input comes back only to the app,
// in `view_submission`.
//
//   scope      applies to                          owner        set by
//   session    one thread's session                runner key   anyone in it
//   user       every session the person owns       user id      that person
//   workspace  every session of the organization   '*'         full members of its Slack workspace (not guests)
//
// The `workspace` scope keeps Calvin's protocol name; people see it as the
// organization's (one organization links one Slack workspace).
//
// A session gets the union; on a name clash the narrowest scope wins.
// Variables (`!var`, variables.ts) share the table: values that are not
// secret, flagged so the runner never redacts them. In one scope a name is
// either a secret or a variable.

import { base64UrlToBytes, bytesToBase64Url, seal, unseal } from "./crypto.js";
import type { SecretRequest, SecretScope, SessionSecret } from "./protocol.js";

export type { SecretRequest, SecretScope, SessionSecret };

export const SECRET_VIEW = "calvin_secret";
/** Slack's limit for a plain_text_input. */
export const INPUT_MAX = 3000;
/** Session secrets are deleted once their session has not been delivered to for this long. */
export const SESSION_TTL_MS = 30 * 24 * 3600_000;

const RANK: Record<SecretScope, number> = { workspace: 0, user: 1, session: 2 };

// ------------------------------------------------------------------ names

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Names that would change how the session itself runs (shell, Claude Code, git, the runner, interpreters) or where its traffic goes (proxies, CA bundles); any case. Same list as Calvin's. */
const RESERVED =
  /^(PATH|HOME|USER|LOGNAME|SHELL|PWD|OLDPWD|LANG|TERM|TMPDIR|IFS|ENV|BASH_ENV|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|RUNNER_SPEC|PS[1-4]|PROMPT_COMMAND|PYTHONSTARTUP|PYTHONPATH|PYTHONHOME|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|(HTTPS?|ALL|NO|FTP)_PROXY)$|^(SP_|CLAUDE|ANTHROPIC_|GIT_|LD_|DYLD_|BASH_FUNC)/i;

/** Names that change where tools fetch code or send traffic (work 095): package indexes, Java and pager hooks, config dirs. */
const REDIRECTING =
  /^(LESSOPEN|LESSCLOSE|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|PIP_INDEX_URL|PIP_EXTRA_INDEX_URL|UV_INDEX_URL|GOPROXY|DOCKER_HOST)$|^(XDG_|NPM_CONFIG_)/i;
/**
 * Base URLs: a secret `OPENAI_BASE_URL` would send every session's real key to whoever set it,
 * unseen. As a variable its value is shown to everyone (work 095).
 */
const BASE_URL = /(_BASE_URL|_API_BASE)$/i;

/** Why `name` cannot be a secret's (or, with `variable`, a variable's) name, or undefined when it can. */
export function secretNameProblem(name: string, opts: { variable?: boolean } = {}): string | undefined {
  if (!NAME.test(name)) return "use letters, digits and _, not starting with a digit (at most 64)";
  if (RESERVED.test(name) || REDIRECTING.test(name)) return `\`${name}\` is reserved: it would change how the session itself runs`;
  if (!opts.variable && BASE_URL.test(name)) return `\`${name}\` is a base URL: set it as a variable (\`!var\`), so everyone can see where it points`;
  return undefined;
}

// ------------------------------------------------------------------ encryption

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Scope, owner and name are the associated data: a row copied under another one does not decrypt. */
const context = (scope: SecretScope, owner: string, name: string) => `${scope}\0${owner}\0${name}`;

export function sealSecret(value: string, encodedKey: string | undefined, scope: SecretScope, owner: string, name: string): Promise<string> {
  return seal(value, encodedKey, "session-secret", context(scope, owner, name));
}

export function openSecret(sealed: string, encodedKey: string | undefined, scope: SecretScope, owner: string, name: string): Promise<string> {
  return unseal(sealed, encodedKey, "session-secret", context(scope, owner, name));
}

/** One secret per name, the narrowest scope winning. */
export function narrowest(list: SessionSecret[]): SessionSecret[] {
  const out = new Map<string, SessionSecret>();
  for (const s of [...list].sort((a, b) => RANK[a.scope] - RANK[b.scope])) out.set(s.name, s);
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ------------------------------------------------------------------ commands

export type SecretCommand =
  | { kind: "list" }
  | { kind: "help" }
  | { kind: "set"; name: string; file: boolean }
  | { kind: "rm"; name?: string; scope?: SecretScope }
  | { kind: "bad"; reason: string };

/** `!secret …`, or null when the text is not one. */
export function parseSecretCommand(text: string): SecretCommand | null {
  const [head, sub = "", ...rest] = text.trim().split(/\s+/);
  if (head?.toLowerCase() !== "!secret" && head?.toLowerCase() !== "!secrets") return null;
  const lower = sub.toLowerCase();
  if (!sub || lower === "list" || lower === "ls") return { kind: "list" };
  if (lower === "help") return { kind: "help" };
  if (["rm", "remove", "delete", "unset"].includes(lower)) {
    const where = rest[1]?.toLowerCase();
    const scope: SecretScope | undefined =
      where === "session" ? "session" : where === "me" || where === "user" ? "user" : where === "workspace" || where === "org" ? "workspace" : undefined;
    if (where && !scope) return { kind: "bad", reason: `unknown scope \`${rest[1]}\`: use session, me or org` };
    return { kind: "rm", ...(rest[0] ? { name: rest[0] } : {}), ...(scope ? { scope } : {}) };
  }
  const explicit = lower === "set" || lower === "add";
  const name = explicit ? rest[0] : sub;
  if (!name) return { kind: "help" };
  const problem = secretNameProblem(name);
  if (problem) return { kind: "bad", reason: `can't use \`${name}\`: ${problem}` };
  return { kind: "set", name, file: /^file$/i.test((explicit ? rest[1] : rest[0]) ?? "") };
}

export const HELP = [
  "*Secrets* (values never go in messages)",
  "`!secret NAME`: set or replace `$NAME` through a private form (`!secret NAME file` for a file; `$NAME` is its path)",
  "`!secret`: names this session gets, by scope",
  "`!secret rm NAME [session|me|org]`: remove one",
  "Scopes: *this session*; *just me* (all your sessions); *organization* (every session of your organization; full members, not guests). The narrowest wins.",
  "Values that are not secret (an org name, a hostname): `!var help`.",
].join("\n");

export const NOTE =
  "Sessions on your computer all run as one Unix user for now, so another session could read this value with effort. " +
  "It is stored encrypted and redacted from what the agent posts.";

export function scopeLabel(scope: SecretScope, owner: string, viewer?: string): string {
  return scope === "session" ? "this session" : scope === "workspace" ? "the organization" : owner === viewer ? "just you" : `<@${owner}>'s sessions`;
}

export interface SecretMeta {
  scope: SecretScope;
  owner: string;
  name: string;
  file: boolean;
  variable: boolean;
  setBy: string;
  updatedAt: number;
}

/** `!secret`: names (never values) for a viewer, with which one a session uses. `owner` is the session's owner. */
export function listText(rows: SecretMeta[], viewer: string, owner: string, inSession: boolean): string {
  if (!rows.length) return `No secrets yet. \`!secret NAME\` sets one.\n\n${HELP}`;
  const sorted = [...rows].sort((a, b) => RANK[b.scope] - RANK[a.scope] || a.name.localeCompare(b.name));
  const winner = new Map<string, SecretMeta>();
  for (const r of sorted) if ((r.scope !== "user" || r.owner === owner) && !winner.has(r.name)) winner.set(r.name, r);
  const lines = sorted.map((r) => {
    const note = r.scope === "user" && r.owner !== owner ? " · not used here (not your session)" : winner.get(r.name) !== r ? " · overridden" : "";
    const when = new Date(r.updatedAt).toISOString().slice(0, 10);
    return `• \`${r.name}\`${r.file ? " (file)" : ""} · ${scopeLabel(r.scope, r.owner, viewer)} · set by <@${r.setBy}> ${when}${note}`;
  });
  return `*Secrets ${inSession ? "this session gets" : "for your sessions"}* (names only)\n${lines.join("\n")}`;
}

// ------------------------------------------------------------------ buttons and the modal

/** What an "Enter NAME" button carries: the session (if any), the name, file or not, and whether a session asked. */
export interface ButtonData {
  k?: string;
  n: string;
  f?: 1;
  r?: 1;
}

/** Where the modal was opened from, carried in its private_metadata. */
export interface ModalData {
  k?: string;
  ch?: string;
  th?: string;
  /** The request message to update, when a session asked. */
  rq?: string;
}

const utf8ToB64 = (s: string) => bytesToBase64Url(encoder.encode(s));
const b64ToUtf8 = (s: string) => decoder.decode(base64UrlToBytes(s));

export const buttonId = (d: ButtonData) => `s:${utf8ToB64(JSON.stringify(d))}`;

export function decodeButtonId(actionId: string): ButtonData | null {
  if (!actionId.startsWith("s:")) return null;
  try {
    const d = JSON.parse(b64ToUtf8(actionId.slice(2))) as ButtonData;
    return typeof d?.n === "string" && !secretNameProblem(d.n) ? d : null;
  } catch {
    return null;
  }
}

type Block = Record<string, unknown>;

export function enterButton(d: ButtonData, label = `Enter ${d.n}`): Block {
  return {
    type: "actions",
    elements: [{ type: "button", text: { type: "plain_text", text: label.slice(0, 75) }, action_id: buttonId(d), value: d.n, style: "primary" }],
  };
}

/** The ephemeral reply to `!secret NAME`. */
export function setBlocks(d: ButtonData): Block[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: `Set \`$${d.n}\`${d.f ? " (as a file)" : ""}. The form is private; the value is never posted.` } },
    enterButton(d),
  ];
}

/** The message a session's request_secret posts in its thread. */
export function requestBlocks(d: ButtonData, req: SecretRequest): Block[] {
  return [
    { type: "section", text: { type: "mrkdwn", text: `:key: *This session needs \`$${req.name}\`*${req.file ? " (a file)" : ""}\n${req.reason.slice(0, 500)}` } },
    enterButton(d),
    { type: "context", elements: [{ type: "mrkdwn", text: "Opens a private form; the value is never posted. `!secret help` for more." }] },
  ];
}

export interface ModalChoices {
  /** A session to offer the session scope for. */
  session: boolean;
  /** The session's owner, when it is not the person opening the form. */
  otherOwner?: string;
  /** A full member of the workspace, who may set workspace secrets. */
  member: boolean;
}

export function secretModal(d: ButtonData, meta: ModalData, c: ModalChoices): Record<string, unknown> {
  const options = [
    ...(c.session ? [{ value: "session", text: "This session only", description: "This thread; deleted 30 days after it was last used" }] : []),
    {
      value: "user",
      text: "Just me",
      description: c.otherOwner ? `All your sessions (not this one: it is <@${c.otherOwner}>'s)` : "All your sessions, until you remove it",
    },
    ...(c.member ? [{ value: "workspace", text: "Organization", description: "Every session of your organization" }] : []),
  ].map((o) => ({ value: o.value, text: { type: "plain_text", text: o.text }, description: { type: "mrkdwn", text: o.description } }));
  const fileOption = {
    value: "file",
    text: { type: "plain_text", text: "Provide as a file" },
    description: { type: "mrkdwn", text: "`$NAME` holds the path of a file with the value" },
  };
  return {
    type: "modal",
    callback_id: SECRET_VIEW,
    private_metadata: JSON.stringify(meta),
    title: { type: "plain_text", text: "Set a secret" },
    submit: { type: "plain_text", text: "Save" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      { type: "input", block_id: "name", label: { type: "plain_text", text: "Name" }, element: { type: "plain_text_input", action_id: "v", initial_value: d.n, max_length: 64 } },
      {
        type: "input",
        block_id: "value",
        label: { type: "plain_text", text: "Value" },
        hint: { type: "plain_text", text: "Shown only to you while you type. Never posted, never shown again." },
        element: { type: "plain_text_input", action_id: "v", multiline: true, max_length: INPUT_MAX },
      },
      { type: "input", block_id: "scope", label: { type: "plain_text", text: "Available to" }, element: { type: "radio_buttons", action_id: "v", options, initial_option: options[0] } },
      {
        type: "input",
        block_id: "opts",
        optional: true,
        label: { type: "plain_text", text: "Options" },
        element: { type: "checkboxes", action_id: "v", options: [fileOption], ...(d.f ? { initial_options: [fileOption] } : {}) },
      },
      { type: "context", elements: [{ type: "mrkdwn", text: NOTE }] },
    ],
  };
}

/** The fields of a submitted modal: `state.values[block][action]`. */
export interface SubmittedView {
  callback_id?: string;
  private_metadata?: string;
  state?: {
    values?: Record<string, Record<string, { value?: string | null; selected_option?: { value?: string } | null; selected_options?: { value?: string }[] | null }>>;
  };
}

export type Submission =
  | { errors: Record<string, string> }
  | { name: string; value: string; scope: SecretScope; file: boolean; meta: ModalData };

/** A submitted modal, checked as far as it can be without the store: errors go back onto the modal. */
export function readSubmission(view: SubmittedView): Submission {
  const v = view.state?.values ?? {};
  const name = String(v.name?.v?.value ?? "").trim();
  const raw = v.value?.v?.value ?? "";
  const scope = v.scope?.v?.selected_option?.value;
  const file = (v.opts?.v?.selected_options ?? []).some((o) => o.value === "file");
  let meta: ModalData = {};
  try {
    meta = JSON.parse(view.private_metadata || "{}") as ModalData;
  } catch {}
  const problem = secretNameProblem(name);
  if (problem) return { errors: { name: problem } };
  if (!raw.trim()) return { errors: { value: "Enter a value." } };
  if (scope !== "session" && scope !== "user" && scope !== "workspace") return { errors: { scope: "Pick where it applies." } };
  // A pasted value keeps no trailing newline, unless it is a file.
  return { name, value: file ? raw : raw.trim(), scope, file, meta };
}
