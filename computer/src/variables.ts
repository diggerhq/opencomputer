// Variables (work 046): values a session gets in its environment like a
// secret, but that are not secret (an organization's name, a hostname). They
// are set in a plain message, listed with their values and never redacted.
// They are stored next to secrets, in the same scopes and under the same
// rules; within one scope a name is either a secret or a variable.
//
//   !var NAME value [session|me|workspace]   set (default: this session)
//   !var NAME=value [...]                    the same
//   !var rm NAME [session|me|workspace]
//   !vars                                    what this session gets, with values
//
// The pure part, shared by the gateway's handler and the backend's port.

import type { SecretScope } from './protocol.js';
import { secretNameProblem } from './secret-names.js';

/** Longest value a message may set; Slack's own message limit is far higher. */
export const MAX_VARIABLE = 3000;

export type VariableCommand =
  | { kind: 'list' }
  | { kind: 'help' }
  | { kind: 'set'; name: string; value: string; scope?: SecretScope }
  | { kind: 'rm'; name?: string; scope?: SecretScope }
  | { kind: 'bad'; reason: string };

const SCOPES: Record<string, SecretScope> = { session: 'session', me: 'user', user: 'user', workspace: 'workspace', org: 'workspace' };

export const VARIABLE_HELP = [
  '*Variables* (not secret: shown in Slack, never redacted)',
  '`!var NAME value [session|me|workspace]`: set `$NAME` (default: this session; wrap a value in backticks to keep it exact)',
  '`!vars`: names and values this session gets, by scope',
  '`!var rm NAME [session|me|workspace]`: remove one',
  'For API keys and passwords use `!secret NAME` instead. A secret and a variable cannot share a name in one scope.',
].join('\n');

/** `!var …` / `!vars`, or null when the text is not one. `text` is already decoded from Slack's escaping. */
export function parseVariableCommand(text: string): VariableCommand | null {
  const m = /^!(?:vars?|variables?)(?=\s|$)([\s\S]*)$/i.exec(text.trim());
  if (!m) return null;
  const body = m[1]!.trim();
  const [sub = '', ...rest] = body.split(/\s+/);
  const lower = sub.toLowerCase();
  if (!sub || lower === 'list' || lower === 'ls') return { kind: 'list' };
  if (lower === 'help') return { kind: 'help' };
  if (['rm', 'remove', 'delete', 'unset'].includes(lower)) {
    const where = rest[1]?.toLowerCase();
    const scope = where ? SCOPES[where] : undefined;
    if (where && !scope) return { kind: 'bad', reason: `unknown scope \`${rest[1]}\`: use session, me or workspace` };
    return { kind: 'rm', ...(rest[0] ? { name: rest[0] } : {}), ...(scope ? { scope } : {}) };
  }
  const assignment = /^(?:set|add)\s/i.test(body) ? body.replace(/^\S+\s+/, '') : body;
  const [, name = '', raw = ''] = /^([^\s=]+)\s*=?\s*([\s\S]*)$/.exec(assignment) ?? [];
  const problem = secretNameProblem(name);
  if (problem) return { kind: 'bad', reason: `can't use \`${name}\`: ${problem}` };
  let value = raw.trim();
  let scope: SecretScope | undefined;
  const last = /\s(\S+)$/.exec(value);
  if (last && SCOPES[last[1]!.toLowerCase()]) {
    scope = SCOPES[last[1]!.toLowerCase()];
    value = value.slice(0, last.index).trim();
  }
  const fenced = /^```\n?([\s\S]*?)\n?```$/.exec(value) ?? /^`([^`]*)`$/.exec(value);
  if (fenced) value = fenced[1]!;
  if (!value) return { kind: 'bad', reason: `no value: \`!var ${name} value\` sets it, \`!var rm ${name}\` removes it` };
  if (value.length > MAX_VARIABLE) return { kind: 'bad', reason: `the value is too long (limit ${MAX_VARIABLE} characters)` };
  return { kind: 'set', name, value, ...(scope ? { scope } : {}) };
}

/** A value as shown in Slack: inline code when it can be, on one line, cut at 200 characters. */
export function showValue(value: string): string {
  const line = value.replace(/\s*\n\s*/g, ' ⏎ ');
  const cut = line.length > 200 ? `${line.slice(0, 200)}…` : line;
  return cut.includes('`') ? cut : `\`${cut}\``;
}

/** Name parts that usually mean a credential. */
const SECRET_WORDS = /^(TOKEN|TOKENS|SECRET|SECRETS|PASSWORD|PASSWD|PASS|PWD|KEY|APIKEY|PRIVATE|CREDENTIAL|CREDENTIALS|CREDS|AUTH|PAT|COOKIE|DSN)$/i;
/** Values that look like one: well-known key formats, or a long random-looking token. */
const SECRET_VALUES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{10,}|\bsk-[A-Za-z0-9_-]{20,}/, 'an API key'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,})/, 'a Git token'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b|\bAIza[0-9A-Za-z_-]{35}/, 'a cloud key'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\./, 'a JWT'],
  [/:\/\/[^\s/:@]+:[^\s/@]+@/, 'a URL with a password'],
];

/**
 * Why `NAME=value` looks like a credential, or undefined. A soft check: a
 * variable is shown in Slack and never redacted, so `!var` asks before keeping
 * one that looks secret, and the person may set it anyway.
 */
export function credentialHint(name: string, value: string): string | undefined {
  if (name.split('_').some((w) => SECRET_WORDS.test(w))) return `the name \`${name}\` sounds like a credential`;
  for (const [re, what] of SECRET_VALUES) if (re.test(value)) return `the value looks like ${what}`;
  const long = value
    .trim()
    .split(/\s+/)
    .find((w) => w.length >= 32 && !/[/.]/.test(w) && /[a-z]/.test(w) && /[A-Z]/.test(w) && /\d/.test(w));
  if (long) return 'the value looks like a random token';
}
