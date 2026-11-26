// Org (tracks and threads, spec 17.3 and 36.1): one per organization, binding `ORGS`, named by the
// organization's id. The logic is in this directory's modules, pure functions over `Sql`; this
// class adds the storage, the alarm and the calls out.

import { DurableObject } from "cloudflare:workers";

import { alarms } from "../durable/alarms.js";
import { computerOf, liveOf, logOf, slackOf, type ActorEnv } from "../actors/addresses.js";
import { emitter } from "../telemetry/log-emitter.js";
import { hashOf } from "../encoding/canonical-json.js";
import { migrate } from "../durable/migrations.js";
import { owed, type Dead } from "../durable/outbox.js";
import { platformPrincipal, type Access, type Principal } from "../auth/principal.js";
import { sqlOf, type Sql } from "../durable/sql.js";
import { unavailable } from "../http/unavailable.js";
import { type ComputerRpcAdded, type CreateSession, type DocRev, type FeedFrame, type ListQuery, type LiveRpc, type MachinePub, type MutateReply, type MutateRequest, type Occurrence, type OrgRpc, type OrgSettings, type OutsideAccess, type Overview, type PlaceRow, type PullPub, type Reply, type ResultRow, type ReviewRow, type Row, type SessionLogRpcAdded, type SessionPage, type SessionPatch, type SessionRow, type SlackRpc, type StartSpec, type SummaryPub } from "../actor/contracts.js";
import { computerSessionId } from "../computer/protocol.js";
import { memberId } from "../computer/session-ids.js";
import * as feeds from "./feed.js";
import * as repositories from "./repository.js";
import type { Fetch, GrantingInstallation, RepositoriesQuery, Repository, RepositoryChoice, StoredRepository, TokenMinter } from "./repository.js";
import { STEPS } from "./schema.js";
import * as sessions from "./sessions.js";
import { accessOf, readSession, trackOfAgent, type PublishOwed } from "./tx.js";
import * as work from "./work.js";

export type OrgEnv = ActorEnv & {
  SERVERLESS_AGENTS_DB?: D1Database;
  /** The edge's AccountDurableObject, addressed by the organization's id: GitHub tokens. */
  ACCOUNTS?: DurableObjectNamespace;
  /** The retired Work board's object: the knowledge repository it held, read once (org/work-index.ts). */
  WORK_INDEX?: DurableObjectNamespace;
};

/** `access.people` with WorkOS user ids (the dashboard's) as member ids; Org checks the rest. */
async function memberIds(access: unknown): Promise<CreateSession["access"]> {
  const a = access as CreateSession["access"];
  if (!a || typeof a !== "object" || !Array.isArray(a.people)) return a;
  return { ...a, people: await Promise.all(a.people.map((e) => (typeof e === "string" && /^user_[0-9A-Za-z]{1,64}$/.test(e) ? memberId(e) : e))) };
}

/** Every call Org makes out. A test replaces members of it. */
export interface OrgOut {
  computer(machine: string): Pick<ComputerRpcAdded, "start" | "stop" | "setAccess" | "changed">;
  log(sessionId: string): Pick<SessionLogRpcAdded, "setAccess" | "accept" | "destroy">;
  slack(): Pick<SlackRpc, "announce" | "notify">;
  live(): Pick<LiveRpc, "publish">;
  /** The usage row of a created session (D1 `session_creations`). */
  created(sessionId: string, createdAt: number): Promise<void>;
  /** The knowledge repository setting the retired Work board held, read once (the `board` alarm). */
  boardRepository(): Promise<StoredRepository | null>;
  /** The organization's Account object, or null where it is not bound. */
  account(): TokenMinter | null;
  fetch: Fetch;
}

const AGE_EVERY_MS = 60 * 60 * 1_000;

export class OrgDurableObject extends DurableObject<OrgEnv> implements OrgRpc {
  private store: Sql | null = null;
  private readonly emit = emitter("org", () => ({ org: this.ctx.id.name }));

  /** The organization's id: the object's name, else what the first principal said. */
  get org(): string {
    const name = this.ctx.id.name ?? feeds.metaOf(this.sql).org;
    if (!name) throw new Error("Org does not know its organization");
    return name;
  }

  out: OrgOut = {
    computer: (machine) => computerOf(this.env, machine),
    log: (sessionId) => logOf(this.env, sessionId),
    slack: () => slackOf(this.env, this.org),
    live: () => liveOf(this.env, this.org),
    created: async (sessionId, createdAt) => {
      await this.env.SERVERLESS_AGENTS_DB?.prepare("INSERT INTO session_creations (session_id, account_id, source, created_at) VALUES (?, ?, 'computer', ?) ON CONFLICT(session_id) DO NOTHING")
        .bind(computerSessionId(sessionId), this.org, new Date(createdAt).toISOString())
        .run();
    },
    boardRepository: async () =>
      this.env.WORK_INDEX ? ((this.env.WORK_INDEX.getByName(this.org) as unknown as { repository(): Promise<StoredRepository | null> }).repository()) : null,
    account: () => (this.env.ACCOUNTS ? (this.env.ACCOUNTS.getByName(this.org) as unknown as TokenMinter) : null),
    fetch: (url, init) => fetch(url, init),
  };

  /** The object's SQL, migrated on first use. */
  protected get sql(): Sql {
    if (!this.store) {
      this.store = sqlOf(this.ctx.storage);
      migrate(this.store, STEPS);
    }
    return this.store;
  }

  /** Org is reached by RPC only. */
  override fetch(): Response {
    return unavailable("Org");
  }

  // ------------------------------------------------------------------ the calls out

  /** One owed call (spec 35.1). Everything is read from the rows now: a session that is gone owes nothing. */
  private async send(call: string, raw: unknown): Promise<void> {
    const sql = this.sql;
    const body = (raw ?? {}) as Record<string, unknown>;
    const sessionId = body.sessionId as string;
    switch (call) {
      case "Computer.start": {
        const s = readSession(sql, sessionId);
        if (!s) return;
        const track = s.role === "track" ? trackOfAgent(sql, s.id) : null;
        const session = sessions.apiSession(sql, s);
        const spec: StartSpec = {
          session,
          settings: session.settings,
          role: s.role === "start" ? { name: "start" } : track ? { name: "track", trackId: track.id } : null,
          ...(body.harness ? { harness: body.harness as string } : {}),
          ...(body.trace ? { trace: body.trace as string } : {}),
        };
        return this.out.computer(s.machine).start(spec);
      }
      case "Computer.setAccess": {
        const s = readSession(sql, sessionId);
        const access = accessOf(sql, sessionId);
        if (!s || !access) return;
        return this.out.computer(s.machine).setAccess(sessionId, access, sessions.adminsOf(sql));
      }
      case "Computer.stop":
        return this.out.computer((body.machine as string | undefined) ?? this.org).stop(sessionId);
      case "Computer.changed":
        return this.out.computer((body.machine as string | undefined) ?? this.org).changed("org");
      case "SessionLog.setAccess": {
        const access = accessOf(sql, sessionId);
        if (!access) return;
        return this.out.log(sessionId).setAccess(access);
      }
      case "SessionLog.accept": {
        if (!readSession(sql, sessionId)) return;
        const result = await this.out.log(sessionId).accept(platformPrincipal(this.org), { id: body.id as string, kind: body.kind as never, body: body.body, ...(body.trace ? { trace: body.trace as string } : {}) });
        // Not there or not allowed: nothing a retry changes. Full: later.
        if (!result.ok && result.code !== "not_found" && result.code !== "forbidden" && result.code !== "idempotency_conflict") throw new Error(result.code);
        return;
      }
      case "SessionLog.destroy":
        return this.out.log(sessionId).destroy();
      case "Slack.announce": {
        if (!readSession(sql, sessionId)) return;
        const { threadKey } = await this.out.slack().announce({ sessionId, parent: body.parent as string, brief: body.brief as string });
        sessions.setSlackThread(sql, sessionId, threadKey);
        return;
      }
      case "SessionLog.wake": {
        // A turn for a track's agent or a parent session: what changed since the wake was owed (spec 40.6).
        const input = work.digest(sql, sessionId, body.fromN as number, body.toN as number);
        return this.send("SessionLog.accept", { sessionId, id: body.id, kind: "turn", body: { input, ifBusy: "queue" } });
      }
      case "Slack.notify": {
        const echo = work.echo(sql, body.n as number);
        if (!echo) return;
        return this.out.slack().notify(echo);
      }
      case "Live.publish": {
        await this.out.live().publish("feed", feeds.publishFrame(sql, body as unknown as PublishOwed, true));
        return;
      }
      case "usage.created":
        return this.out.created(sessionId, body.createdAt as number);
      default:
        throw new Error(`Org owes an unknown call: ${call}`);
    }
  }

  /** Send what is owed. Awaited by tests; a method leaves it to `waitUntil`. */
  drain(): Promise<void> {
    return owed.run(this.sql, (call, body) => this.send(call, body), Date.now(), this.emit);
  }

  private flush(): void {
    this.ctx.waitUntil(this.drain().catch(() => undefined));
  }

  override async alarm(): Promise<void> {
    const sql = this.sql;
    await alarms.run(sql, Date.now(), {
      owed: () => this.drain(),
      // Armed once by a migration step (schema.ts): the knowledge repository the Work board held, carried over.
      board: async () => {
        const repository = await this.out.boardRepository();
        if (repository && !repositories.storedRepository(sql)) repositories.storeRepository(sql, repository);
        this.flush();
      },
      age: () => {
        work.age(sql, Date.now());
        alarms.set(sql, "age", Date.now() + AGE_EVERY_MS);
        this.flush();
      },
    });
  }

  /** Who called, recorded (sessions.ts `seen`) before what they asked. */
  private seen(p: Principal): void {
    sessions.seen(this.sql, p);
  }

  // ------------------------------------------------------------------ the directory

  async createSession(p: Principal, body: CreateSession): Promise<Reply<{ session: SessionRow; place: PlaceRow | null; duplicate: boolean }>> {
    this.seen(p);
    body = { ...body, ...(body.access !== undefined ? { access: await memberIds(body.access) } : {}) };
    const { person: _person, ...hashed } = body;
    const hash = await hashOf(hashed);
    const out = sessions.createSession(this.sql, Date.now(), p, body, hash, this.org);
    this.flush();
    return out;
  }

  async getSession(p: Principal, id: string): Promise<Reply<{ session: SessionRow }>> {
    this.seen(p);
    return sessions.getSession(this.sql, p, id);
  }

  async patchSession(p: Principal, id: string, patch: SessionPatch): Promise<Reply<{ session: SessionRow } | OutsideAccess>> {
    this.seen(p);
    if (patch.access !== undefined) patch = { ...patch, access: await memberIds(patch.access) };
    const out = sessions.patchSession(this.sql, Date.now(), p, id, patch);
    this.flush();
    return out;
  }

  async listSessions(p: Principal, q: ListQuery): Promise<Reply<SessionPage>> {
    this.seen(p);
    return sessions.listSessions(this.sql, p, q);
  }

  async sessionAccess(p: Principal, id: string): Promise<Reply<OutsideAccess>> {
    this.seen(p);
    return sessions.sessionAccess(this.sql, p, id);
  }

  async settings(p: Principal): Promise<OrgSettings> {
    this.seen(p);
    return sessions.settings(this.sql);
  }

  async setSettings(p: Principal, patch: Partial<OrgSettings>): Promise<Reply<{ settings: OrgSettings }>> {
    this.seen(p);
    return sessions.setSettings(this.sql, p, patch);
  }

  // ------------------------------------------------------------------ the feed and the work part

  async feed(p: Principal, q: { after?: string; kinds?: string[] }): Promise<FeedFrame | { reset: true; cursor: null }> {
    this.seen(p);
    return feeds.feed(this.sql, Date.now(), p, q);
  }

  async mutate(p: Principal, m: MutateRequest): Promise<MutateReply> {
    this.seen(p);
    const hash = await hashOf({ name: m.name, args: m.args });
    const out = feeds.mutate(this.sql, Date.now(), p, m, hash);
    this.flush();
    return out;
  }

  async threads(p: Principal, q: { earlier?: boolean; trackId?: string; before?: string; limit?: number }): Promise<{ rows: Row[]; next: string | null }> {
    this.seen(p);
    return work.threads(this.sql, p, q);
  }

  async thread(p: Principal, sessionId: string): Promise<{ rows: Row[] } | null> {
    this.seen(p);
    return work.thread(this.sql, p, sessionId);
  }

  async search(p: Principal, q: { q: string; limit?: number }): Promise<{ rows: Row[] }> {
    this.seen(p);
    return work.search(this.sql, p, q);
  }

  async result(p: Principal, id: string): Promise<ResultRow | null> {
    this.seen(p);
    return work.result(this.sql, p, id);
  }

  async overview(p: Principal): Promise<Overview> {
    this.seen(p);
    return work.overview(this.sql, p);
  }

  async trackAgent(p: Principal): Promise<string | null> {
    this.seen(p);
    return work.trackAgent(this.sql, p);
  }

  async doc(p: Principal, trackId: string): Promise<Row | null> {
    this.seen(p);
    return work.doc(this.sql, p, trackId);
  }

  async docRevisions(p: Principal, trackId: string, rev?: number): Promise<DocRev[]> {
    this.seen(p);
    return work.docRevisions(this.sql, p, trackId, rev);
  }

  async review(p: Principal, resultId: string): Promise<ReviewRow | null> {
    this.seen(p);
    return work.review(this.sql, p, resultId);
  }

  // ------------------------------------------------------------------ the occurrence stream

  async occurrences(p: Principal, q: { after?: string; limit?: number }): Promise<{ entries: Occurrence[]; to: string } | { reset: true; cursor: null }> {
    if (p.kind !== "platform") this.seen(p);
    return feeds.occurrences(this.sql, p, q);
  }

  // ------------------------------------------------------------------ arrows in

  async acceptSummary(pub: SummaryPub): Promise<{ accepted: boolean; revision: number }> {
    const out = feeds.acceptSummary(this.sql, Date.now(), pub);
    this.flush();
    return out;
  }

  async acceptMachine(pub: MachinePub): Promise<{ accepted: boolean }> {
    const out = work.acceptMachine(this.sql, Date.now(), pub);
    this.flush();
    return out;
  }

  async acceptPull(pub: PullPub): Promise<void> {
    work.acceptPull(this.sql, Date.now(), pub);
    this.flush();
  }

  async access(sessionId: string): Promise<Access | null> {
    return sessions.access(this.sql, sessionId);
  }

  async dead(): Promise<Dead[]> {
    return owed.dead(this.sql);
  }

  async forHost(machine: string): Promise<{ sessions: { sessionId: string; access: Access }[]; admins: string[]; knowledge: string | null }> {
    return sessions.forHost(this.sql, machine);
  }

  // ------------------------------------------------------------------ the knowledge repository (org/repository.ts)

  async repository(p: Principal): Promise<Repository | null> {
    this.seen(p);
    return repositories.shown(repositories.storedRepository(this.sql));
  }

  async setRepository(p: Principal, body: RepositoryChoice): Promise<Reply<{ repository: Repository }>> {
    this.seen(p);
    if (p.kind !== "member" && p.kind !== "key") return { ok: false, code: "forbidden", status: 403 };
    const account = this.out.account();
    if (!account) return { ok: false, code: "unavailable", status: 503, message: "GitHub is not configured." };
    const checked = await repositories.checkChoice(account, this.out.fetch, body);
    if (!checked.ok) return checked;
    repositories.storeRepository(this.sql, checked.repository);
    this.flush();
    return { ok: true, repository: repositories.shown(checked.repository)! };
  }

  /** What the organization's GitHub installations grant, for the picker. */
  async repositories(p: Principal, q: RepositoriesQuery): Promise<Reply<{ installations: GrantingInstallation[] }>> {
    this.seen(p);
    const account = this.out.account();
    if (!account) return { ok: false, code: "unavailable", status: 503, message: "GitHub is not configured.", retryAfterMs: 5_000 };
    return repositories.listGranted(account, this.out.fetch, q);
  }

  async linkPerson(from: string, to: string): Promise<void> {
    work.linkPerson(this.sql, Date.now(), from, to);
    this.flush();
  }
}
