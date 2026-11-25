// Slack: one per organization, the link to its Slack workspace (tracks and threads, spec 36.6 and
// 40.11). It deduplicates and queues what Slack sends, then works the queue: threads in parallel,
// one thread's messages in order. A message becomes a session (Org.createSession) and a turn in
// its SessionLog's inbox; a command becomes a call. It never delivers to a machine.

import { DurableObject } from "cloudflare:workers";

import {
  type AcceptResult,
  type ActorEnv,
  alarms,
  errorText,
  idem,
  logOf,
  migrate,
  orgOf,
  owed,
  type Principal,
  type Sql,
  type SlackEcho,
  type SlackGrant,
  type SlackRpc,
  sqlOf,
  unavailable,
  type Reply,
  computerOf,
} from "../actor/index.js";
import type { Origin } from "../computer/api-types.js";
import { unseal } from "../computer/crypto.js";
import { type CalvinPerson, COMPUTER_GIT_NAME, noReplyGitEmail, personFor, sessionKey } from "../computer/protocol.js";
import { normalizeJob, parseSlackEnvelope, type SlackMessageJob, type SlackResult, slackApi, slackThreadUrl } from "./slack-api.js";
import { findThreadLinks, forwardedLinked, LINK_TIMEOUT_MS, type Linked, ThreadAccess } from "./threads.js";
import { links, sessionIdFor, settings, STEPS, threads, turnIdFor } from "./store.js";

export interface SlackEnv extends ActorEnv {
  BLUE_CHANNEL_ENCRYPTION_KEY?: string;
}

/** The queue's purpose on the shared alarm. */
const QUEUE = "queue";
const PARALLEL_THREADS = 8;
const DRAIN_MAX_JOBS = 50;
const MAX_ATTEMPTS = 5;
/** A row `running` this long that no drain of this instance holds was stranded by an eviction. */
const STRANDED_GRACE_MS = 5_000;
/** The alarm armed on accept: the queue's durability, should the drain right after it not finish. */
const FALLBACK_MS = 30_000;
/** Slack retries an event for an hour at most; ids and message keys are kept a day. */
const DEDUP_TTL_MS = 24 * 60 * 60_000;

const MEMBER_SCOPES: Principal["scopes"] = ["sessions:read", "sessions:write", "asks:answer", "work:read", "work:write"];
const ONLY_MEMBERS_TEXT = "Only full members of this workspace can drive sessions.";
const INBOX_FULL_TEXT = "This session has too many messages waiting; try again once it has caught up.";

/** A message queued, as Computer queued it; `start`: this message created the thread's session (a retry creates it again, idempotently). */
type MessageJob = SlackMessageJob & { start?: boolean; harness?: string };
/** Anything else the queue holds; tagged so a Computer row (a bare message) still reads. */
type OtherJob = { item: "stop"; teamId: string; channelId: string; threadTs?: string; userId?: string } | { item: "interaction"; id: string; body: unknown };
type Job = MessageJob | OtherJob;

const isOther = (job: Job): job is OtherJob => "item" in job;

export class SlackDurableObject extends DurableObject<SlackEnv> implements SlackRpc {
  protected readonly sql: Sql;
  private draining: Promise<void> | undefined;
  private wakeDrain: (() => void) | undefined;
  private readonly inFlight = new Set<number>();
  private access?: { teamId: string; threads: ThreadAccess };
  private token?: { sealed: string; plain: string };

  constructor(ctx: DurableObjectState, env: SlackEnv) {
    super(ctx, env);
    this.sql = sqlOf(ctx.storage);
    migrate(this.sql, STEPS);
  }

  override fetch(): Response {
    return unavailable("Slack");
  }

  override async alarm(): Promise<void> {
    await alarms.run(this.sql, Date.now(), {
      owed: () => owed.run(this.sql, (call, body) => this.sendOwed(call, body), Date.now()),
      [QUEUE]: async () => {
        this.recoverStranded();
        await this.drain();
      },
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

  // ------------------------------------------------------------------ accept (40.11 step 1)

  async accept(e: { kind: "event" | "interaction"; id: string; body: unknown }): Promise<void> {
    this.org();
    const now = Date.now();
    const seen = `slack:${e.kind}:${e.id}`;
    if (idem.get(this.sql, seen, e.kind)) return;
    let job: Job | null = null;
    let threadKey: string | null = null;
    if (e.kind === "interaction") {
      job = { item: "interaction", id: e.id, body: e.body };
      threadKey = `interaction:${e.id}`;
    } else {
      const parsed = parseSlackEnvelope(e.body, now);
      if (parsed.kind === "message") {
        const teamId = settings.get(this.sql, "slackTeamId");
        if (parsed.job.teamId !== teamId || !settings.get(this.sql, "slackBotToken")) return;
        const normalized = normalizeJob(parsed.job, settings.get(this.sql, "slackBotUserId") ?? "");
        if (normalized) {
          job = normalized;
          threadKey = `${normalized.channelId}:${normalized.threadTs}`;
        }
      } else if (parsed.kind === "stop") {
        job = { item: "stop", teamId: parsed.teamId, channelId: parsed.channelId, ...(parsed.threadTs ? { threadTs: parsed.threadTs } : {}), ...(parsed.userId ? { userId: parsed.userId } : {}) };
        threadKey = `${parsed.channelId}:${parsed.threadTs ?? ""}`;
      }
    }
    this.sql.transaction(() => {
      idem.put(this.sql, seen, e.kind, null, DEDUP_TTL_MS);
      if (!job) return;
      if (!isOther(job)) {
        // Slack sends both `message` and `app_mention` for one mention, with different event ids: the first is the one.
        this.sql.exec("DELETE FROM slack_messages WHERE received_at < ?", now - DEDUP_TTL_MS);
        const fresh = this.sql.exec("INSERT OR IGNORE INTO slack_messages (message_key, received_at) VALUES (?, ?) RETURNING message_key", `${job.channelId}:${job.messageTs}`, now);
        if (!fresh.length) return;
      }
      this.sql.exec("INSERT INTO slack_queue (payload, available_at, thread_key) VALUES (?, ?, ?)", JSON.stringify(job), now, threadKey);
      alarms.set(this.sql, QUEUE, now + FALLBACK_MS);
    });
    this.ctx.waitUntil(this.drain().catch((error) => console.error(JSON.stringify({ level: "error", event: "slack.drain_failed", message: errorText(error) }))));
  }

  // ------------------------------------------------------------------ the queue (40.11 step 2)

  /** Work the queue, or have the drain in flight look again. */
  protected drain(): Promise<void> {
    if (this.draining) {
      this.wakeDrain?.();
      return this.draining;
    }
    this.draining = (async () => {
      try {
        await this.drainThreads();
      } finally {
        this.draining = undefined;
      }
      this.sql.exec("DELETE FROM slack_queue WHERE state = 'failed' AND sequence < (SELECT MAX(sequence) - 1000 FROM slack_queue)");
      this.reschedule();
    })();
    return this.draining;
  }

  private async drainThreads(): Promise<void> {
    const chains = new Map<string, Promise<void>>();
    const budget = { left: DRAIN_MAX_JOBS };
    for (;;) {
      if (budget.left > 0) {
        for (const thread of this.readyThreads()) {
          if (chains.size >= PARALLEL_THREADS) break;
          if (chains.has(thread)) continue;
          const chain: Promise<void> = Promise.resolve()
            .then(() => this.runThread(thread, budget))
            .catch((error: unknown) => console.error(JSON.stringify({ level: "error", event: "slack.chain_failed", message: errorText(error) })))
            .finally(() => chains.delete(thread));
          chains.set(thread, chain);
        }
      }
      if (!chains.size) return;
      const woken = new Promise<void>((resolve) => (this.wakeDrain = resolve));
      await Promise.race([...chains.values(), woken]);
      this.wakeDrain = undefined;
    }
  }

  private readyThreads(): string[] {
    return this.sql
      .exec<{ thread: string }>(
        `SELECT COALESCE(thread_key, 'seq:' || sequence) AS thread, MIN(sequence) AS first FROM slack_queue
         WHERE state = 'pending' AND available_at <= ? GROUP BY thread ORDER BY first LIMIT ?`,
        Date.now(),
        PARALLEL_THREADS * 4,
      )
      .map((row) => row.thread);
  }

  /** One thread's rows in order, each claimed before its first await; a thread waits behind its own failure. */
  private async runThread(thread: string, budget: { left: number }): Promise<void> {
    while (budget.left > 0) {
      const head = this.sql.exec<{ sequence: number; payload: string; attempts: number; state: string; available_at: number }>(
        `SELECT sequence, payload, attempts, state, available_at FROM slack_queue
         WHERE state IN ('pending', 'running') AND COALESCE(thread_key, 'seq:' || sequence) = ? ORDER BY sequence LIMIT 1`,
        thread,
      )[0];
      if (!head || head.state !== "pending" || head.available_at > Date.now()) return;
      const claimed = this.sql.exec("UPDATE slack_queue SET state = 'running', attempts = attempts + 1, started_at = ? WHERE sequence = ? AND state = 'pending' RETURNING sequence", Date.now(), head.sequence);
      if (!claimed.length) continue;
      budget.left -= 1;
      this.inFlight.add(head.sequence);
      try {
        await this.runJob(head);
      } finally {
        this.inFlight.delete(head.sequence);
      }
    }
  }

  private async runJob(row: { sequence: number; payload: string; attempts: number }): Promise<void> {
    const attempts = row.attempts + 1;
    try {
      await this.process(JSON.parse(row.payload) as Job, row.sequence);
      this.sql.exec("DELETE FROM slack_queue WHERE sequence = ?", row.sequence);
    } catch (error) {
      console.warn(JSON.stringify({ level: "warn", event: "slack.job_failed", attempts, message: errorText(error) }));
      if (attempts >= MAX_ATTEMPTS) {
        this.sql.exec("UPDATE slack_queue SET state = 'failed', last_error = ? WHERE sequence = ?", errorText(error), row.sequence);
      } else {
        this.sql.exec(
          "UPDATE slack_queue SET state = 'pending', available_at = ?, last_error = ? WHERE sequence = ?",
          Date.now() + Math.min(60_000, 1000 * 2 ** attempts),
          errorText(error),
          row.sequence,
        );
      }
    }
  }

  /** Rows left `running` by an evicted drain go back to `pending`, attempts kept. */
  private recoverStranded(): void {
    const cutoff = Date.now() - STRANDED_GRACE_MS;
    for (const row of this.sql.exec<{ sequence: number }>("SELECT sequence FROM slack_queue WHERE state = 'running' AND COALESCE(started_at, 0) <= ?", cutoff)) {
      if (!this.inFlight.has(row.sequence)) this.sql.exec("UPDATE slack_queue SET state = 'pending', available_at = ? WHERE sequence = ? AND state = 'running'", Date.now(), row.sequence);
    }
  }

  /** The queue's alarm for what is left: the next row ready, or a stranded one; none when the queue is empty. */
  private reschedule(): void {
    const pending = this.sql.exec<{ at: number | null }>("SELECT MIN(available_at) AS at FROM slack_queue WHERE state = 'pending'")[0]?.at ?? null;
    const running = this.sql
      .exec<{ sequence: number; at: number }>("SELECT sequence, COALESCE(started_at, 0) AS at FROM slack_queue WHERE state = 'running'")
      .filter((row) => !this.inFlight.has(row.sequence))
      .reduce<number | null>((min, row) => (min === null || row.at < min ? row.at : min), null);
    const candidates = [pending, running === null ? null : running + STRANDED_GRACE_MS + 1].filter((at): at is number => at !== null);
    alarms.clear(this.sql, QUEUE);
    if (candidates.length) alarms.set(this.sql, QUEUE, Math.max(Math.min(...candidates), Date.now() + 25));
  }

  // ------------------------------------------------------------------ one message (40.11 steps 2 to 7)

  protected async process(job: Job, sequence: number): Promise<void> {
    if (isOther(job)) return this.processOther(job);
    const teamId = settings.get(this.sql, "slackTeamId");
    if (!teamId || teamId !== job.teamId) return;
    const key = sessionKey(teamId, job.channelId, job.threadTs);
    const known = threads.sessionOf(this.sql, key);
    if (!known && !job.mentioned && job.channelType !== "im") return;

    const p = await this.principal(job.userId);
    if (!p) {
      if (job.mentioned || job.channelType === "im") await this.ephemeral(job, ONLY_MEMBERS_TEXT);
      return;
    }
    this.ctx.waitUntil(this.registerPerson(job.userId).catch(() => {}));

    // A message that starts a thread: the thread recorded with its session id, then the session.
    let sid = known;
    if (!sid || job.start) {
      if (!sid) {
        const prefix = /^\s*\+(claude|codex)(?=\s|$)\s*/i.exec(job.text);
        if (prefix) job = { ...job, text: job.text.slice(prefix[0].length), harness: prefix[1]!.toLowerCase() };
        sid = await sessionIdFor(key);
        const started: MessageJob = { ...job, start: true };
        this.sql.transaction(() => {
          threads.put(this.sql, key, sid!);
          this.sql.exec("UPDATE slack_queue SET payload = ? WHERE sequence = ?", JSON.stringify(started), sequence);
        });
        job = started;
      }
      const created = await orgOf(this.env, this.org()).createSession(p, {
        id: sid,
        writers: "members",
        slackThread: key,
        origin: this.origin(teamId, job.channelId, job.threadTs),
        ...(job.harness ? { harness: job.harness } : {}),
      });
      if (!created.ok) {
        console.warn(JSON.stringify({ level: "warn", event: "slack.session_refused", code: created.code }));
        return;
      }
    }

    // The turn.
    const above = !known && job.channelType !== "im" && job.threadTs !== job.messageTs;
    const linked = await this.linkedThreads(job, above);
    const context = this.heldContext(key);
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
    await this.afterTurn(job, key, result);
  }

  /** What SessionLog answered a turn: delivered, held (`forbidden`), or the person told. */
  protected async afterTurn(job: MessageJob, key: string, result: AcceptResult): Promise<void> {
    if (result.ok) {
      this.forgetContext(key);
      this.ctx.waitUntil(this.acknowledge(job).catch(() => {}));
      return;
    }
    if (result.code === "inbox_full") return void (await this.ephemeral(job, INBOX_FULL_TEXT));
    if (result.code === "forbidden") return this.forbidden(job, key);
    console.warn(JSON.stringify({ level: "warn", event: "slack.turn_refused", code: result.code }));
  }

  /** Slice 2: held context and the access request. */
  protected async forbidden(_job: MessageJob, _key: string): Promise<void> {}

  /** Slice 2: the messages held for a thread since its last turn. */
  protected heldContext(_key: string): Linked[] {
    return [];
  }

  protected forgetContext(_key: string): void {}

  /** Slice 2: stop buttons and interactions. */
  protected async processOther(_job: OtherJob): Promise<void> {}

  /** Slice 2+: calls owed after a transaction. */
  protected async sendOwed(call: string, _body: unknown): Promise<void> {
    console.warn(JSON.stringify({ level: "warn", event: "slack.owed_unknown", call }));
  }

  // ------------------------------------------------------------------ the person (34.3)

  /** The person's principal, or null when Slack does not report them as a member of the workspace. Throws when Slack could not be asked. */
  protected async principal(slackUser: string): Promise<Principal | null> {
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

  async forHost(): Promise<{ people: CalvinPerson[]; slack: { botToken: string; botUserId: string; teamId: string } | null }> {
    const teamId = settings.get(this.sql, "slackTeamId");
    const botToken = await this.botToken();
    return { people: this.people(), slack: teamId && botToken ? { botToken, botUserId: settings.get(this.sql, "slackBotUserId") ?? "", teamId } : null };
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

  /** The working status on the thread, or 👀 where that is unavailable; `notify` takes it off. */
  private async acknowledge(job: MessageJob): Promise<void> {
    const status = await this.slack("agents.sessions.setStatus", { channel_id: job.channelId, thread_ts: job.threadTs, status: "processing", initiator_user_id: job.userId });
    if (!status.ok) await this.slack("reactions.add", { channel: job.channelId, timestamp: job.messageTs, name: "eyes" });
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

  async install(_p: Principal, _grant: SlackGrant): Promise<void> {
    throw new Error("not yet");
  }

  async unlink(_p: Principal): Promise<void> {
    throw new Error("not yet");
  }

  async announce(_child: { sessionId: string; parent: string; brief: string }): Promise<{ threadKey: string }> {
    throw new Error("not yet");
  }

  async notify(_e: SlackEcho): Promise<void> {
    throw new Error("not yet");
  }

  async post(_p: Principal, _threadKey: string, _text: string): Promise<Reply<{ ts: string }>> {
    return { ok: false, code: "unavailable", status: 503 };
  }

  async import(): Promise<void> {
    throw new Error("not yet");
  }
}
