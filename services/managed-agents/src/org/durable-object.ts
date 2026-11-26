// Org (tracks and threads, spec 17.3 and 36.1): one per organization, binding `ORGS`, named by the
// organization's id. The logic is in this directory's modules, pure functions over `Sql`; this
// class adds the storage, the alarm and the calls out.

import { DurableObject } from "cloudflare:workers";

import {
  alarms,
  computerOf,
  deliveryOf,
  hashOf,
  liveOf,
  logOf,
  migrate,
  owed,
  platformPrincipal,
  slackOf,
  sqlOf,
  unavailable,
  type Access,
  type ActorEnv,
  type ComputerRpcAdded,
  type CreateSession,
  type DeliveryKind,
  type DeliveryRpc,
  type DocRev,
  type FeedFrame,
  type ListQuery,
  type LiveRpc,
  type MachinePub,
  type MutateReply,
  type MutateRequest,
  type Occurrence,
  type Overview,
  type PlaceRow,
  type Principal,
  type PullPub,
  type Reply,
  type ResultRow,
  type ReviewRow,
  type Row,
  type SessionLogRpcAdded,
  type SessionPage,
  type SessionPatch,
  type SessionRow,
  type SlackEcho,
  type SlackRpc,
  type Sql,
  type StartSpec,
  type SummaryPub,
} from "../actor/index.js";
import type { OrgForDelivery } from "../delivery/contract.js";
import { computerSessionId } from "../computer/protocol.js";
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
  /** The retired Work board's object, read once while adopting (org/work-index.ts). */
  WORK_INDEX?: DurableObjectNamespace;
};

/** Every call Org makes out. A test replaces members of it. */
export interface OrgOut {
  computer(machine: string): Pick<ComputerRpcAdded, "start" | "stop" | "setAccess" | "changed" | "exportSessions">;
  log(sessionId: string): Pick<SessionLogRpcAdded, "setAccess" | "accept" | "destroy">;
  slack(): Pick<SlackRpc, "announce">;
  delivery(kind: DeliveryKind): Pick<DeliveryRpc, "poke">;
  live(): Pick<LiveRpc, "publish">;
  /** The usage row of a created session (D1 `session_creations`). */
  created(sessionId: string, createdAt: number): Promise<void>;
  /** The knowledge repository setting the retired Work board held, read once while adopting. */
  boardRepository(): Promise<StoredRepository | null>;
  /** The organization's Account object, or null where it is not bound. */
  account(): TokenMinter | null;
  fetch: Fetch;
}

const AGE_EVERY_MS = 60 * 60 * 1_000;

export class OrgDurableObject extends DurableObject<OrgEnv> implements OrgForDelivery {
  private store: Sql | null = null;
  private adopting: Promise<void> | null = null;

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
    delivery: (kind) => deliveryOf(this.env, this.org, kind),
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
      case "Delivery.poke":
        return this.out.delivery(body.kind as DeliveryKind).poke(feeds.metaOf(sql).occ);
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
    return owed.run(this.sql, (call, body) => this.send(call, body), Date.now());
  }

  private flush(): void {
    this.ctx.waitUntil(this.drain().catch(() => undefined));
  }

  override async alarm(): Promise<void> {
    const sql = this.sql;
    await alarms.run(sql, Date.now(), {
      owed: () => this.drain(),
      adopt: () => this.adoptNow(),
      age: () => {
        work.age(sql, Date.now());
        alarms.set(sql, "age", Date.now() + AGE_EVERY_MS);
        this.flush();
      },
    });
  }

  // ------------------------------------------------------------------ adoption (spec 43.1)

  /** Every method's first step: the organization's sessions are here, or are fetched now. Throws `adopting` when a page fails. */
  private async ready(p?: Principal): Promise<void> {
    const sql = this.sql;
    if (p) sessions.seen(sql, p);
    if (work.adopted(sql)) return;
    await this.adoptNow();
  }

  /** `ready` for a method that answers refusals as values. */
  private async gate(p?: Principal): Promise<{ ok: false; code: "adopting"; status: 503; message: string; retryAfterMs: number } | null> {
    try {
      await this.ready(p);
      return null;
    } catch {
      return { ok: false, code: "adopting", status: 503, message: "The organization's sessions are being moved. Try again shortly.", retryAfterMs: 5_000 };
    }
  }

  private adoptNow(): Promise<void> {
    this.adopting ??= this.adoptPages().finally(() => {
      this.adopting = null;
    });
    return this.adopting;
  }

  private async adoptPages(): Promise<void> {
    const sql = this.sql;
    const org = this.org;
    try {
      while (!work.adopted(sql)) {
        const page = await this.out.computer(org).exportSessions(work.adoptAfter(sql), work.ADOPT_PAGE);
        // The knowledge repository the Work board held, read before the last page marks the adoption done.
        const repository = page.next === null ? await this.out.boardRepository() : null;
        work.adoptPage(sql, Date.now(), org, page, repository ? JSON.stringify(repository) : null);
      }
      alarms.clear(sql, "adopt");
      alarms.set(sql, "age", Date.now() + AGE_EVERY_MS);
      this.flush();
    } catch (error) {
      alarms.set(sql, "adopt", Date.now() + 5_000);
      throw new Error("adopting", { cause: error });
    }
  }

  /** Sessions the previous version made after the adoption (spec 43.1): the export read again, rows Org holds passed over. */
  private async adoptLate(): Promise<void> {
    const org = this.org;
    let after: string | null = null;
    for (;;) {
      const page = await this.out.computer(org).exportSessions(after, work.ADOPT_PAGE);
      work.adoptPage(this.sql, Date.now(), org, page, null, true);
      if (page.next === null) return;
      after = page.next;
    }
  }

  async adopt(): Promise<void> {
    await this.ready();
  }

  // ------------------------------------------------------------------ the directory

  async createSession(p: Principal, body: CreateSession): Promise<Reply<{ session: SessionRow; place: PlaceRow | null; duplicate: boolean }>> {
    const busy = await this.gate(p);
    if (busy) return busy;
    const { person: _person, ...hashed } = body;
    const hash = await hashOf(hashed);
    const out = sessions.createSession(this.sql, Date.now(), p, body, hash, this.org);
    this.flush();
    return out;
  }

  async getSession(p: Principal, id: string): Promise<Reply<{ session: SessionRow }>> {
    return (await this.gate(p)) ?? sessions.getSession(this.sql, p, id);
  }

  async patchSession(p: Principal, id: string, patch: SessionPatch): Promise<Reply<{ session: SessionRow }>> {
    const busy = await this.gate(p);
    if (busy) return busy;
    const out = sessions.patchSession(this.sql, Date.now(), p, id, patch);
    this.flush();
    return out;
  }

  async listSessions(p: Principal, q: ListQuery): Promise<Reply<SessionPage>> {
    return (await this.gate(p)) ?? sessions.listSessions(this.sql, p, q);
  }

  // ------------------------------------------------------------------ the feed and the work part

  async feed(p: Principal, q: { after?: string; kinds?: string[]; clientId?: string; ack?: number; sum?: boolean }): Promise<FeedFrame | { reset: true; cursor: null }> {
    await this.ready(p);
    const read = feeds.feed(this.sql, Date.now(), p, q);
    if ("reset" in read) return read;
    if (read.sumOver) read.frame.sum = await feeds.checksum(read.sumOver);
    return read.frame;
  }

  async mutate(p: Principal, m: MutateRequest): Promise<MutateReply> {
    await this.ready(p);
    const hash = await hashOf({ name: m.name, args: m.args });
    const out = feeds.mutate(this.sql, Date.now(), p, m, hash);
    this.flush();
    return out;
  }

  async threads(p: Principal, q: { earlier?: boolean; trackId?: string; before?: string; limit?: number }): Promise<{ rows: Row[]; next: string | null }> {
    await this.ready(p);
    return work.threads(this.sql, p, q);
  }

  async search(p: Principal, q: { q: string; limit?: number }): Promise<{ rows: Row[] }> {
    await this.ready(p);
    return work.search(this.sql, p, q);
  }

  async result(p: Principal, id: string): Promise<ResultRow | null> {
    await this.ready(p);
    return work.result(this.sql, p, id);
  }

  async overview(p: Principal): Promise<Overview> {
    await this.ready(p);
    return work.overview(this.sql, p);
  }

  async trackAgent(p: Principal): Promise<string | null> {
    await this.ready(p);
    return work.trackAgent(this.sql, p);
  }

  async doc(p: Principal, trackId: string): Promise<Row | null> {
    await this.ready(p);
    return work.doc(this.sql, p, trackId);
  }

  async docRevisions(p: Principal, trackId: string, rev?: number): Promise<DocRev[]> {
    await this.ready(p);
    return work.docRevisions(this.sql, p, trackId, rev);
  }

  async review(p: Principal, resultId: string): Promise<ReviewRow | null> {
    await this.ready(p);
    return work.review(this.sql, p, resultId);
  }

  async mismatch(p: Principal, body: { clientId: string; cursor: string; server: string; client: string }): Promise<void> {
    console.warn(JSON.stringify({ event: "org.feed_mismatch", org: p.org, subject: p.subject, ...body }));
  }

  // ------------------------------------------------------------------ the occurrence stream

  async occurrences(p: Principal, q: { after?: string; limit?: number }): Promise<{ entries: Occurrence[]; to: string } | { reset: true; cursor: null }> {
    await this.ready(p.kind === "platform" ? undefined : p);
    return feeds.occurrences(this.sql, p, q);
  }

  async digest(target: string, fromN: number, toN: number): Promise<string> {
    await this.ready();
    return work.digest(this.sql, target, fromN, toN);
  }

  /** Delivery(wake) only (`src/delivery/contract.ts`). */
  async wakeTargets(n: number): Promise<string[]> {
    await this.ready();
    return work.wakeTargets(this.sql, n);
  }

  async echo(n: number): Promise<SlackEcho | null> {
    await this.ready();
    return work.echo(this.sql, n);
  }

  // ------------------------------------------------------------------ arrows in

  async acceptSummary(pub: SummaryPub): Promise<{ accepted: boolean; revision: number }> {
    await this.ready();
    const out = feeds.acceptSummary(this.sql, Date.now(), pub);
    this.flush();
    return out;
  }

  async acceptMachine(pub: MachinePub): Promise<{ accepted: boolean }> {
    await this.ready();
    const sql = this.sql;
    const out = work.acceptMachine(sql, Date.now(), pub);
    // A failure leaves `adopted_at` where it was: the machine's next state tries again.
    if (work.adoptedBefore(sql, pub.newestCreatedAt)) this.ctx.waitUntil(this.adoptLate().then(() => this.flush(), () => undefined));
    this.flush();
    return out;
  }

  async acceptPull(pub: PullPub): Promise<void> {
    await this.ready();
    work.acceptPull(this.sql, Date.now(), pub);
    this.flush();
  }

  async access(sessionId: string): Promise<Access | null> {
    await this.ready();
    return sessions.access(this.sql, sessionId);
  }

  async forHost(machine: string): Promise<{ sessions: { sessionId: string; access: Access }[]; admins: string[]; knowledge: string | null }> {
    await this.ready();
    return sessions.forHost(this.sql, machine);
  }

  // ------------------------------------------------------------------ the knowledge repository (org/repository.ts)

  async repository(p: Principal): Promise<Repository | null> {
    await this.ready(p);
    return repositories.shown(repositories.storedRepository(this.sql));
  }

  async setRepository(p: Principal, body: RepositoryChoice): Promise<Reply<{ repository: Repository }>> {
    const busy = await this.gate(p);
    if (busy) return busy;
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
    await this.ready(p);
    const account = this.out.account();
    if (!account) return { ok: false, code: "unavailable", status: 503, message: "GitHub is not configured.", retryAfterMs: 5_000 };
    return repositories.listGranted(account, this.out.fetch, q);
  }

  async linkPerson(from: string, to: string): Promise<void> {
    await this.ready();
    work.linkPerson(this.sql, Date.now(), from, to);
    this.flush();
  }
}
