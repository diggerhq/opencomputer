// Secrets in a running session (work 046), the runner's side. The gateway
// sends the session's secrets before each delivery and whenever they change;
// the runner makes them usable and keeps them out of Slack.
//
// Usable: Claude Code runs as one long-lived process, so a variable set in the
// runner after it started would never reach its Bash tool. Instead the runner
// points CLAUDE_ENV_FILE (sourced by Claude Code before Bash commands) at a
// one-line script that sources `values.sh`, which is rewritten on every
// change: a secret added mid-session is in the next command's environment, and
// a removed one is unset. A file secret is written to `files/<NAME>` and the
// variable holds its path. Everything lives in a per-session directory under
// SP_RUN (tmpfs on the VM), mode 700, and is deleted when the runner exits.
// The variables are also set in the runner's own environment, for processes
// started later without the env file (a new query, MCP servers).
//
// `values.sh` also carries the session's own variables (`base`): a spare
// runner's Claude Code (work 069) started before the session was known, so
// its Bash tool gets SP_SESSION_KEY and the git author only from here.
//
// Out of Slack: every known value is replaced with `[secret:NAME]` in what the
// runner posts. Variables (`!var`, `variable: true`) reach the environment the
// same way but are not secret: never redacted, and send_file may post them. Streamed text is filtered before it is chunked, holding back a
// tail that could be the start of a value; everything else is filtered at the
// Slack client. This stops accidents, not a session set on leaking a value.

import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { tool } from './tool.js';
import { z } from 'zod';
import type { SecretRequest, SessionSecret } from '../protocol.js';
import { secretNameProblem } from '../secret-names.js';
import { errorText } from '../log.js';

export const REQUEST_SECRET_TOOL = 'mcp__calvin__request_secret';

/** Values shorter than this are not redacted: they would match ordinary text. */
const MIN_REDACT = 6;
/** Lines of a multi-line value (a PEM key) at least this long are redacted on their own too. */
const MIN_LINE = 16;

const quote = (v: string) => `'${v.replaceAll("'", `'\\''`)}'`;

export class SessionSecrets {
  readonly envFile: string;
  private current: SessionSecret[] = [];
  private vars: Record<string, string> = {};
  private patterns: { text: string; label: string }[] = [];

  constructor(readonly dir: string) {
    this.envFile = path.join(dir, 'env.sh');
    mkdirSync(path.join(dir, 'files'), { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const values = path.join(dir, 'values.sh');
    // Written once: SessionStart hooks may append to CLAUDE_ENV_FILE.
    writeFileSync(this.envFile, `if [ -r ${quote(values)} ]; then . ${quote(values)}; fi\n`, { mode: 0o600 });
    this.write([]);
  }

  /** The session's complete set of secrets, replacing the previous one. */
  apply(list: SessionSecret[]) {
    const ok = list.filter((s) => !secretNameProblem(s.name));
    this.write(ok);
    for (const s of this.current) if (!ok.some((n) => n.name === s.name)) delete process.env[s.name];
    for (const s of ok) process.env[s.name] = s.file ? this.filePath(s.name) : s.value;
    this.current = ok;
    this.patterns = ok
      .filter((s) => !s.variable)
      .flatMap((s) => [
        { text: s.value.trim(), label: `[secret:${s.name}]` },
        ...(s.value.includes('\n')
          ? s.value.split('\n').map((l) => ({ text: l.trim(), label: `[secret:${s.name}]` })).filter((p) => p.text.length >= MIN_LINE)
          : []),
      ])
      .filter((p) => p.text.length >= MIN_REDACT)
      .sort((a, b) => b.text.length - a.text.length);
  }

  /** The session's own variables, exported ahead of its secrets and set in this process too. */
  base(vars: Record<string, string>) {
    this.vars = vars;
    Object.assign(process.env, vars);
    this.write(this.current);
  }

  get names() {
    return this.current.map((s) => s.name);
  }

  private filePath(name: string) {
    return path.join(this.dir, 'files', name);
  }

  private write(list: SessionSecret[]) {
    const lines = ['# written by the runner; replaced on every change'];
    for (const [k, v] of Object.entries(this.vars)) lines.push(`export ${k}=${quote(v)}`);
    for (const s of this.current) if (!list.some((n) => n.name === s.name)) lines.push(`unset ${s.name}`);
    for (const s of list) {
      if (s.file) {
        const f = this.filePath(s.name);
        writeFileSync(f + '.tmp', s.value, { mode: 0o600 });
        renameSync(f + '.tmp', f);
        lines.push(`export ${s.name}=${quote(f)}`);
      } else lines.push(`export ${s.name}=${quote(s.value)}`);
    }
    for (const s of this.current) if (s.file && !list.some((n) => n.name === s.name && n.file)) rmSync(this.filePath(s.name), { force: true });
    const values = path.join(this.dir, 'values.sh');
    writeFileSync(values + '.tmp', lines.join('\n') + '\n', { mode: 0o600 });
    renameSync(values + '.tmp', values);
  }

  /** `s` with every known value replaced by `[secret:NAME]`. */
  redact(s: string): string {
    if (!s) return s;
    for (const p of this.patterns) if (s.includes(p.text)) s = s.replaceAll(p.text, p.label);
    return s;
  }

  /** The name of a secret (not a variable) whose value occurs in `data`, if any. */
  foundIn(data: Buffer): string | undefined {
    for (const s of this.current) {
      if (s.variable) continue;
      const v = s.value.trim();
      if (v.length >= MIN_REDACT && data.includes(v)) return s.name;
    }
  }

  private streaming?: ReturnType<SessionSecrets['stream']>;

  /** Streamed text, redacted; a tail that could start a value waits for the next delta, or for `end`. */
  filter(text: string, end: boolean): string {
    this.streaming ??= this.stream();
    const out = this.streaming.push(text);
    return end ? out + this.streaming.flush() : out;
  }

  /** A filter for streamed text: redacts, and holds back a tail that could be the start of a value. */
  stream() {
    let buf = '';
    return {
      push: (delta: string): string => {
        buf = this.redact(buf + delta);
        let keep = 0;
        for (const p of this.patterns)
          for (let n = Math.min(p.text.length - 1, buf.length); n > keep; n--)
            if (buf.endsWith(p.text.slice(0, n))) {
              keep = n;
              break;
            }
        const out = buf.slice(0, buf.length - keep);
        buf = buf.slice(buf.length - keep);
        return out;
      },
      flush: (): string => {
        const out = this.redact(buf);
        buf = '';
        return out;
      },
    };
  }

  cleanup() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** A Slack client whose every call has its string arguments redacted (prompts, cards, files' comments). */
export function redactingClient<T extends object>(client: T, redact: (s: string) => string): T {
  const deep = (v: unknown): unknown =>
    typeof v === 'string'
      ? redact(v)
      : Array.isArray(v)
        ? v.map(deep)
        : v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]))
          : v;
  // Namespaces (`chat`) and methods (`postMessage`) are wrapped alike; a call
  // runs on the unwrapped owner, so methods never see the proxy as `this`.
  // biome-ignore lint/suspicious/noExplicitAny: wraps any Slack client namespace or method, untyped by nature
  const wrap = (target: any, owner?: unknown): any =>
    new Proxy(target, {
      get(t, prop) {
        const v = Reflect.get(t, prop, t);
        if (typeof prop !== 'string' || prop === 'then' || prop === 'constructor') return v;
        if (typeof v === 'function' || (v && typeof v === 'object' && !Array.isArray(v) && /^[a-z]/.test(prop))) return wrap(v, t);
        return v;
      },
      apply: (f, _this, args) => Reflect.apply(f, owner, args.map(deep)),
    });
  return wrap(client);
}

/** request_secret: the agent asks its person for a secret it needs; the gateway posts a button in the thread. */
export function requestSecretTool(ask: (req: SecretRequest) => Promise<void>, has: () => string[]) {
  let asked = 0;
  const fail = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true });
  return tool(
    'request_secret',
    'Ask the person in this Slack thread for a secret you need: an API key, token, password or credentials file. ' +
      'Never ask for secrets in chat. This posts a button; they type the value into a private Slack form, so it never ' +
      'passes through the conversation. Once set, it is in the environment of your next Bash commands as $NAME ' +
      '(with file: true, $NAME is the path of a file holding it). After calling this, end your turn and wait: you get a ' +
      'message when it is set. Never print a secret\'s value.',
    {
      name: z.string().describe('Environment variable name, e.g. MONID_API_KEY'),
      reason: z.string().min(3).max(200).describe('One line: what it is for, shown to the person'),
      file: z.boolean().optional().describe('Provide it as a file (a service-account JSON, a kubeconfig, a key); $NAME holds the path'),
    },
    async ({ name, reason, file }) => {
      const problem = secretNameProblem(name);
      if (problem) return fail(`bad name: ${problem}`);
      if (has().includes(name))
        return fail(`$${name} is already set for this session. If it is wrong, ask the person to replace it with \`!secret ${name}\`.`);
      if (asked >= 10) return fail('this session already asked for 10 secrets; ask the person in chat before asking for more');
      try {
        await ask({ name, reason: reason.replace(/\s+/g, ' ').trim(), ...(file ? { file } : {}) });
        asked++;
        return { content: [{ type: 'text' as const, text: `Asked for $${name} in the thread. End your turn now; you get a message when it is set.` }] };
      } catch (e) {
        return fail(`could not ask: ${errorText(e)}`);
      }
    },
    { alwaysLoad: true },
  );
}
