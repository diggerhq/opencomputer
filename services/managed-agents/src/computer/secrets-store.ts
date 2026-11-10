// An organization's session secrets (work 046, decision 5; ported from
// dash-cal src/workspace-secrets.ts): the `secrets` table in its
// ComputerDurableObject, and the Slack side of setting them. The Durable
// Object is the copy of record; values leave it only decrypted into a
// `deliver` or `secrets` frame for the host, which keeps them in memory and
// on tmpfs. D1 and the dashboard never see them.
//
// Rows are sealed with a key derived from BLUE_CHANNEL_ENCRYPTION_KEY, with
// scope, owner and name as associated data (secrets.ts). Session rows are
// deleted once their session has gone SESSION_TTL_MS without a delivery.
// Variables (`!var`, variables.ts) are rows with `variable` set: stored and
// delivered the same way, shown in Slack, never redacted by the runner.

import {
  type ButtonData,
  type ModalData,
  type SecretCommand,
  type SecretMeta,
  type SecretRequest,
  type SecretScope,
  type SessionSecret,
  type SubmittedView,
  HELP,
  SESSION_TTL_MS,
  decodeButtonId,
  listText,
  narrowest,
  openSecret,
  readSubmission,
  requestBlocks,
  scopeLabel,
  sealSecret,
  secretModal,
  secretNameProblem,
  setBlocks,
} from "./secrets.js";
import { type VariableCommand, VARIABLE_HELP, credentialHint, parseVariableCommand, showValue } from "./variables.js";
import type { ApiCaller, ApiReply } from "./sessions-api.js";

/** Slack's limit on a button's value, which carries the `!var` command for "Set it anyway". */
const BUTTON_VALUE_MAX = 2000;

/** Upper bound on a stored value, in bytes (Slack's input caps it at 3000 characters anyway). */
const MAX_VALUE = 64 * 1024;

/** Rows per layer (work 095): organization, one person, one session. */
const MAX_ROWS: Record<SecretScope, number> = { workspace: 200, user: 64, session: 64 };
/** API writes per caller per minute. */
const API_WRITES_PER_MINUTE = 30;
/** `secret_events` rows are kept this long. */
const EVENTS_KEPT_MS = 365 * 24 * 3600_000;
/** `last_used` is written at most this often per row. */
const LAST_USED_EVERY_MS = 60_000;
/** Events one history read returns, newest first. */
const EVENTS_PAGE = 100;

/** Who changed a secret, for the row and `secret_events`: a Slack user id, or an organization member (`usr_…`). */
export interface SecretActor {
  id: string;
  name?: string | null;
  surface: "slack" | "dashboard" | "api" | "opc" | "system";
}

/** The Computer API's secrets operations (work 095 v1: the organization layer). */
export type SecretsApiOp =
  | { op: "secrets.list" }
  | { op: "secrets.put"; name: string; body: unknown }
  | { op: "secrets.delete"; name: string }
  | { op: "secrets.events"; name: string };

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);
const actorOf = (id: string | null, name: string | null) =>
  !id ? null : id.startsWith("usr_") ? { member: id, name } : id === "system" ? { system: true } : { slackUserId: id };
const apiError = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): ApiReply => ({ status, error: { code, message, ...extra } });

export interface SlackResult {
  ok: boolean;
  error?: string;
  ts?: string;
  user?: {
    team_id?: string;
    deleted?: boolean;
    is_bot?: boolean;
    is_restricted?: boolean;
    is_ultra_restricted?: boolean;
    is_stranger?: boolean;
  };
}

/** Where a command or click came from. */
export interface SecretContext {
  userId: string;
  channelId?: string;
  threadTs?: string;
  /** The session the thread runs, when it is one: runner key and owner. */
  session?: { key: string; ownerId: string };
}

export interface SecretsStoreDeps {
  sql: SqlStorage;
  encryptionKey: () => string | undefined;
  /** The linked Slack workspace's id: organization secrets are for its own full members. */
  teamId: () => string;
  slack(method: string, body: Record<string, unknown>): Promise<SlackResult>;
  /** The session a runner key names, if this workspace has its conversation. */
  session(runnerKey: string): { key: string; ownerId: string; channelId: string; threadTs: string } | undefined;
  /** Send changed secrets to running sessions: one session, one person's sessions, or all. */
  push(which: { key?: string; owner?: string }): Promise<void>;
  /** Tell a session that asked for a secret that it is set; starts its next turn. */
  wake(session: { key: string; ownerId: string; channelId: string; threadTs: string }, userId: string, text: string, ts: string): Promise<void>;
}

export class SecretsStore {
  constructor(private deps: SecretsStoreDeps) {
    deps.sql.exec(`
      CREATE TABLE IF NOT EXISTS secrets (
        scope TEXT NOT NULL,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        file INTEGER NOT NULL,
        sealed TEXT NOT NULL,
        set_by TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        last_used INTEGER NOT NULL,
        PRIMARY KEY (scope, owner, name)
      );
    `);
    for (const column of ["variable INTEGER NOT NULL DEFAULT 0", "created_at INTEGER", "created_by TEXT", "set_by_name TEXT", "created_by_name TEXT"]) {
      try {
        deps.sql.exec(`ALTER TABLE secrets ADD COLUMN ${column}`);
      } catch {
        // Already there.
      }
    }
    deps.sql.exec("UPDATE secrets SET created_at = updated_at, created_by = set_by WHERE created_at IS NULL");
    // Work 095: who set, replaced, removed or expired what, and from where. Never a value or a hash of one.
    deps.sql.exec(`
      CREATE TABLE IF NOT EXISTS secret_events (
        ts INTEGER NOT NULL,
        actor TEXT NOT NULL,
        actor_name TEXT,
        surface TEXT NOT NULL,
        action TEXT NOT NULL,
        scope TEXT NOT NULL,
        owner TEXT NOT NULL,
        name TEXT NOT NULL,
        variable INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS secret_events_name ON secret_events (scope, name, ts);
      CREATE INDEX IF NOT EXISTS secret_events_actor ON secret_events (actor, ts);
    `);
  }

  // ---------------------------------------------------------------- storage

  /** Sets or replaces a row; throws a message for the person when it is too large or the layer is full. Returns whether it replaced one. */
  private async put(scope: SecretScope, owner: string, name: string, value: string, file: boolean, actor: SecretActor, variable = false): Promise<boolean> {
    if (new TextEncoder().encode(value).byteLength > MAX_VALUE) throw new Error("Too large.");
    const exists = this.has(scope, owner, name);
    if (!exists) {
      const count = this.deps.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM secrets WHERE scope = ? AND owner = ?", scope, owner).toArray()[0]!.n;
      if (count >= MAX_ROWS[scope]) throw new Error(`At most ${MAX_ROWS[scope]} secrets and variables here; remove one first.`);
    }
    const sealed = await sealSecret(value, this.deps.encryptionKey(), scope, owner, name);
    const now = Date.now();
    const by = actor.name ?? null;
    this.deps.sql.exec(
      `INSERT INTO secrets (scope, owner, name, file, variable, sealed, set_by, set_by_name, created_at, created_by, created_by_name, updated_at, last_used)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, owner, name) DO UPDATE SET
         file = excluded.file, variable = excluded.variable, sealed = excluded.sealed, set_by = excluded.set_by,
         set_by_name = excluded.set_by_name, updated_at = excluded.updated_at, last_used = excluded.last_used`,
      scope, owner, name, file ? 1 : 0, variable ? 1 : 0, sealed, actor.id, by, now, actor.id, by, now, now,
    );
    this.event(actor, exists ? "replace" : "set", scope, owner, name, variable);
    return exists;
  }

  private has(scope: SecretScope, owner: string, name: string): boolean {
    return this.deps.sql.exec("SELECT 1 FROM secrets WHERE scope = ? AND owner = ? AND name = ?", scope, owner, name).toArray().length > 0;
  }

  private remove(scope: SecretScope, owner: string, name: string, actor: SecretActor): boolean {
    const row = [...this.deps.sql.exec<{ variable: number }>("SELECT variable FROM secrets WHERE scope = ? AND owner = ? AND name = ?", scope, owner, name)][0];
    if (!row) return false;
    this.deps.sql.exec("DELETE FROM secrets WHERE scope = ? AND owner = ? AND name = ?", scope, owner, name);
    this.event(actor, "delete", scope, owner, name, !!row.variable);
    return true;
  }

  /** One `secret_events` row; events older than a year go on the way. */
  private event(actor: SecretActor, action: "set" | "replace" | "delete" | "expire", scope: SecretScope, owner: string, name: string, variable: boolean): void {
    const now = Date.now();
    this.deps.sql.exec(
      "INSERT INTO secret_events (ts, actor, actor_name, surface, action, scope, owner, name, variable) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      now, actor.id, actor.name ?? null, actor.surface, action, scope, owner, name, variable ? 1 : 0,
    );
    this.deps.sql.exec("DELETE FROM secret_events WHERE ts < ?", now - EVENTS_KEPT_MS);
  }

  private scopesFor(sessionKey: string | undefined, ownerId: string): Array<[SecretScope, string]> {
    return [...(sessionKey ? [["session", sessionKey] as [SecretScope, string]] : []), ["user", ownerId], ["workspace", "*"]];
  }

  private meta(scopes: Array<[SecretScope, string]>): SecretMeta[] {
    return scopes.flatMap(([scope, owner]) =>
      [...this.deps.sql.exec<{ name: string; file: number; variable: number; setBy: string; updatedAt: number }>(
        "SELECT name, file, variable, set_by AS setBy, updated_at AS updatedAt FROM secrets WHERE scope = ? AND owner = ?",
        scope,
        owner,
      )].map((r) => ({ scope, owner, name: r.name, file: !!r.file, variable: !!r.variable, setBy: r.setBy, updatedAt: r.updatedAt })),
    );
  }

  /** Every secret a session gets, narrowest scope winning; rows that do not decrypt are skipped and logged. */
  async forSession(sessionKey: string, ownerId: string): Promise<SessionSecret[]> {
    const now = Date.now();
    const expired = [...this.deps.sql.exec<{ owner: string; name: string; variable: number }>(
      "SELECT owner, name, variable FROM secrets WHERE scope = 'session' AND last_used < ?",
      now - SESSION_TTL_MS,
    )];
    if (expired.length) {
      this.deps.sql.exec("DELETE FROM secrets WHERE scope = 'session' AND last_used < ?", now - SESSION_TTL_MS);
      for (const r of expired) this.event({ id: "system", surface: "system" }, "expire", "session", r.owner, r.name, !!r.variable);
    }
    // "Last used" is the last delivery to a session, every layer; written at most once a minute per row.
    for (const [scope, owner] of this.scopesFor(sessionKey, ownerId)) {
      this.deps.sql.exec("UPDATE secrets SET last_used = ? WHERE scope = ? AND owner = ? AND last_used < ?", now, scope, owner, now - LAST_USED_EVERY_MS);
    }
    // Read synchronously, then unsealed in parallel (work 068 §3d); the order is kept.
    const rows = this.scopesFor(sessionKey, ownerId).flatMap(([scope, owner]) =>
      [...this.deps.sql.exec<{ name: string; file: number; variable: number; sealed: string }>(
        "SELECT name, file, variable, sealed FROM secrets WHERE scope = ? AND owner = ?",
        scope,
        owner,
      )].map((r) => ({ ...r, scope, owner })),
    );
    const opened = await Promise.all(
      rows.map(async (r): Promise<SessionSecret | null> => {
        try {
          const value = await openSecret(r.sealed, this.deps.encryptionKey(), r.scope, r.owner, r.name);
          return { name: r.name, value, scope: r.scope, ...(r.file ? { file: true } : {}), ...(r.variable ? { variable: true } : {}) };
        } catch {
          console.error("secret_undecryptable", { scope: r.scope, name: r.name });
          return null;
        }
      }),
    );
    return narrowest(opened.filter((secret): secret is SessionSecret => secret !== null));
  }

  // ---------------------------------------------------------------- Slack

  /**
   * Who may set and remove workspace secrets: full members of this Slack
   * workspace (2026-10-11: they are trusted). Not guests, people from
   * other organizations in shared channels, bots or deactivated accounts.
   */
  private async isMember(userId: string): Promise<boolean> {
    const r = await this.deps.slack("users.info", { user: userId });
    const u = r.ok ? r.user : undefined;
    if (!u || u.deleted || u.is_bot || u.is_restricted || u.is_ultra_restricted || u.is_stranger) return false;
    return !u.team_id || u.team_id === this.deps.teamId();
  }

  private async ephemeral(ctx: SecretContext, text: string, blocks?: unknown[]): Promise<void> {
    if (!ctx.channelId) return;
    await this.deps.slack("chat.postEphemeral", {
      channel: ctx.channelId,
      user: ctx.userId,
      text,
      ...(ctx.threadTs ? { thread_ts: ctx.threadTs } : {}),
      ...(blocks ? { blocks } : {}),
    });
  }

  /** `!secret …` from a person: answered with an ephemeral message; never reaches the session. */
  async command(cmd: SecretCommand, ctx: SecretContext): Promise<void> {
    const say = (text: string, blocks?: unknown[]) => this.ephemeral(ctx, text, blocks);
    switch (cmd.kind) {
      case "help":
        return say(HELP);
      case "bad":
        return say(`Can't do that: ${cmd.reason}.`);
      case "list": {
        const owner = ctx.session?.ownerId ?? ctx.userId;
        const scopes = this.scopesFor(ctx.session?.key, owner);
        if (owner !== ctx.userId) scopes.push(["user", ctx.userId]);
        return say(listText(this.meta(scopes).filter((m) => !m.variable), ctx.userId, owner, !!ctx.session));
      }
      case "set": {
        const d: ButtonData = { ...(ctx.session ? { k: ctx.session.key } : {}), n: cmd.name, ...(cmd.file ? { f: 1 as const } : {}) };
        return say(`Set ${cmd.name}`, setBlocks(d));
      }
      case "rm":
        return say(await this.rm(cmd.name, cmd.scope, ctx));
    }
  }

  private async rm(name: string | undefined, only: SecretScope | undefined, ctx: SecretContext): Promise<string> {
    if (!name) return "Usage: `!secret rm NAME [session|me|workspace]`";
    const candidates: Array<[SecretScope, string]> = [
      ...(ctx.session ? [["session", ctx.session.key] as [SecretScope, string]] : []),
      ["user", ctx.userId],
      ["workspace", "*"],
    ];
    const present = candidates.filter(([scope, owner]) => (!only || only === scope) && this.meta([[scope, owner]]).some((m) => m.name === name && !m.variable));
    if (!present.length) return `No \`${name}\`${only ? ` in ${only === "user" ? "your" : `the ${only}`} scope` : ""} to remove. \`!secret\` lists names.`;
    if (present.length > 1 && !only) {
      const where = present.map(([s]) => (s === "user" ? "me" : s)).join(", ");
      return `\`${name}\` is set in several scopes (${where}); say which: \`!secret rm ${name} <${where.replaceAll(", ", "|")}>\``;
    }
    const [scope, owner] = present[0]!;
    if (scope === "workspace" && !(await this.isMember(ctx.userId))) return `\`${name}\` is an organization secret; only full members of this Slack workspace can remove it.`;
    this.remove(scope, owner, name, { id: ctx.userId, surface: "slack" });
    console.log("secret_removed", { scope, name, by: ctx.userId });
    await this.deps.push(scope === "session" ? { key: owner } : scope === "user" ? { owner } : {});
    return `Removed \`${name}\` from ${scopeLabel(scope, owner, ctx.userId)}.`;
  }

  /**
   * `!var …` from a person: variables are not secret, so they are set in the
   * message itself and listed with their values. A variable never replaces a
   * secret of the same name and scope (that would show a credential); a
   * secret may replace a variable through the modal.
   */
  /**
   * `!var …` (`text` as typed). A value that looks like a credential is not
   * kept: the answer asks, with a "Set it anyway" button that carries `text`.
   */
  async variableCommand(cmd: VariableCommand, ctx: SecretContext, text = ""): Promise<void> {
    const out = await this.variableReply(cmd, ctx, false);
    if (typeof out === "string") return this.ephemeral(ctx, out);
    const ask = `Not set: ${out.hint}. A variable is shown in Slack and never redacted, so keep credentials with \`!secret ${out.name}\` instead.`;
    if (!text || text.length > BUTTON_VALUE_MAX) return this.ephemeral(ctx, `${ask} (If it is not secret, set it as a secret anyway.)`);
    return this.ephemeral(ctx, ask, [
      { type: "section", text: { type: "mrkdwn", text: `${ask} If it is not secret, set it anyway.` } },
      { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Set it anyway" }, action_id: `v:${ctx.session?.key ?? ""}`, value: text }] },
    ]);
  }

  /** A click on "Set it anyway": the command again, checks and all, without the credential one; `respond` replaces the question. */
  async confirmVariable(text: string, ctx: SecretContext, respond: (text: string) => Promise<void>): Promise<void> {
    const cmd = parseVariableCommand(text);
    if (cmd?.kind !== "set") return;
    await respond(await this.variableReply(cmd, ctx, true));
  }

  private async variableReply(cmd: VariableCommand, ctx: SecretContext, confirmed: true): Promise<string>;
  private async variableReply(cmd: VariableCommand, ctx: SecretContext, confirmed: boolean): Promise<string | { hint: string; name: string }>;
  private async variableReply(cmd: VariableCommand, ctx: SecretContext, confirmed: boolean): Promise<string | { hint: string; name: string }> {
    if (cmd.kind === "help") return VARIABLE_HELP;
    if (cmd.kind === "bad") return `Can't do that: ${cmd.reason}.`;
    if (cmd.kind === "list") {
      const scopes = this.scopesFor(ctx.session?.key, ctx.session?.ownerId ?? ctx.userId);
      const all = this.meta(scopes);
      if (!all.some((m) => m.variable)) return `No variables yet.\n\n${VARIABLE_HELP}`;
      // Narrowest first, secrets included: a narrower secret of the same name overrides a variable.
      const winner = new Map<string, SecretScope>();
      for (const m of all) if (!winner.has(m.name)) winner.set(m.name, m.scope);
      const lines = await Promise.all(
        all.filter((m) => m.variable).map(async (m) => {
          const value = await this.value(m.scope, m.owner, m.name);
          const shown = value === undefined ? "(does not decrypt)" : showValue(value);
          return `• \`${m.name}\` = ${shown} · ${scopeLabel(m.scope, m.owner, ctx.userId)}${winner.get(m.name) === m.scope ? "" : " · overridden"}`;
        }),
      );
      return `*Variables ${ctx.session ? "this session gets" : "for your sessions"}*\n${lines.join("\n")}`;
    }
    const scope: SecretScope = cmd.scope ?? (ctx.session ? "session" : "user");
    if (scope === "session" && !ctx.session) return "Not in a session: add `me` or `org`.";
    if (scope === "workspace" && !(await this.isMember(ctx.userId))) return "Only full members of this Slack workspace can set or remove organization variables.";
    const owner = scope === "session" ? ctx.session!.key : scope === "user" ? ctx.userId : "*";
    const where = scopeLabel(scope, owner, ctx.userId);
    const existing = cmd.name ? this.meta([[scope, owner]]).find((m) => m.name === cmd.name) : undefined;
    if (cmd.kind === "rm") {
      if (!existing?.variable) return `No variable \`${cmd.name ?? ""}\` in ${where}. \`!vars\` lists them.`;
      this.remove(scope, owner, existing.name, { id: ctx.userId, surface: "slack" });
      console.log("variable_removed", { scope, name: existing.name, by: ctx.userId });
      await this.deps.push(scope === "session" ? { key: owner } : scope === "user" ? { owner } : {});
      return `Removed \`${existing.name}\` from ${where}.`;
    }
    if (existing && !existing.variable)
      return `\`${cmd.name}\` is a secret in ${where}; a variable does not replace a secret. \`!secret rm ${cmd.name}\` first if it is not secret.`;
    const hint = confirmed ? undefined : credentialHint(cmd.name, cmd.value);
    if (hint) return { hint, name: cmd.name };
    try {
      await this.put(scope, owner, cmd.name, cmd.value, false, { id: ctx.userId, surface: "slack" }, true);
    } catch (error) {
      return `Not set: ${error instanceof Error ? error.message : "could not store it."}`;
    }
    console.log("variable_set", { scope, name: cmd.name, by: ctx.userId });
    await this.deps.push(scope === "session" ? { key: owner } : scope === "user" ? { owner } : {});
    return `Set \`${cmd.name}\` = ${showValue(cmd.value)} for ${where}. It is in the environment of the session's next Bash command.`;
  }

  private async value(scope: SecretScope, owner: string, name: string): Promise<string | undefined> {
    const row = [...this.deps.sql.exec<{ sealed: string }>("SELECT sealed FROM secrets WHERE scope = ? AND owner = ? AND name = ?", scope, owner, name)][0];
    return row ? openSecret(row.sealed, this.deps.encryptionKey(), scope, owner, name).catch(() => undefined) : undefined;
  }

  /** A click on an "Enter NAME" button: open the modal (the trigger expires in 3 s). */
  async open(actionId: string, triggerId: string, ctx: SecretContext & { messageTs?: string }): Promise<void> {
    const d = decodeButtonId(actionId);
    if (!d) return;
    const session = d.k ? this.deps.session(d.k) : undefined;
    const meta: ModalData = {
      ...(session ? { k: session.key } : {}),
      ...(ctx.channelId ? { ch: ctx.channelId } : {}),
      ...((session?.threadTs ?? ctx.threadTs) ? { th: session?.threadTs ?? ctx.threadTs } : {}),
      ...(d.r && ctx.messageTs ? { rq: ctx.messageTs } : {}),
    };
    const view = secretModal(d, meta, {
      session: !!session,
      ...(session && session.ownerId !== ctx.userId ? { otherOwner: session.ownerId } : {}),
      member: await this.isMember(ctx.userId),
    });
    const r = await this.deps.slack("views.open", { trigger_id: triggerId, view });
    if (!r.ok) console.error("secret_modal_failed", { error: r.error });
  }

  /**
   * The modal was submitted. Errors go back in the response, keeping the
   * modal open; otherwise the value is stored, and `after` posts the outcome
   * and pushes the change (run after the response; Slack wants it in 3 s).
   */
  async submit(view: SubmittedView, userId: string): Promise<{ errors?: Record<string, string>; after?: () => Promise<void> }> {
    const s = readSubmission(view);
    if ("errors" in s) return { errors: s.errors };
    const session = s.meta.k ? this.deps.session(s.meta.k) : undefined;
    if (s.scope === "session" && !session) return { errors: { scope: "This session no longer exists; pick another scope." } };
    if (s.scope === "workspace" && !(await this.isMember(userId))) return { errors: { scope: "Only full members of this Slack workspace can set organization secrets." } };
    const owner = s.scope === "session" ? session!.key : s.scope === "user" ? userId : "*";
    try {
      await this.put(s.scope, owner, s.name, s.value, s.file, { id: userId, surface: "slack" });
    } catch (error) {
      return { errors: { value: error instanceof Error ? error.message : "Could not store it." } };
    }
    console.log("secret_set", { scope: s.scope, name: s.name, by: userId, session: session?.key });
    return {
      after: async () => {
        await this.deps.push(s.scope === "session" ? { key: owner } : s.scope === "user" ? { owner } : {});
        const where = scopeLabel(s.scope, owner, userId);
        const note = `:key: <@${userId}> set \`${s.name}\`${s.file ? " (file)" : ""} for ${where === "just you" ? "their sessions" : where}.`;
        const { ch, th, rq } = s.meta;
        if (rq && ch) await this.deps.slack("chat.update", { channel: ch, ts: rq, text: note, blocks: [] });
        else if (ch && session) await this.deps.slack("chat.postMessage", { channel: ch, ...(th ? { thread_ts: th } : {}), text: note });
        else if (ch) await this.ephemeral({ userId, channelId: ch, ...(th ? { threadTs: th } : {}) }, note.replace(`<@${userId}> set`, "Set"));
        // The session asked and is waiting: tell it, which starts its next turn.
        const applies = session && (s.scope !== "user" || session.ownerId === userId);
        if (rq && session && applies) {
          const text =
            `Secret $${s.name} is set (${where === "just you" ? "all my sessions" : where}). ` +
            `It is in the environment of your next Bash command${s.file ? " as the path of a file holding it" : ""}. Continue.`;
          await this.deps.wake(session, userId, text, rq);
        }
      },
    };
  }

  /** A session's request_secret: a button in its thread, for whoever is there. */
  async request(sessionKey: string, req: SecretRequest): Promise<void> {
    const session = this.deps.session(sessionKey);
    if (!session) throw new Error(`unknown session ${sessionKey}`);
    const problem = secretNameProblem(req.name);
    if (problem) throw new Error(`bad name: ${problem}`);
    const d: ButtonData = { k: session.key, n: req.name, ...(req.file ? { f: 1 as const } : {}), r: 1 };
    const r = await this.deps.slack("chat.postMessage", {
      channel: session.channelId,
      thread_ts: session.threadTs,
      text: `This session needs ${req.name}: ${req.reason}`,
      blocks: requestBlocks(d, req),
    });
    if (!r.ok) throw new Error(`Slack post failed: ${r.error ?? "unknown_error"}`);
  }

  // ---------------------------------------------------------------- Computer API (work 095 v1)

  /**
   * The organization layer over the Computer API: any member may list, set, replace and delete
   * (2026-11-01). api-http.ts has already refused session keys and checked scopes.
   * Values go in, never out; variables are listed with theirs, as `!vars` shows them.
   */
  async api(caller: ApiCaller, op: SecretsApiOp): Promise<ApiReply> {
    if (op.op === "secrets.list") return { status: 200, body: { secrets: await this.orgRows() } };
    if (op.op === "secrets.events") return { status: 200, body: { events: this.orgEvents(op.name) } };
    const actor: SecretActor = { id: caller.member, name: caller.name ?? caller.email, surface: caller.via };
    const recent = this.deps.sql.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM secret_events WHERE actor = ? AND ts > ?",
      actor.id,
      Date.now() - 60_000,
    ).toArray()[0]!.n;
    if (recent >= API_WRITES_PER_MINUTE) return apiError(429, "rate_limited", "Too many secret changes; try again in a minute.", { retryAfterMs: 60_000 });

    if (op.op === "secrets.delete") {
      if (!this.remove("workspace", "*", op.name, actor)) return apiError(404, "secret_not_found", "No such organization secret.");
      console.log("secret_removed", { scope: "workspace", name: op.name, by: actor.id, via: actor.surface });
      await this.pushAll();
      return { status: 204 };
    }

    const body = op.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) return apiError(400, "invalid_request", "The body must be a JSON object.", { field: "" });
    const { value, file = false, variable = false } = body as Record<string, unknown>;
    if (typeof value !== "string" || !value) return apiError(400, "invalid_request", "value is a non-empty string.", { field: "value" });
    if (typeof file !== "boolean") return apiError(400, "invalid_request", "file is a boolean.", { field: "file" });
    if (typeof variable !== "boolean") return apiError(400, "invalid_request", "variable is a boolean.", { field: "variable" });
    if (file && variable) return apiError(400, "invalid_request", "A variable cannot be a file.", { field: "file" });
    const problem = secretNameProblem(op.name, { variable });
    if (problem) return apiError(400, "invalid_name", `Can't use this name: ${problem.replaceAll("`", "")}.`, { field: "name" });
    let replaced: boolean;
    try {
      replaced = await this.put("workspace", "*", op.name, value, file, actor, variable);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not store it.";
      return message === "Too large."
        ? apiError(413, "too_large", `value is at most ${MAX_VALUE} bytes.`, { field: "value", bytes: MAX_VALUE })
        : apiError(409, "limit_reached", message);
    }
    console.log(variable ? "variable_set" : "secret_set", { scope: "workspace", name: op.name, by: actor.id, via: actor.surface });
    await this.pushAll();
    const row = (await this.orgRows()).find((r) => r.name === op.name);
    return { status: replaced ? 200 : 201, body: { secret: row } };
  }

  /** A change to the organization layer reaches every running session; a failed push does not undo the write. */
  private async pushAll(): Promise<void> {
    await this.deps.push({}).catch((error) => console.error("secret_push_failed", { error: error instanceof Error ? error.message : String(error) }));
  }

  /** Organization rows with metadata, and how many narrower rows of the same name win somewhere (counts only). */
  private async orgRows() {
    const overrides = new Map<string, { threads: number; people: number }>();
    for (const r of this.deps.sql.exec<{ name: string; scope: string; n: number }>(
      "SELECT name, scope, COUNT(*) AS n FROM secrets WHERE scope != 'workspace' GROUP BY name, scope",
    )) {
      const o = overrides.get(r.name) ?? { threads: 0, people: 0 };
      if (r.scope === "session") o.threads = r.n;
      else o.people = r.n;
      overrides.set(r.name, o);
    }
    const rows = [...this.deps.sql.exec<{
      name: string; file: number; variable: number; sealed: string; setBy: string; setByName: string | null;
      createdAt: number | null; createdBy: string | null; createdByName: string | null; updatedAt: number; lastUsed: number;
    }>(
      `SELECT name, file, variable, sealed, set_by AS setBy, set_by_name AS setByName, created_at AS createdAt, created_by AS createdBy,
              created_by_name AS createdByName, updated_at AS updatedAt, last_used AS lastUsed
       FROM secrets WHERE scope = 'workspace' AND owner = '*' ORDER BY name`,
    )];
    return Promise.all(
      rows.map(async (r) => ({
        name: r.name,
        layer: "organization" as const,
        kind: r.variable ? ("variable" as const) : ("secret" as const),
        file: !!r.file,
        ...(r.variable ? { value: await openSecret(r.sealed, this.deps.encryptionKey(), "workspace", "*", r.name).catch(() => null) } : {}),
        createdAt: iso(r.createdAt ?? r.updatedAt),
        createdBy: actorOf(r.createdBy ?? r.setBy, r.createdByName),
        updatedAt: iso(r.updatedAt),
        updatedBy: actorOf(r.setBy, r.setByName),
        // Null until a session gets it after it was last set.
        lastUsedAt: r.lastUsed > r.updatedAt ? iso(r.lastUsed) : null,
        overriddenIn: overrides.get(r.name) ?? { threads: 0, people: 0 },
      })),
    );
  }

  /** The organization layer's history for one name, newest first. */
  private orgEvents(name: string) {
    return [...this.deps.sql.exec<{ ts: number; actor: string; actorName: string | null; surface: string; action: string; variable: number }>(
      `SELECT ts, actor, actor_name AS actorName, surface, action, variable FROM secret_events
       WHERE scope = 'workspace' AND name = ? ORDER BY ts DESC LIMIT ?`,
      name,
      EVENTS_PAGE,
    )].map((e) => ({ at: iso(e.ts), action: e.action, kind: e.variable ? "variable" : "secret", actor: actorOf(e.actor, e.actorName), via: e.surface }));
  }
}
