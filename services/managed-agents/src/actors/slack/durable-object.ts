// Slack: one per organization, the link to its Slack workspace and the only holder of its bot token
// (tracks and threads, spec 36.6 and 40.11). It deduplicates what Slack sends and owes each item a
// `process` call: threads in parallel, one thread's items in order. A message becomes a session (Org.createSession) and a turn in
// its SessionLog's inbox; a command becomes a call. It never delivers to a machine.

import { DurableObject } from "cloudflare:workers";

import { type AcceptResult } from "../session-log/contract.js";
import { type SlackEcho } from "../org/contract.js";
import { type BillingNotice, type BillingNoticeResult, type SlackGrant, type SlackRpc } from "./contract.js";
import { type Reply } from "../../durable/rpc-reply.js";
import { type ActorEnv, logOf, orgOf, slackOf, computerOf } from "../addresses.js";
import { alarms } from "../../durable/alarms.js";
import { type Emitter, emitter } from "../../telemetry/log-emitter.js";
import { slackTsMs, type TelemetryEnv } from "../../telemetry/gateway.js";
import { errorText, owed, RetryAfter } from "../../durable/outbox.js";
import { idem } from "../../durable/idempotency.js";
import { migrate } from "../../durable/migrations.js";
import { type Principal, platformPrincipal } from "../../auth/principal.js";
import { type Sql, sqlOf } from "../../durable/sql.js";
import { unavailable } from "../../durable/unavailable.js";
import { isRecord } from "../../encoding/canonical-json.js";
import type { SlackModalReply } from "../computer/contract.js";
import type { Origin } from "../../api-objects/objects.js";
import { seal, sha256Hex, unseal } from "../../crypto/seal.js";
import { type CalvinPerson, COMPUTER_GIT_NAME, noReplyGitEmail, personFor } from "../../host-protocol/person.js";
import { decodeCalvinActionId, parseSessionKey, sessionKey } from "../../host-protocol/session-key.js";
import {
  ACCESS_USAGE,
  answeredPost,
  CONTEXT_MAX_AGE_MS,
  CONTEXT_MAX_CHARS,
  CONTEXT_MAX_ROWS,
  commandArgs,
  commandText,
  commandWord,
  declinedText,
  defaultSetText,
  decodeAccessId,
  grantedText,
  listIsOpenText,
  noSessionText,
  notAskedText,
  onlyAdminDefaultText,
  onlyGrantorAnswersText,
  onlyGrantorChangesText,
  ownerDecidesText,
  parseAccessCommand,
  requestPost,
  requestSentText,
  type SlackCommand,
  slackCommand,
  stateText,
  computerHeld,
  sessionGoneText,
} from "./access.js";
import {
  joinRequestMessages,
  normalizeJob,
  OFFLINE_NOTICE,
  parseInteraction,
  parseSlackEnvelope,
  type SlackInteraction,
  type SlackMessageJob,
  type SlackResult,
  slackApi,
  slackRateLimited,
  slackThreadUrl,
  slackTokenDead,
  STARTING_NOTICE,
  WAKING_NOTICE,
} from "../../slack-api/web-api.js";
import { findThreadLinks, forwardedLinked, LINK_TIMEOUT_MS, type Linked, MAX_POST_CHARS, neutralizeBroadcasts, ThreadAccess } from "../../slack-api/threads.js";
import { entryIdFor, sessionIdFor, turnIdFor } from "../../ids/slack-ids.js";
import { isMemberId, memberId } from "../../ids/session-ids.js";
import { links, settings, threads } from "./tables.js";
import { owePost, oweProcess, postGroup, processGroup } from "./outbox.js";
import { STEPS } from "./schema.js";
import { tellBilling } from "./billing-notices.js";
import { announce } from "./announcements.js";

export interface SlackEnv extends ActorEnv, TelemetryEnv {
  BLUE_CHANNEL_ENCRYPTION_KEY?: string;
  COMPUTER_PUBLIC_ORIGIN?: string;
  OPENCOMPUTER_APP_URL?: string;
}

/** Slack retries an event for an hour at most; ids and message keys are kept a day. */
const DEDUP_TTL_MS = 24 * 60 * 60_000;

const INSTALL_NONCE_TTL_MS = 10 * 60_000;
const JOIN_REQUEST_INTERVAL_MS = 24 * 3600_000;

const MEMBER_SCOPES: Principal["scopes"] = ["sessions:read", "sessions:write", "asks:answer", "work:read", "work:write"];
const ONLY_MEMBERS_TEXT = "Only full members of this workspace can drive sessions.";
const INBOX_FULL_TEXT = "This session has too many messages waiting; try again once it has caught up.";
const UNREACHABLE_TEXT = "The computer could not be reached, so this message did not run. Try again in a minute.";
const REFUSED_TEXT = "This message did not run.";
const FAILED_NOTICE = "Your computer could not start; messages wait until it does.";

/**
 * A message to process; `harness` from its `+claude` or `+codex` prefix; `acked`: its working status
 * was started when it was owed (`oweMessage`), so a turn that does not run takes it off (`withdraw`).
 */
type MessageJob = SlackMessageJob & { harness?: string };
/** Any other item; tagged so a bare message (as Computer queued it) still reads. */
type OtherJob = { item: "stop"; eventId: string; teamId: string; channelId: string; threadTs?: string; userId?: string } | { item: "interaction"; id: string; body: unknown };
type Job = MessageJob | OtherJob;

const isOther = (job: Job): job is OtherJob => "item" in job;

/** A person as Org names them: a member id as is, a dashboard user id (`user_…`) as its member id. */
const asMember = async (id: string): Promise<string> => (isMemberId(id) ? id : memberId(id));

export class SlackDurableObject extends DurableObject<SlackEnv> implements SlackRpc {
  protected readonly sql: Sql;
  private readonly emit = emitter("slack", () => ({ team: this.ctx.id.name }), {
    env: () => this.env,
    waitUntil: (promise) => this.ctx.waitUntil(promise),
    fetch: () => this.telemetryFetch,
    dims: () => ({ org_id: this.ctx.id.name, surface: "slack" }),
  });
  /** Tests: the catalog events' Tinybird POST goes here instead of `fetch`. */
  telemetryFetch: typeof fetch | undefined;
  /**
   * The owed calls' emitter: a Slack item that ran out of tries is also `queue.failed` (K7), as the old
   * queue reported a job it gave up on.
   */
  private readonly owedEmit: Emitter = (event, fields, level) => {
    this.emit(event, fields, level);
    if (event !== "owed.dead" || fields?.call !== "process") return;
    // Given up: nothing will run, so a message's working status comes off.
    const job = owed.lastDead(this.sql, String(fields.group ?? "")) as Job | undefined;
    if (job && !isOther(job)) this.withdraw(job);
    const where = /^thread:([^:]+):(.*)$/.exec(String(fields.group ?? ""));
    const team = settings.get(this.sql, "slackTeamId");
    this.emit("queue.failed", {
      ...(where && team ? { session_key: sessionKey(team, where[1]!, where[2]!) } : {}),
      outcome: "failed",
      error_type: "unknown",
      attempt: fields.tries,
    }, "error");
  };
  private access?: { teamId: string; threads: ThreadAccess };
  /** Acknowledgements in flight, by `<channel>:<message ts>`: ordering only, so a withdrawal comes after its acknowledgement. */
  private readonly acking = new Map<string, Promise<void>>();
  private token?: { sealed: string; plain: string };
  private importing: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: SlackEnv) {
    super(ctx, env);
    this.sql = sqlOf(ctx.storage);
    migrate(this.sql, STEPS);
  }

  override fetch(): Response {
    return unavailable("Slack");
  }

  override async alarm(): Promise<void> {
    await this.ready();
    await alarms.run(this.sql, Date.now(), {
      owed: () => owed.run(this.sql, (call, body) => this.sendOwed(call, body), Date.now(), this.owedEmit),
    });
  }

  // ------------------------------------------------------------------ the organization

  /** The organization this object is named by. */
  protected org(): string {
    const name = this.ctx.id.name;
    if (name) {
      if (settings.get(this.sql, "org") !== name) settings.put(this.sql, "org", name);
      return name;
    }
    const stored = settings.get(this.sql, "org");
    if (!stored) throw new Error("the Slack actor does not know its organization");
    return stored;
  }

  /**
   * Every entry, `forHost` included, imports Computer's Slack install first (spec 43.1, on first
   * touch): before it this object has no team or token. Not in the team router's methods.
   */
  private async ready(): Promise<void> {
    const meta = this.sql.exec<{ imported: number }>("SELECT imported FROM meta WHERE k = 1")[0];
    if (!meta?.imported) await this.import();
    await this.repairLinks();
  }

  /**
   * Links stored as Computer's dashboard user id (`user_…`) rather than the member id (`usr_…`):
   * the import and `!link` once kept them as Computer gave them, so those people's Slack sessions
   * were owned by an id no dashboard principal has. Each is rewritten, and Org moves the sessions.
   */
  private async repairLinks(): Promise<void> {
    const raw = this.sql.exec<{ slack_user: string; member: string }>("SELECT slack_user, member FROM link WHERE member NOT LIKE 'usr\\_%' ESCAPE '\\'");
    if (raw.length === 0) return;
    const fixed = await Promise.all(raw.map(async (l) => ({ ...l, to: await memberId(l.member) })));
    this.sql.transaction(() => {
      for (const l of fixed) {
        links.put(this.sql, l.slack_user, l.to);
        owed.add(this.sql, { group: `link:${l.slack_user}`, key: `link:${l.slack_user}:${l.member}`, call: "linkPerson", body: { from: l.member, to: l.to } });
      }
    });
    this.ctx.waitUntil(this.sendOwedNow());
  }

  // ------------------------------------------------------------------ accept (40.11 step 1)

  async accept(e: { kind: "event" | "interaction"; id: string; body: unknown }): Promise<{ unlinked?: true }> {
    await this.ready();
    this.org();
    const now = Date.now();
    const teamId = settings.get(this.sql, "slackTeamId");
    if (e.kind === "event" && (!teamId || !settings.get(this.sql, "slackBotToken") || !isRecord(e.body) || e.body.team_id !== teamId)) return { unlinked: true };
    const seen = `slack:${e.kind}:${e.id}`;
    if (idem.get(this.sql, seen, e.kind)) return {};
    let job: Job | null = null;
    let threadKey: string | null = null;
    let left: string | null = null;
    if (e.kind === "interaction") {
      job = { item: "interaction", id: e.id, body: e.body };
      threadKey = `interaction:${e.id}`;
    } else {
      const parsed = parseSlackEnvelope(e.body, now);
      if (parsed.kind === "message") {
        if (parsed.job.teamId !== teamId) return { unlinked: true };
        const normalized = normalizeJob(parsed.job, settings.get(this.sql, "slackBotUserId") ?? "");
        if (normalized) {
          job = normalized;
          threadKey = `${normalized.channelId}:${normalized.threadTs}`;
        }
      } else if (parsed.kind === "member-left") {
        if (parsed.teamId === teamId) left = parsed.userId;
      } else if (parsed.kind === "stop") {
        job = { item: "stop", eventId: parsed.eventId, teamId: parsed.teamId, channelId: parsed.channelId, ...(parsed.threadTs ? { threadTs: parsed.threadTs } : {}), ...(parsed.userId ? { userId: parsed.userId } : {}) };
        threadKey = `${parsed.channelId}:${parsed.threadTs ?? ""}`;
      }
    }
    const acked = this.sql.transaction((): MessageJob | null => {
      idem.put(this.sql, seen, e.kind, null, DEDUP_TTL_MS);
      if (left) {
        // Work 077: whoever left is forgotten here, and their subscriptions go (Computer's).
        this.sql.exec("DELETE FROM people WHERE slack_user_id = ?", left);
        owed.add(this.sql, { group: `left:${left}`, key: `left:${left}`, call: "memberLeft", body: left });
      }
      if (!job) return null;
      if (isOther(job)) {
        oweProcess(this.sql, threadKey!, job);
        return null;
      }
      // Slack sends both `message` and `app_mention` for one mention, with different event ids: the first is the one.
      this.sql.exec("DELETE FROM slack_messages WHERE received_at < ?", now - DEDUP_TTL_MS);
      const fresh = this.sql.exec("INSERT OR IGNORE INTO slack_messages (message_key, received_at) VALUES (?, ?) RETURNING message_key", `${job.channelId}:${job.messageTs}`, now);
      return fresh.length ? this.oweMessage(job) : null;
    });
    if (left) this.access?.threads.forget(left);
    // The working status before the queue gets to the message, beside it, never holding it up.
    if (acked) this.startAcknowledgement(acked);
    this.ctx.waitUntil(this.sendOwedNow());
    return {};
  }

  /**
   * A message owed a `process` call, in the caller's transaction. One that will run as a turn (not a
   * `!` command; addressed to the app, or in a thread that has a session or is about to) is marked
   * `acked` and recorded in `acks`; the caller starts its working status after the transaction
   * (`startAcknowledgement`). The marked job when it is to be acknowledged, else null.
   */
  private oweMessage(job: MessageJob): MessageJob | null {
    const { acked: _acked, ackIndicator: _indicator, ...plain } = job;
    const threadKey = `${job.channelId}:${job.threadTs}`;
    const key = sessionKey(job.teamId, job.channelId, job.threadTs);
    const turn =
      !slackCommand(commandWord(commandText(job.text))) &&
      (job.mentioned || job.channelType === "im" || threads.sessionOf(this.sql, key) !== undefined || owed.pending(this.sql, processGroup(threadKey)));
    if (!turn) {
      oweProcess(this.sql, threadKey, plain);
      return null;
    }
    const marked: MessageJob = { ...plain, acked: true };
    this.sql.exec("INSERT INTO acks (thread_key, user_id, ts) VALUES (?, ?, ?) ON CONFLICT(thread_key) DO UPDATE SET user_id = excluded.user_id, ts = excluded.ts", key, job.userId, job.messageTs);
    oweProcess(this.sql, threadKey, marked);
    return marked;
  }


  /**
   * An interaction while Slack waits (a button's trigger lasts three seconds; a modal's errors keep it
   * open). The secret, variable, connection and subscription modals and their buttons are Computer's,
   * as the presser; any other interaction is accepted and queued.
   */
  async interact(id: string, body: unknown): Promise<SlackModalReply> {
    await this.ready();
    this.org();
    const interaction = isRecord(body) ? (body as SlackInteraction) : null;
    const userId = interaction?.user?.id;
    if (!interaction || !userId) return {};
    if (!computerHeld(interaction)) {
      await this.accept({ kind: "interaction", id, body });
      return {};
    }
    if (interaction.team?.id !== settings.get(this.sql, "slackTeamId")) return {};
    const actionId = interaction.actions?.[0]?.action_id ?? "";
    const p = await this.principal(userId);
    if (!p) {
      await this.respond(interaction, ONLY_MEMBERS_TEXT);
      return {};
    }
    // "Set it anyway" on a variable that looks like a credential: in its thread's session, which Computer checks the presser may write.
    let sessionId: string | undefined;
    if (actionId.startsWith("v:") && actionId.length > 2) {
      sessionId = threads.sessionOf(this.sql, actionId.slice(2));
      if (!sessionId) {
        await this.respond(interaction, sessionGoneText());
        return {};
      }
    }
    return computerOf(this.env, this.org()).interaction(p, { interaction, ...(sessionId ? { sessionId } : {}) });
  }

  /** Replaces the message a button was on, through its `response_url`. */
  private async respond(interaction: SlackInteraction, text: string): Promise<void> {
    if (!interaction.response_url) return;
    await fetch(interaction.response_url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ replace_original: true, text }) });
  }

  // ------------------------------------------------------------------ one message (40.11 steps 2 to 7)

  protected async process(job: Job): Promise<void> {
    if (isOther(job)) return this.processOther(job);
    // A message that did not become a turn (refused, not a member, ...): its working status comes off.
    if (!(await this.message(job))) this.withdraw(job);
  }

  /** A message: a command, or a turn in its thread's session. Whether SessionLog took a turn. */
  private async message(job: MessageJob): Promise<boolean> {
    const teamId = settings.get(this.sql, "slackTeamId");
    if (!teamId || teamId !== job.teamId) return false;
    const key = sessionKey(teamId, job.channelId, job.threadTs);
    const known = threads.sessionOf(this.sql, key);
    // A reply in a thread Computer ran before this actor knew threads (the carry has none) goes on as one this actor knows.
    if (!known && !job.mentioned && job.channelType !== "im" && !(job.threadTs !== job.messageTs && (await computerOf(this.env, this.org()).slackThreadRan(key)))) return false;

    const p = await this.principal(job.userId);
    if (!p) {
      if (job.mentioned || job.channelType === "im") await this.ephemeral(job, ONLY_MEMBERS_TEXT);
      return false;
    }
    this.ctx.waitUntil(this.registerPerson(job.userId).catch(() => {}));

    // A command is a call, not a turn (40.11 step 3).
    const text = commandText(job.text);
    const command = slackCommand(commandWord(text));
    if (command) {
      await this.command(command, text, job, key, known, p);
      return false;
    }

    // A message that starts a thread: the session (idempotent on its id, so a retry creates it again), then the thread recorded.
    let sid = known;
    if (!sid) {
      const prefix = /^\s*\+(claude|codex)(?=\s|$)\s*/i.exec(job.text);
      if (prefix) job = { ...job, text: job.text.slice(prefix[0].length), harness: prefix[1]!.toLowerCase() };
      sid = await sessionIdFor(key);
      const created = await orgOf(this.env, this.org()).createSession(p, {
        id: sid,
        slackThread: key,
        origin: this.origin(teamId, job.channelId, job.threadTs),
        ...(job.harness ? { harness: job.harness } : {}),
      });
      if (!created.ok) {
        console.warn(JSON.stringify({ level: "warn", event: "slack.session_refused", code: created.code }));
        return false;
      }
      threads.put(this.sql, key, sid);
    }

    // The turn.
    const above = !known && job.channelType !== "im" && job.threadTs !== job.messageTs;
    const linked = await this.linkedThreads(job, above);
    // A held message allowed to run is delivered as itself, not as context.
    this.sql.exec("DELETE FROM session_context WHERE key = ? AND ts = ?", key, job.messageTs);
    const { context, upTo } = this.heldContext(key);
    const id = await turnIdFor(key, job.messageTs);
    const body = {
      input: job.text,
      slack: {
        userId: job.userId,
        ts: job.messageTs,
        files: job.files ?? [],
        mentioned: job.mentioned || job.channelType === "im",
        context,
        linked,
      },
    };
    const result = await logOf(this.env, sid).accept(p, { id, kind: "turn", body });
    await this.afterTurn(job, key, result, upTo);
    return result.ok;
  }

  /** What SessionLog answered a turn: delivered, held (`forbidden`), or the person told. */
  protected async afterTurn(job: MessageJob, key: string, result: AcceptResult, upTo: number): Promise<void> {
    if (result.ok) return void this.sql.exec("DELETE FROM session_context WHERE key = ? AND seq <= ?", key, upTo);
    if (result.code === "inbox_full") return void (await this.ephemeral(job, INBOX_FULL_TEXT));
    if (result.code === "forbidden") return this.forbidden(job, key);
    console.warn(JSON.stringify({ level: "warn", event: "slack.turn_refused", code: result.code }));
  }

  // ------------------------------------------------------------------ commands (40.11 step 3)

  private async command(c: SlackCommand, text: string, job: MessageJob, key: string, sid: string | undefined, p: Principal): Promise<void> {
    const args = commandArgs(text);
    if (c === "stop") {
      if (!sid) return;
      const r = await logOf(this.env, sid).accept(p, { id: await entryIdFor("in", `${key}\0${job.messageTs}`), kind: "interrupt", body: {} });
      if (!r.ok) console.warn(JSON.stringify({ level: "warn", event: "slack.interrupt_refused", code: r.code }));
      return;
    }
    if (c === "access") {
      const parsed = parseAccessCommand(text);
      if (parsed.kind === "default") return this.ephemeral(job, await this.accessDefaultCommand(parsed.value, p));
      if (!sid) return this.ephemeral(job, noSessionText());
      return this.ephemeral(job, await this.accessCommand(text, sid, p));
    }
    const computer = computerOf(this.env, this.org());
    if (c === "link") {
      const r = await computer.command(p, { name: "link", args });
      if (r.member) {
        const from = `slack:${job.teamId}:${job.userId}`;
        // Computer names the person by their dashboard user id; Org and the dashboard by the member id.
        const to = await asMember(r.member);
        this.sql.transaction(() => {
          links.put(this.sql, job.userId, to);
          owed.add(this.sql, { group: `link:${job.userId}`, key: `link:${job.userId}`, call: "linkPerson", body: { from, to } });
        });
        this.ctx.waitUntil(this.sendOwedNow());
      }
      return this.ephemeral(job, r.reply);
    }
    const r = await computer.command(p, { name: c, args, ...(sid ? { sessionId: sid } : {}) });
    if (r.reply) await this.ephemeral(job, r.reply);
  }

  /** `!access`: the state line, or `thread.writers` with the list asked for; Org decides who may. */
  private async accessCommand(text: string, sid: string, p: Principal): Promise<string> {
    const parsed = parseAccessCommand(text);
    if (parsed.kind === "usage" || parsed.kind === "default") return ACCESS_USAGE;
    const session = await this.sessionOf(sid);
    if (!session) return noSessionText();
    const owner = this.slackIdOf(session.owner);
    if (parsed.kind === "show") return stateText(owner, this.shownWriters(session.writers, session.owner));
    let writers: "members" | string[];
    if (parsed.kind === "set") writers = parsed.people === "members" ? "members" : [`user:${session.owner}`, ...parsed.people.map((id) => this.byOfSlack(id))];
    else if (session.writers === "members") return listIsOpenText();
    else {
      const named = parsed.ids.map((id) => this.byOfSlack(id));
      writers = parsed.kind === "add" ? [...session.writers, ...named] : session.writers.filter((by) => !named.includes(by));
    }
    if (writers !== "members") writers = [...new Set(writers)];
    const reply = await orgOf(this.env, this.org()).mutate(p, { name: "thread.writers", args: { sid, writers } });
    if ("error" in reply) return reply.error.code === "refused" || reply.error.code === "forbidden" ? onlyGrantorChangesText(owner) : `That did not work (${reply.error.code}).`;
    return stateText(owner, this.shownWriters(writers, session.owner));
  }

  /** `!access default open|owner`: Org keeps it and decides who may (admins). */
  private async accessDefaultCommand(value: "open" | "owner", p: Principal): Promise<string> {
    const reply = await orgOf(this.env, this.org()).setSlackAccessDefault(p, value);
    if (!reply.ok) return reply.code === "admin_required" ? onlyAdminDefaultText() : `That did not work (${reply.code}).`;
    return defaultSetText(reply.value);
  }

  /** Who owns a session and who may write it, read as the platform (the requester may not see it). */
  private async sessionOf(sid: string): Promise<{ owner: string; writers: "members" | string[] } | null> {
    const access = await orgOf(this.env, this.org()).access(sid);
    if (!access) return null;
    // Org's writers less the agents it adds (the session that started it, its track's agent).
    const writers = access.writers === "members" ? "members" : access.writers.filter((by) => !access.agents?.includes(by));
    return { owner: access.owner, writers };
  }

  /** A Slack person's `by`, as their principal would have it. */
  private byOfSlack(slackUser: string): string {
    return `user:${links.memberOf(this.sql, slackUser) ?? `slack:${settings.get(this.sql, "slackTeamId") ?? ""}:${slackUser}`}`;
  }

  /** A subject (or `user:` by) as Slack can mention it: a Slack id when there is one, else the subject. */
  private slackIdOf(subject: string): string {
    const s = subject.startsWith("user:") ? subject.slice(5) : subject;
    const slack = /^slack:[^:]+:([A-Z0-9]+)$/.exec(s);
    if (slack) return slack[1]!;
    return this.sql.exec<{ slack_user: string }>("SELECT slack_user FROM link WHERE member = ? LIMIT 1", s)[0]?.slack_user ?? s;
  }

  private shownWriters(writers: "members" | string[], owner: string): "members" | string[] {
    return writers === "members" ? writers : writers.filter((by) => by !== `user:${owner}` && by.startsWith("user:")).map((by) => this.slackIdOf(by));
  }

  // ------------------------------------------------------------------ held context and the access request

  /** A refused turn: the message held as context, and the owner asked once (with Allow and Not now). */
  protected async forbidden(job: MessageJob, key: string): Promise<void> {
    const now = Date.now();
    this.sql.exec(
      "INSERT OR IGNORE INTO session_context (key, user_id, ts, text, files, at) VALUES (?, ?, ?, ?, ?, ?)",
      key,
      job.userId,
      job.messageTs,
      job.text.slice(0, CONTEXT_MAX_CHARS),
      job.files?.length ? JSON.stringify(job.files.map((f) => f.name ?? f.id)) : null,
      now,
    );
    if (!job.mentioned && job.channelType !== "im") return;
    const sid = threads.sessionOf(this.sql, key);
    const session = sid ? await this.sessionOf(sid) : null;
    const owner = session ? this.slackIdOf(session.owner) : "";
    const added = this.sql.exec("INSERT OR IGNORE INTO access_requests (key, user_id, state, message_ts, held, at) VALUES (?, ?, 'open', '', ?, ?) RETURNING 1", key, job.userId, JSON.stringify(job), now).length > 0;
    if (!added) return this.ephemeral(job, ownerDecidesText(owner));
    const posted = await this.slack("chat.postMessage", { channel: job.channelId, thread_ts: job.threadTs, ...requestPost(key, owner, job.userId) });
    if (!posted.ok || !posted.ts) {
      this.sql.exec("DELETE FROM access_requests WHERE key = ? AND user_id = ?", key, job.userId);
      throw new Error(`the access request was not posted: ${posted.error ?? "no ts"}`);
    }
    this.sql.exec("UPDATE access_requests SET message_ts = ? WHERE key = ? AND user_id = ?", posted.ts, key, job.userId);
    await this.ephemeral(job, requestSentText(owner));
  }

  /** The messages held for a thread since its last turn, newest CONTEXT_MAX_ROWS, oldest first; `upTo`: the last row's seq. */
  protected heldContext(key: string): { context: Linked[]; upTo: number } {
    this.sql.exec("DELETE FROM session_context WHERE key = ? AND at < ?", key, Date.now() - CONTEXT_MAX_AGE_MS);
    const total = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM session_context WHERE key = ?", key)[0]?.n ?? 0;
    const rows = this.sql
      .exec<{ seq: number; userId: string; ts: string; text: string; files: string | null }>(
        "SELECT seq, user_id AS userId, ts, text, files FROM session_context WHERE key = ? ORDER BY seq DESC LIMIT ?",
        key,
        CONTEXT_MAX_ROWS,
      )
      .reverse();
    if (!rows.length) return { context: [], upTo: 0 };
    const skipped = total - rows.length;
    const messages = rows.map((r, i) => {
      const files = r.files ? (JSON.parse(r.files) as string[]) : [];
      return { name: `<@${r.userId}>`, ts: r.ts, text: r.text, ...(files.length ? { files } : {}), ...(i === 0 && skipped > 0 ? { skipped } : {}) };
    });
    return { context: [{ url: "", ok: true, where: "", context: true, messages }], upTo: rows[rows.length - 1]!.seq };
  }

  // ------------------------------------------------------------------ stop and buttons

  protected async processOther(job: OtherJob): Promise<void> {
    if (job.item === "stop") return this.stopPressed(job);
    const interaction = typeof job.body === "string" ? parseInteraction(job.body) : isRecord(job.body) ? (job.body as SlackInteraction) : null;
    const actionId = interaction?.actions?.[0]?.action_id ?? "";
    const userId = interaction?.user?.id;
    if (!interaction || !userId) return;
    if (actionId.startsWith("ac:")) return this.accessPressed(interaction, actionId, userId);
    const prompt = decodeCalvinActionId(actionId);
    if (prompt) return this.promptPressed(job.id, interaction, prompt, userId);
    console.warn(JSON.stringify({ level: "warn", event: "slack.interaction_unsupported", type: interaction.type ?? null, action: actionId.split(":")[0] ?? "" }));
  }

  /** Slack's stop button on a working thread: an interrupt, as the presser (or the platform when Slack does not say who). */
  private async stopPressed(job: Extract<OtherJob, { item: "stop" }>): Promise<void> {
    const teamId = settings.get(this.sql, "slackTeamId");
    if (!teamId || teamId !== job.teamId || !job.threadTs) return;
    const sid = threads.sessionOf(this.sql, sessionKey(teamId, job.channelId, job.threadTs));
    if (!sid) return;
    const p = job.userId ? await this.principal(job.userId) : platformPrincipal(this.org());
    if (!p) return;
    const r = await logOf(this.env, sid).accept(p, { id: await entryIdFor("in", job.eventId), kind: "interrupt", body: {} });
    if (!r.ok) console.warn(JSON.stringify({ level: "warn", event: "slack.interrupt_refused", code: r.code }));
  }

  /** A prompt's button: an `answer` naming the ask, or a `dismiss` for the value `dismiss`. */
  private async promptPressed(id: string, interaction: SlackInteraction, prompt: { sessionKey: string; promptId: string; value: string }, userId: string): Promise<void> {
    const sid = threads.sessionOf(this.sql, prompt.sessionKey);
    const where = this.whereOf(interaction, userId, prompt.sessionKey);
    if (!sid || !where) return;
    const p = await this.principal(userId);
    if (!p) return this.ephemeral(where, ONLY_MEMBERS_TEXT);
    const entry =
      prompt.value === "dismiss"
        ? { id: await entryIdFor("ds", id), kind: "dismiss" as const, body: { askId: prompt.promptId } }
        : { id: await entryIdFor("an", id), kind: "answer" as const, body: { askId: prompt.promptId, answer: { value: prompt.value } } };
    const r = await logOf(this.env, sid).accept(p, entry);
    if (r.ok) return;
    if (r.code === "forbidden") return this.ephemeral(where, notAskedText());
    if (r.code === "inbox_full") return this.ephemeral(where, INBOX_FULL_TEXT);
    console.warn(JSON.stringify({ level: "warn", event: "slack.answer_refused", code: r.code }));
  }

  /** A request's Allow (`thread.writers` with the requester added; their held message runs) or Not now. */
  private async accessPressed(interaction: SlackInteraction, actionId: string, userId: string): Promise<void> {
    const decoded = decodeAccessId(actionId);
    const where = decoded && this.whereOf(interaction, userId, decoded.sessionKey);
    if (!decoded || !where) return;
    const { sessionKey: key, verb, userId: requester } = decoded;
    const sid = threads.sessionOf(this.sql, key);
    const request = this.sql.exec<{ state: string; messageTs: string; held: string }>(
      "SELECT state, message_ts AS messageTs, held FROM access_requests WHERE key = ? AND user_id = ?",
      key,
      requester,
    )[0];
    if (!sid || request?.state !== "open") return;
    const session = await this.sessionOf(sid);
    if (!session) return;
    const owner = this.slackIdOf(session.owner);
    const p = await this.principal(userId);
    if (!p) return this.ephemeral(where, ONLY_MEMBERS_TEXT);
    if (verb === "deny") {
      if (p.subject !== session.owner) return this.ephemeral(where, onlyGrantorAnswersText(owner));
    } else if (session.writers !== "members") {
      const writers = [...new Set([...session.writers, this.byOfSlack(requester)])];
      const reply = await orgOf(this.env, this.org()).mutate(p, { name: "thread.writers", args: { sid, writers } });
      if ("error" in reply) return this.ephemeral(where, reply.error.code === "refused" || reply.error.code === "forbidden" ? onlyGrantorAnswersText(owner) : `That did not work (${reply.error.code}).`);
    }
    const closed = this.sql.exec("UPDATE access_requests SET state = 'closed' WHERE key = ? AND user_id = ? AND state = 'open' RETURNING 1", key, requester).length > 0;
    if (!closed) return;
    if (verb === "allow") {
      // The held message runs, in its thread's order.
      // Its working status came off when it was held: it starts again.
      const acked = this.sql.transaction(() => this.oweMessage(JSON.parse(request.held) as MessageJob));
      if (acked) this.startAcknowledgement(acked);
      this.ctx.waitUntil(this.sendOwedNow());
    }
    if (request.messageTs) await this.slack("chat.update", { channel: where.channelId, ts: request.messageTs, ...answeredPost(verb === "allow" ? grantedText(userId, requester) : declinedText(requester)) });
  }

  /** Where an interaction's answers go: its channel and thread. */
  private whereOf(interaction: SlackInteraction, userId: string, key: string): { userId: string; channelId: string; threadTs?: string } | null {
    const parsed = parseSessionKey(key);
    const channelId = interaction.channel?.id ?? interaction.container?.channel_id ?? parsed?.channelId;
    if (!channelId) return null;
    const threadTs = interaction.container?.thread_ts ?? parsed?.threadTs;
    return { userId, channelId, ...(threadTs ? { threadTs } : {}) };
  }

  // ------------------------------------------------------------------ owed calls

  protected async sendOwed(call: string, body: unknown): Promise<void> {
    if (call === "process") return this.process(body as Job);
    if (call === "linkPerson") {
      const { from, to } = body as { from: string; to: string };
      return orgOf(this.env, this.org()).linkPerson(from, to);
    }
    if (call === "changed") return computerOf(this.env, this.org()).changed("slack");
    if (call === "memberLeft") return computerOf(this.env, this.org()).memberLeft(body as string);
    if (call === "post") {
      const { method, body: args } = body as { method: string; body: Record<string, unknown> };
      const result = await this.slack(method, args);
      // Rate limited: tried again on the post schedule, not before Slack's Retry-After; other refusals are final.
      if (slackRateLimited(result)) throw new RetryAfter(`${method}: ${result.error}`, result.retryAfterMs ?? 0);
      return;
    }
    console.warn(JSON.stringify({ level: "warn", event: "slack.owed_unknown", call }));
  }

  private sendOwedNow(): Promise<void> {
    return owed.run(this.sql, (call, body) => this.sendOwed(call, body), Date.now(), this.owedEmit).catch((error: unknown) => console.warn(JSON.stringify({ level: "warn", event: "slack.owed_failed", message: errorText(error) })));
  }

  // ------------------------------------------------------------------ the person (34.3)

  async api(method: string, body: Record<string, unknown>): Promise<SlackResult> {
    await this.ready();
    return this.slack(method, body);
  }

  async userName(slackUser: string): Promise<string> {
    await this.ready();
    return this.threadAccess().name(slackUser);
  }

  /** The person's principal, or null when Slack does not report them as a member of the workspace. Throws when Slack could not be asked. */
  async principal(slackUser: string): Promise<Principal | null> {
    await this.ready();
    const teamId = settings.get(this.sql, "slackTeamId") ?? "";
    if (!(await this.threadAccess().member(slackUser))) return null;
    const member = links.memberOf(this.sql, slackUser);
    const subject = member ?? `slack:${teamId}:${slackUser}`;
    return {
      org: this.org(),
      subject,
      kind: "member",
      via: "slack",
      scopes: [...MEMBER_SCOPES],
      audiences: member ? ["org", `member:${member}`] : [],
      admin: false,
      credential: { id: `slack:${teamId}:${slackUser}`, expiresAt: null },
    };
  }

  private origin(teamId: string, channelId: string, threadTs: string): Origin {
    return { type: "slack", client: null, slack: { teamId, channelId, channelName: null, threadTs, url: slackThreadUrl(teamId, channelId, threadTs) } };
  }

  // ------------------------------------------------------------------ people and credentials

  async forHost(): ReturnType<SlackRpc["forHost"]> {
    await this.ready();
    const teamId = settings.get(this.sql, "slackTeamId");
    const botToken = await this.botToken();
    if (!teamId || !botToken) return { people: this.people(), slack: null };
    const teamName = settings.get(this.sql, "slackTeamName");
    const installer = settings.get(this.sql, "slackInstallerUserId");
    return {
      people: this.people(),
      slack: {
        botToken,
        botUserId: settings.get(this.sql, "slackBotUserId") ?? "",
        teamId,
        ...(teamName ? { teamName } : {}),
        ...(installer ? { installer: { slackUser: installer, member: links.memberOf(this.sql, installer) ?? null } } : {}),
      },
    };
  }

  protected people(): CalvinPerson[] {
    return this.sql
      .exec<{ slackUserId: string; dir: string; gitName: string; gitEmail: string }>(
        "SELECT slack_user_id AS slackUserId, dir, git_name AS gitName, git_email AS gitEmail FROM people ORDER BY slack_user_id",
      )
      .map((row) => {
        const member = links.memberOf(this.sql, row.slackUserId);
        return { ...row, ...(member ? { userId: member } : {}) };
      });
  }

  /**
   * A person and their git identity, from Slack, as Computer recorded them. A row missing the name
   * or email is asked again at most once an hour. A change tells the organization's machine.
   */
  private async registerPerson(slackUserId: string): Promise<void> {
    const existing = this.sql.exec<{ gitName: string; gitEmail: string; updatedAt: number }>(
      "SELECT git_name AS gitName, git_email AS gitEmail, updated_at AS updatedAt FROM people WHERE slack_user_id = ?",
      slackUserId,
    )[0];
    if (existing) {
      const complete = existing.gitName !== COMPUTER_GIT_NAME && existing.gitEmail !== noReplyGitEmail(slackUserId) && !/^Slack [A-Z0-9]+$/.test(existing.gitName);
      if (complete || Date.now() - existing.updatedAt < 60 * 60_000) return;
    }
    const r = await this.slack("users.info", { user: slackUserId });
    const u = r.ok ? r.user : undefined;
    if (!u && existing) {
      this.sql.exec("UPDATE people SET updated_at = ? WHERE slack_user_id = ?", Date.now(), slackUserId);
      return;
    }
    const person = personFor(slackUserId, { name: u?.real_name || u?.profile?.real_name || u?.profile?.display_name || u?.name || undefined, email: u?.profile?.email });
    this.sql.exec(
      `INSERT INTO people (slack_user_id, dir, git_name, git_email, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (slack_user_id) DO UPDATE SET git_name = excluded.git_name, git_email = excluded.git_email, updated_at = excluded.updated_at`,
      person.slackUserId,
      person.dir,
      person.gitName,
      person.gitEmail,
      Date.now(),
    );
    if (existing?.gitName !== person.gitName || existing?.gitEmail !== person.gitEmail) await computerOf(this.env, this.org()).changed("slack");
  }

  // ------------------------------------------------------------------ Slack's Web API

  protected async botToken(): Promise<string> {
    const teamId = settings.get(this.sql, "slackTeamId");
    const sealed = settings.get(this.sql, "slackBotToken");
    if (!teamId || !sealed) return "";
    if (this.token?.sealed === sealed) return this.token.plain;
    try {
      const plain = await unseal(sealed, this.env.BLUE_CHANNEL_ENCRYPTION_KEY, "slack-bot-token", `${this.org()}\0${teamId}`);
      this.token = { sealed, plain };
      return plain;
    } catch {
      console.error(JSON.stringify({ level: "error", event: "slack.token_undecryptable" }));
      return "";
    }
  }

  protected async slack(method: string, body: Record<string, unknown>): Promise<SlackResult> {
    const token = await this.botToken();
    if (!token) return { ok: false, error: "not_linked" };
    return slackApi(token, method, body);
  }

  protected threadAccess(): ThreadAccess {
    const teamId = settings.get(this.sql, "slackTeamId") ?? "";
    if (this.access?.teamId !== teamId) this.access = { teamId, threads: new ThreadAccess((method, body) => this.slack(method, body), teamId) };
    return this.access.threads;
  }

  /** An answer only the person sees: in the thread they wrote in, else at the top level. */
  protected async ephemeral(where: { userId: string; channelId: string; threadTs?: string; messageTs?: string }, text: string): Promise<void> {
    const inThread = where.threadTs && where.threadTs !== where.messageTs ? { thread_ts: where.threadTs } : {};
    await this.slack("chat.postEphemeral", { channel: where.channelId, user: where.userId, text, ...inThread });
  }

  /**
   * A message's working status, started off the caller's path when it is owed (`oweMessage`), once:
   * a retried `process` does not start it again. `withdraw` (the turn did not run) and `notify` (Org's
   * echo of a refused one) take it off.
   */
  private startAcknowledgement(job: MessageJob): void {
    const at = `${job.channelId}:${job.messageTs}`;
    const ack = this.acknowledge(job, sessionKey(job.teamId, job.channelId, job.threadTs))
      .catch((error: unknown) => console.warn(JSON.stringify({ level: "warn", event: "slack.ack_failed", message: errorText(error) })))
      .finally(() => {
        if (this.acking.get(at) === ack) this.acking.delete(at);
      });
    this.acking.set(at, ack);
    this.ctx.waitUntil(ack);
  }

  /**
   * An acknowledged message that will not run as a turn: once its acknowledgement settled, the status
   * and 👀 come off, owed in its thread's post order. Off the caller's path; never throws.
   */
  private withdraw(job: MessageJob): void {
    if (!job.acked) return;
    const key = sessionKey(job.teamId, job.channelId, job.threadTs);
    const pending = this.acking.get(`${job.channelId}:${job.messageTs}`) ?? Promise.resolve();
    this.ctx.waitUntil(
      pending.then(async () => {
        this.sql.transaction(() => this.oweAckOff(key, job.messageTs));
        await owed.run(this.sql, (call, body) => this.sendOwed(call, body), Date.now(), this.owedEmit, postGroup(key));
      }).catch((error: unknown) => console.warn(JSON.stringify({ level: "warn", event: "slack.owed_failed", message: errorText(error) }))),
    );
  }

  /** In the caller's transaction: the thread's status cleared and, with `ts`, 👀 off that message (its `acks` row gone), owed in the thread's post order. */
  private oweAckOff(key: string, ts: string | undefined): void {
    const where = parseSessionKey(key);
    if (!where) return;
    owePost(this.sql, key, "agents.sessions.setStatus", { channel_id: where.channelId, thread_ts: where.threadTs, status: "" });
    if (!ts) return;
    owePost(this.sql, key, "reactions.remove", { channel: where.channelId, timestamp: ts, name: "eyes" });
    this.sql.exec("DELETE FROM acks WHERE thread_key = ? AND ts = ?", key, ts);
  }

  /** The working status on the thread, or 👀 where that is unavailable. */
  private async acknowledge(job: MessageJob, key: string): Promise<void> {
    const started = Date.now();
    let indicator = "status";
    let result = await this.slack("agents.sessions.setStatus", { channel_id: job.channelId, thread_ts: job.threadTs, status: "processing", initiator_user_id: job.userId });
    if (!result.ok) {
      indicator = "reaction";
      result = await this.slack("reactions.add", { channel: job.channelId, timestamp: job.messageTs, name: "eyes" });
    }
    // K1: Slack's time for the message → the indicator confirmed.
    const sentAt = job.trace?.sentAt ?? slackTsMs(job.messageTs);
    this.emit("ack.done", {
      session_key: key,
      ...(job.trace?.id ? { trace_id: job.trace.id } : {}),
      ...(Number.isFinite(sentAt) ? { duration_ms: Math.max(0, Date.now() - sentAt) } : {}),
      outcome: result.ok ? "completed" : "failed",
      ...(result.ok ? {} : { error_type: "surface_error" }),
      indicator,
      call_ms: Date.now() - started,
    });
  }

  /**
   * Threads linked in a message, and with `above` the replies above it in its own thread, read under
   * today's rule for the poster (the thread they are read into is checked too), at most 10 s.
   */
  private async linkedThreads(job: MessageJob, above: boolean): Promise<Linked[]> {
    const forwarded = forwardedLinked(job.forwarded);
    const found = findThreadLinks(job.text);
    if (!found.length && !above) return forwarded;
    const audience = { owner: job.userId, poster: job.userId, destination: job.channelId, deadline: Date.now() + LINK_TIMEOUT_MS };
    const late = "reading it took too long; ask again to retry";
    const here = { url: "", channel: job.channelId, ts: job.messageTs, threadTs: job.threadTs };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<Linked[]>((resolve) => {
      timer = setTimeout(
        () => resolve([...(above ? [{ url: "", ok: false as const, reason: late, here: true }] : []), ...found.map((link) => ({ url: link.url, ok: false as const, reason: late }))]),
        LINK_TIMEOUT_MS,
      );
    });
    const reading = Promise.all([
      above ? this.threadAccess().read(here, audience, job.messageTs).then((l): Linked[] => [{ ...l, here: true }]) : [],
      this.threadAccess().resolve(job.text, audience),
    ]).then((r) => r.flat());
    const linked = await Promise.race([reading, timedOut]).finally(() => clearTimeout(timer));
    return [...forwarded, ...linked];
  }

  // ------------------------------------------------------------------ the rest of SlackRpc (slices 2 and 3)


  /** A child of a Slack thread's session: its brief posted at the top level of the parent's channel, once, and that thread recorded as the child's. */
  async announce(child: { sessionId: string; parent: string; brief: string }): Promise<{ threadKey: string }> {
    await this.ready();
    this.org();
    return announce(this.sql, (method, body) => this.slack(method, body), child);
  }

  /**
   * What Org's echo described (36.6): a refused turn's reason, or the machine's notice; the status and 👀 come off.
   * Each Slack call is owed in its thread's order (`post`), so a rate-limited one is tried again, then dead-listed.
   */
  async notify(e: SlackEcho): Promise<void> {
    await this.ready();
    this.org();
    this.sql.transaction(() => this.noticesOf(e));
    const keys = e.kind === "machine" ? e.threadKeys : [e.threadKey];
    await Promise.all(
      keys.map((key) =>
        owed
          .run(this.sql, (call, body) => this.sendOwed(call, body), Date.now(), this.owedEmit, postGroup(key))
          .catch((error: unknown) => console.warn(JSON.stringify({ level: "warn", event: "slack.owed_failed", message: errorText(error) }))),
      ),
    );
  }

  /** `notify`'s once-only rows and the Slack calls it owes, in one transaction. */
  private noticesOf(e: SlackEcho): void {
    if (e.kind === "machine") {
      if (e.state === "ready") {
        for (const key of e.threadKeys) this.sql.exec("DELETE FROM notices WHERE thread_key = ?", key);
        return;
      }
      const notice = e.state === "waking" ? WAKING_NOTICE : e.state === "provisioning" ? STARTING_NOTICE : e.state === "failed" ? FAILED_NOTICE : e.state === "parked" ? OFFLINE_NOTICE : null;
      if (!notice) return;
      for (const key of e.threadKeys) {
        const where = parseSessionKey(key);
        if (!where || this.sql.exec("INSERT OR IGNORE INTO notices (thread_key, kind) VALUES (?, ?) RETURNING 1", key, e.state).length === 0) continue;
        owePost(this.sql, key, "chat.postMessage", { channel: where.channelId, thread_ts: where.threadTs, text: notice });
      }
      return;
    }
    const where = parseSessionKey(e.threadKey);
    if (!where) return;
    const person = this.slackIdOf(e.person);
    // insufficient_credits: the paywall is Computer's to owe (`billing`), with the plan and halt reason; here only the status and 👀 come off.
    if (e.code === "computer_unavailable") {
      owePost(this.sql, e.threadKey, "chat.postMessage", { channel: where.channelId, thread_ts: where.threadTs, text: UNREACHABLE_TEXT });
    } else if (e.code !== "insufficient_credits" && /^[UW][A-Z0-9]+$/.test(person)) {
      owePost(this.sql, e.threadKey, "chat.postEphemeral", { channel: where.channelId, user: person, thread_ts: where.threadTs, text: e.code === "model_refused" ? REFUSED_TEXT : `${REFUSED_TEXT} (${e.code})` });
    }
    this.oweAckOff(e.threadKey, this.sql.exec<{ ts: string }>("SELECT ts FROM acks WHERE thread_key = ?", e.threadKey)[0]?.ts);
  }

  async billing(n: BillingNotice): Promise<BillingNoticeResult> {
    await this.ready();
    this.org();
    if (!(await this.botToken())) return "known";
    return tellBilling(
      {
        sql: this.sql,
        slack: (method, body) => this.slack(method, body),
        origin: this.publicOrigin(),
        teamId: settings.get(this.sql, "slackTeamId") ?? "",
        installer: settings.get(this.sql, "slackInstallerUserId"),
        threadOf: (sessionId) => threads.keyOf(this.sql, sessionId),
      },
      n,
    );
  }

  /** `post_thread`: a message in a session's Slack thread, for whoever may read the session. */
  async post(p: Principal, threadKey: string, text: string): Promise<Reply<{ ts: string }>> {
    await this.ready();
    this.org();
    const sid = threads.sessionOf(this.sql, threadKey);
    const where = parseSessionKey(threadKey);
    if (!sid || !where) return { ok: false, code: "not_found", status: 404 };
    const readable = await orgOf(this.env, this.org()).getSession(p, sid);
    if (!readable.ok) return { ok: false, code: "not_found", status: 404 };
    const posted = await this.slack("chat.postMessage", { channel: where.channelId, thread_ts: where.threadTs, text: neutralizeBroadcasts(text).slice(0, MAX_POST_CHARS) });
    if (!posted.ok || !posted.ts) return { ok: false, code: "unavailable", status: 503 };
    if (p.session !== sid) this.wakeThread(p, where, readable.session, neutralizeBroadcasts(text).slice(0, MAX_POST_CHARS), posted.ts);
    return { ok: true, ts: posted.ts };
  }

  /**
   * A post into another session's thread reaches that session as its owner's message (Slack's copy is
   * the app's, which accept drops): queued like a typed one, so it goes through the inbox as any Slack
   * turn. The first line says where it came from, and keeps the text from reading as a `!` command or a
   * `+tier` run with the owner's authority.
   */
  private wakeThread(p: Principal, where: { channelId: string; threadTs: string }, session: unknown, body: string, ts: string): void {
    const teamId = settings.get(this.sql, "slackTeamId");
    const owner = isRecord(session) && isRecord(session.owner) && typeof session.owner.id === "string" ? this.slackIdOf(session.owner.id) : undefined;
    if (!teamId || !owner || !/^[UW][A-Z0-9]+$/.test(owner)) return;
    const from = p.session ? threads.keyOf(this.sql, p.session) : undefined;
    const fromWhere = from ? parseSessionKey(from) : null;
    const source = fromWhere ? slackThreadUrl(teamId, fromWhere.channelId, fromWhere.threadTs) : null;
    const job: MessageJob = {
      eventId: `post_thread:${where.channelId}:${ts}`,
      teamId,
      channelId: where.channelId,
      threadTs: where.threadTs,
      messageTs: ts,
      userId: owner,
      text: `Posted here for <@${owner}> by the session in ${source ? `<${source}|another thread>` : "another thread"}:\n${body}`,
      mentioned: false,
      channelType: "channel",
      receivedAt: Date.now(),
    };
    const acked = this.sql.transaction(() => this.oweMessage(job));
    if (acked) this.startAcknowledgement(acked);
    this.ctx.waitUntil(this.sendOwedNow());
  }

  // ------------------------------------------------------------------ the install (moved from Computer)

  /** The workspace linked: its settings and sealed bot token; the installer linked to the person who installed; the host told. */
  async install(p: Principal, grant: SlackGrant): Promise<void> {
    await this.ready();
    const org = this.org();
    this.mayInstall(p);
    const sealed = await seal(grant.botToken, this.env.BLUE_CHANNEL_ENCRYPTION_KEY, "slack-bot-token", `${org}\0${grant.teamId}`);
    this.sql.transaction(() => {
      if (settings.get(this.sql, "slackTeamId") !== grant.teamId) this.sql.exec("DELETE FROM join_requests");
      settings.put(this.sql, "slackTeamId", grant.teamId);
      settings.put(this.sql, "slackTeamName", grant.teamName);
      settings.put(this.sql, "slackBotUserId", grant.botUserId);
      settings.put(this.sql, "slackBotToken", sealed);
      if (grant.installerUserId) settings.put(this.sql, "slackInstallerUserId", grant.installerUserId);
      else settings.drop(this.sql, "slackInstallerUserId");
      // The installer approved the install as this member: their Slack sessions are theirs.
      if (grant.installerUserId && p.subject.startsWith("usr_")) {
        links.put(this.sql, grant.installerUserId, p.subject);
        owed.add(this.sql, { group: `link:${grant.installerUserId}`, key: `link:${grant.installerUserId}`, call: "linkPerson", body: { from: `slack:${grant.teamId}:${grant.installerUserId}`, to: p.subject } });
      }
      owed.add(this.sql, { group: "changed", key: "changed:slack", call: "changed", body: "slack" });
    });
    this.token = undefined;
    this.access = undefined;
    await this.sendOwedNow();
  }

  /** The bot token and the workspace's settings go; the app stays installed in Slack until removed there. */
  async unlink(p: Principal): Promise<void> {
    await this.ready();
    this.org();
    this.mayInstall(p);
    this.forget();
    await this.sendOwedNow();
  }

  private mayInstall(p: Principal): void {
    if (p.org !== this.org() || (p.kind !== "member" && p.kind !== "key" && p.kind !== "platform")) throw new Error("forbidden: only a member of the organization links Slack");
  }

  private forget(): void {
    this.sql.transaction(() => {
      for (const key of ["slackTeamId", "slackTeamName", "slackBotUserId", "slackBotToken", "slackInstallerUserId"]) settings.drop(this.sql, key);
      this.sql.exec("DELETE FROM join_requests");
      owed.add(this.sql, { group: "changed", key: "changed:slack", call: "changed", body: "slack" });
    });
    this.token = undefined;
    this.access = undefined;
  }

  async startInstall(p: Principal, nonce: string): Promise<void> {
    await this.ready();
    this.org();
    this.mayInstall(p);
    const now = Date.now();
    this.sql.exec("DELETE FROM install_nonces WHERE expires_at < ?", now);
    this.sql.exec("INSERT INTO install_nonces (nonce_hash, user_id, expires_at) VALUES (?, ?, ?)", await sha256Hex(nonce), p.subject, now + INSTALL_NONCE_TTL_MS);
  }

  async consumeInstall(nonce: string): Promise<{ ok: true; subject: string } | { ok: false; reason: "invalid_state" | "state_expired" }> {
    await this.ready();
    const hash = await sha256Hex(nonce);
    const row = this.sql.exec<{ subject: string; expiresAt: number }>("SELECT user_id AS subject, expires_at AS expiresAt FROM install_nonces WHERE nonce_hash = ?", hash)[0];
    if (!row) return { ok: false, reason: "invalid_state" };
    this.sql.exec("DELETE FROM install_nonces WHERE nonce_hash = ?", hash);
    if (row.expiresAt < Date.now()) return { ok: false, reason: "state_expired" };
    return { ok: true, subject: row.subject };
  }

  async unlinkRevoked(teamId: string): Promise<{ unlinked: boolean }> {
    await this.ready();
    if (settings.get(this.sql, "slackTeamId") !== teamId || !settings.get(this.sql, "slackBotToken")) return { unlinked: false };
    const answer = await this.slack("auth.test", {});
    if (!slackTokenDead(answer)) return { unlinked: false };
    this.forget();
    await this.sendOwedNow();
    console.log(JSON.stringify({ level: "info", event: "slack.revoked_unlinked", teamId, error: answer.error }));
    return { unlinked: true };
  }

  async joinRequest(teamId: string, requesterUserId: string): Promise<{ installerNotified: boolean }> {
    await this.ready();
    if (settings.get(this.sql, "slackTeamId") !== teamId || !settings.get(this.sql, "slackBotToken")) return { installerNotified: false };
    const now = Date.now();
    this.sql.exec("DELETE FROM join_requests WHERE notified_at < ?", now - JOIN_REQUEST_INTERVAL_MS);
    const earlier = this.sql.exec<{ notified: number }>("SELECT installer_notified AS notified FROM join_requests WHERE slack_user_id = ?", requesterUserId)[0];
    if (earlier) return { installerNotified: earlier.notified === 1 };
    const installerUserId = settings.get(this.sql, "slackInstallerUserId") ?? null;
    const origin = this.publicOrigin();
    const messages = joinRequestMessages({ requesterUserId, installerUserId, settingsUrl: `${origin}/settings` });
    const requesterSent = await this.directMessage(requesterUserId, messages.requester);
    const installerNotified = installerUserId && messages.installer ? await this.directMessage(installerUserId, messages.installer) : false;
    if (requesterSent || installerNotified) {
      this.sql.exec(
        "INSERT INTO join_requests (slack_user_id, installer_notified, notified_at) VALUES (?, ?, ?) ON CONFLICT(slack_user_id) DO UPDATE SET installer_notified = excluded.installer_notified, notified_at = excluded.notified_at",
        requesterUserId,
        installerNotified ? 1 : 0,
        now,
      );
    }
    return { installerNotified };
  }

  /** The app's public origin, for links. */
  private publicOrigin(): string {
    return (this.env.COMPUTER_PUBLIC_ORIGIN || this.env.OPENCOMPUTER_APP_URL || "https://app.opencomputer.dev").replace(/\/+$/, "");
  }

  private async directMessage(userId: string, text: string): Promise<boolean> {
    const opened = await this.slack("conversations.open", { users: userId });
    const channel = opened.ok ? opened.channel?.id : undefined;
    const posted = channel ? await this.slack("chat.postMessage", { channel, text }) : opened;
    return posted.ok;
  }

  // ------------------------------------------------------------------ the team router (`slack-team:<teamId>`)

  async claimTeam(teamId: string, org: string): Promise<{ ok: true } | { ok: false; holder: string }> {
    const holder = settings.get(this.sql, "teamLinkOrg");
    if (holder && holder !== org) return { ok: false, holder };
    settings.put(this.sql, "teamLinkTeamId", teamId);
    settings.put(this.sql, "teamLinkOrg", org);
    return { ok: true };
  }

  async teamOrg(): Promise<string | null> {
    return settings.get(this.sql, "teamLinkOrg") ?? null;
  }

  async releaseTeam(org: string): Promise<void> {
    if (settings.get(this.sql, "teamLinkOrg") !== org) return;
    settings.drop(this.sql, "teamLinkOrg");
    settings.drop(this.sql, "teamLinkTeamId");
  }

  // ------------------------------------------------------------------ the import (spec 43.1)

  /**
   * The install Computer held before cutover, once: its Slack settings (team, sealed bot token),
   * people and their member links, so nobody reinstalls Slack. Threads, queues and sessions are
   * not carried; a thread from before starts a new session.
   */
  private async import(): Promise<void> {
    const org = this.org();
    this.importing ??= (async () => {
      try {
        const done = this.sql.exec<{ imported: number }>("SELECT imported FROM meta WHERE k = 1")[0];
        if (done?.imported) return;
        const carry = await computerOf(this.env, org).slackCarry();
        const carried = await Promise.all(carry.links.map(async (l) => ({ slackUser: l.slackUser, member: await asMember(l.member) })));
        this.sql.transaction(() => {
          for (const [k, v] of Object.entries(carry.settings)) settings.put(this.sql, k, v);
          for (const p of carry.people) {
            this.sql.exec(
              "INSERT OR IGNORE INTO people (slack_user_id, dir, git_name, git_email, updated_at) VALUES (?, ?, ?, ?, ?)",
              p.slack_user_id,
              p.dir,
              p.git_name,
              p.git_email,
              p.updated_at,
            );
          }
          for (const l of carried) links.put(this.sql, l.slackUser, l.member);
          this.sql.exec("INSERT INTO meta (k, imported) VALUES (1, 1) ON CONFLICT(k) DO UPDATE SET imported = 1");
        });
        this.token = undefined;
        this.access = undefined;
        // The workspace's route moves to this namespace's router.
        const teamId = settings.get(this.sql, "slackTeamId");
        if (teamId) {
          const claim = await slackOf(this.env, `slack-team:${teamId}`).claimTeam(teamId, org);
          if (!claim.ok) console.warn(JSON.stringify({ level: "warn", event: "slack.import_team_held", teamId }));
        }
      } finally {
        this.importing = undefined;
      }
    })();
    return this.importing;
  }
}
