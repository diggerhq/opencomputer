// DeliveryDurableObject (tracks and threads, spec sections 35.3, 36.5 and 40.6): a reader of the
// organization's occurrence stream with its own cursor, one per organization and kind of
// destination, named `<org>:<kind>`. Three handlers behind one cursor loop: `wake` (a turn for a
// track's agent or a parent session), `webhook` (a customer's endpoint) and `slack` (the echo).
// Each occurrence it must act on is an owed call written in the transaction that advances the
// cursor, so a slow destination delays neither the read nor another destination.

import { DurableObject } from "cloudflare:workers";

import {
  type ActorEnv,
  type DeliveryKind,
  type Occurrence,
  type Principal,
  type Refusal,
  type Reply,
  type Sql,
  alarms,
  base64url,
  byOf,
  cursor,
  emitter,
  errorText,
  logOf,
  migrate,
  orgOf,
  owed,
  OWED_PURPOSE,
  platformPrincipal,
  slackOf,
  sqlOf,
} from "../actor/index.js";
import {
  DELIVERY_KINDS,
  type DeliveryRpcFull,
  type Endpoint,
  type EndpointInput,
  MAX_ENDPOINTS,
  type OrgForDelivery,
  PAGE,
  POLL_MS,
  RETRY_MS,
  SLACK_KINDS,
  WAKE_DEBOUNCE_MS,
  WAKE_KINDS,
} from "./contract.js";
import { post, urlRefusal } from "./webhook.js";

const POLL = "poll";
const WAKE = "wake";

interface EndpointRecord {
  id: string;
  url: string;
  secret: string;
  kinds: string;
  created_by: string;
  audiences: string;
  enabled: number;
}

const refuse = (code: string, status: number, message: string): Refusal => ({ ok: false, code, status, message });

const publicEndpoint = (row: EndpointRecord): Endpoint => ({
  id: row.id,
  url: row.url,
  kinds: JSON.parse(row.kinds) as string[],
  enabled: row.enabled === 1,
  createdBy: row.created_by,
});

/** A wake's turn id: the same for the same target and last occurrence, so a repeat is a duplicate. */
async function wakeTurnId(target: string, lastN: number): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${target}:${lastN}`)));
  return `tn_${[...digest.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export class DeliveryDurableObject extends DurableObject<ActorEnv> implements DeliveryRpcFull {
  private readonly sql: Sql;
  private readonly org: string;
  private readonly kind: DeliveryKind;
  private readonly emit = emitter("delivery", () => ({ org: this.org, kind: this.kind }));
  private reading: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: ActorEnv) {
    super(ctx, env);
    // The name is the whole of its identity: `<org>:<kind>` (deliveryOf).
    const name = ctx.id.name ?? "";
    const at = name.lastIndexOf(":");
    this.org = name.slice(0, at);
    this.kind = name.slice(at + 1) as DeliveryKind;
    if (at <= 0 || !DELIVERY_KINDS.includes(this.kind)) throw new Error(`Delivery is named <org>:<kind>, not "${name}".`);
    this.sql = sqlOf(ctx.storage);
    migrate(this.sql, [
      (sql) => {
        // `head` is the newest head a poke or a read named: what `behind` is counted against.
        sql.exec("CREATE TABLE cursor (k INTEGER PRIMARY KEY CHECK (k = 1), n INTEGER NOT NULL, head INTEGER NOT NULL)");
        sql.exec("INSERT INTO cursor (k, n, head) VALUES (1, 0, 0)");
        sql.exec("CREATE TABLE pending (target TEXT PRIMARY KEY, first_n INTEGER NOT NULL, last_n INTEGER NOT NULL, due_at INTEGER NOT NULL)");
        sql.exec(
          "CREATE TABLE endpoint (id TEXT PRIMARY KEY, url TEXT NOT NULL, secret TEXT NOT NULL, kinds TEXT NOT NULL, created_by TEXT NOT NULL, audiences TEXT NOT NULL, enabled INTEGER NOT NULL)",
        );
      },
    ]);
  }

  // ---------------------------------------------------------------- the cursor loop

  async poke(head: number): Promise<void> {
    if (Number.isSafeInteger(head)) this.sql.exec("UPDATE cursor SET head = MAX(head, ?) WHERE k = 1", head);
    // The alarm repeats the read if this one does not finish; the caller is not kept waiting for it.
    alarms.set(this.sql, POLL, Date.now() + POLL_MS);
    this.ctx.waitUntil(this.work().catch((error) => this.emit("delivery.read_failed", { error: errorText(error) }, "warn")));
  }

  async status(): Promise<{ cursor: number; behind: number; dead: number }> {
    const { n, head } = this.position();
    return { cursor: n, behind: Math.max(0, head - n), dead: this.sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM _dead")[0]!.c };
  }

  override async alarm(): Promise<void> {
    await alarms.run(
      this.sql,
      Date.now(),
      {
        [POLL]: () => this.read(),
        [WAKE]: () => this.wakeDue(),
        [OWED_PURPOSE]: () => this.runOwed(),
      },
      (purpose, error) => this.emit("delivery.alarm_failed", { purpose, error: errorText(error) }, "warn"),
    );
    const dead = this.sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM _dead")[0]!.c;
    if (dead > 0) this.emit("delivery.dead", { dead }, "error");
  }

  private position(): { n: number; head: number } {
    return this.sql.exec<{ n: number; head: number }>("SELECT n, head FROM cursor WHERE k = 1")[0]!;
  }

  private async work(): Promise<void> {
    await this.read();
    await this.runOwed();
  }

  /** One read at a time; a poke during a read is covered by the read's own loop to the head. */
  private read(): Promise<void> {
    this.reading ??= this.readToHead().finally(() => {
      this.reading = null;
    });
    return this.reading;
  }

  private async readToHead(): Promise<void> {
    const org = orgOf(this.env, this.org) as OrgForDelivery;
    for (;;) {
      const from = this.position().n;
      const page = await org.occurrences(platformPrincipal(this.org), { after: cursor.encode("o", [from]), limit: PAGE });
      if ("reset" in page) {
        // Org does not know this position: nothing to do but say so. The cursor stays.
        this.emit("delivery.cursor_refused", { cursor: from }, "error");
        alarms.clear(this.sql, POLL);
        return;
      }
      const to = Number(cursor.read("o", page.to)?.[0] ?? from);
      const entries = page.entries
        .map((entry) => ({ entry, n: Number(cursor.read("o", entry.n)?.[0] ?? entry.n) }))
        .filter(({ n }) => Number.isSafeInteger(n) && n > from)
        .sort((a, b) => a.n - b.n);
      // What a handler must ask Org is asked before the transaction, which cannot wait.
      const targets = new Map<number, string[]>();
      if (this.kind === "wake") {
        await Promise.all(
          entries.filter(({ entry }) => WAKE_KINDS.includes(entry.kind)).map(async ({ n }) => targets.set(n, await org.wakeTargets(n))),
        );
      }
      const now = Date.now();
      this.sql.transaction(() => {
        if (this.position().n !== from) return;
        for (const { entry, n } of entries) this.handle(entry, n, targets.get(n) ?? [], now);
        const next = Math.max(to, entries.at(-1)?.n ?? from);
        this.sql.exec("UPDATE cursor SET n = ?, head = MAX(head, ?) WHERE k = 1", next, next);
      });
      if (this.kind === "wake") this.armWake();
      const { n, head } = this.position();
      if (n === from || entries.length < PAGE) {
        // Caught up with what Org holds. Still short of a poke's head: the alarm reads again.
        if (n < head) alarms.set(this.sql, POLL, Date.now() + POLL_MS);
        else alarms.clear(this.sql, POLL);
        return;
      }
    }
  }

  /** Records what one occurrence asks of this kind. Runs inside the transaction that advances the cursor. */
  private handle(entry: Occurrence, n: number, targets: string[], now: number): void {
    if (this.kind === "webhook") {
      for (const endpoint of this.sql.exec<EndpointRecord>("SELECT * FROM endpoint WHERE enabled = 1 ORDER BY id")) {
        const kinds = JSON.parse(endpoint.kinds) as string[];
        if (kinds.length > 0 && !kinds.includes(entry.kind)) continue;
        owed.add(this.sql, { group: `endpoint:${endpoint.id}`, call: "webhook", body: { endpoint: endpoint.id, n, occurrence: entry }, schedule: RETRY_MS });
      }
      return;
    }
    if (this.kind === "slack") {
      if (!SLACK_KINDS.includes(entry.kind)) return;
      owed.add(this.sql, { group: `slack:${entry.sessionId ?? "machine"}`, call: "slack", body: { n }, schedule: RETRY_MS });
      return;
    }
    for (const target of new Set(targets)) {
      // An agent is not woken by its own act.
      if (entry.by === `agent:${target}`) continue;
      this.sql.exec(
        "INSERT INTO pending (target, first_n, last_n, due_at) VALUES (?, ?, ?, ?) ON CONFLICT(target) DO UPDATE SET last_n = excluded.last_n",
        target,
        n,
        n,
        now + WAKE_DEBOUNCE_MS,
      );
    }
  }

  // ---------------------------------------------------------------- wake

  private armWake(): void {
    const next = this.sql.exec<{ at: number | null }>("SELECT MIN(due_at) AS at FROM pending")[0]?.at;
    if (next !== null && next !== undefined) alarms.set(this.sql, WAKE, next);
  }

  /** A pending wake whose time has come becomes an owed call, and what arrives after it a new batch. */
  private async wakeDue(): Promise<void> {
    this.sql.transaction(() => {
      const due = this.sql.exec<{ target: string; first_n: number; last_n: number }>(
        "DELETE FROM pending WHERE due_at <= ? RETURNING target, first_n, last_n",
        Date.now(),
      );
      for (const row of due) {
        owed.add(this.sql, { group: `wake:${row.target}`, call: "wake", body: { target: row.target, firstN: row.first_n, lastN: row.last_n }, schedule: RETRY_MS });
      }
    });
    this.armWake();
    await this.runOwed();
  }

  // ---------------------------------------------------------------- the owed calls

  private runOwed(): Promise<void> {
    return owed.run(this.sql, (call, body) => this.send(call, body), Date.now());
  }

  private async send(call: string, body: unknown): Promise<void> {
    const org = orgOf(this.env, this.org) as OrgForDelivery;
    if (call === "webhook") {
      const { endpoint: id, n, occurrence } = body as { endpoint: string; n: number; occurrence: Occurrence };
      const endpoint = this.sql.exec<EndpointRecord>("SELECT * FROM endpoint WHERE id = ? AND enabled = 1", id)[0];
      if (!endpoint) return;
      // Whether the endpoint's creator may see this occurrence is Org's to say, at each delivery:
      // the read is made as the creator, and an occurrence it does not return is not sent.
      const seen = await org.occurrences(this.creator(endpoint), { after: cursor.encode("o", [n - 1]), limit: 1 });
      if ("reset" in seen || seen.entries[0]?.key !== occurrence.key) return;
      return post(endpoint, occurrence.key, JSON.stringify(occurrence), Date.now());
    }
    if (call === "wake") {
      const { target, firstN, lastN } = body as { target: string; firstN: number; lastN: number };
      const input = await org.digest(target, firstN, lastN);
      if (!input) return;
      const accepted = await logOf(this.env, target).accept(platformPrincipal(this.org), {
        id: await wakeTurnId(target, lastN),
        kind: "turn",
        body: { input, ifBusy: "queue" },
      });
      // A full inbox empties; any other refusal (the session is gone, or took this turn already) will not change.
      if (!accepted.ok && accepted.code === "inbox_full") throw new Error("The target's inbox is full.");
      if (!accepted.ok) this.emit("delivery.wake_refused", { target, code: accepted.code }, "warn");
      return;
    }
    if (call === "slack") {
      const echo = await org.echo((body as { n: number }).n);
      if (!echo) return;
      if (echo.kind === "refused" ? !echo.threadKey : echo.threadKeys.length === 0) return;
      return slackOf(this.env, this.org).notify(echo);
    }
    throw new Error(`Unknown owed call ${call}.`);
  }

  /** The principal an endpoint reads as: its creator's audiences, kept when it was made. */
  private creator(endpoint: EndpointRecord): Principal {
    const key = endpoint.created_by.startsWith("key:");
    return {
      org: this.org,
      subject: endpoint.created_by.replace(/^(user|key):/, ""),
      kind: key ? "key" : "member",
      via: "api",
      scopes: ["work:read"],
      audiences: JSON.parse(endpoint.audiences) as string[],
      admin: false,
      credential: { id: `webhook:${endpoint.id}`, expiresAt: null },
    };
  }

  // ---------------------------------------------------------------- endpoints (webhook only)

  private refusal(p: Principal, scope: "work:read" | "work:write"): Refusal | null {
    if (this.kind !== "webhook") return refuse("not_found", 404, "Not found.");
    if (p.org !== this.org) return refuse("not_found", 404, "Not found.");
    if (p.kind !== "member" && p.kind !== "key") return refuse("forbidden", 403, "An agent does not manage webhooks.");
    if (!p.scopes.includes(scope) && !p.scopes.includes("work:write")) return refuse("forbidden", 403, `Requires ${scope}.`);
    return null;
  }

  async setEndpoint(p: Principal, id: string, e: EndpointInput): Promise<Reply<{ endpoint: Endpoint }>> {
    const refused = this.refusal(p, "work:write");
    if (refused) return refused;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return refuse("invalid_request", 400, "The id is 1 to 64 letters, digits, - or _.");
    if (!e || typeof e !== "object") return refuse("invalid_request", 400, "The body must be a JSON object.");
    const bad = typeof e.url === "string" ? urlRefusal(e.url) : "The URL is required.";
    if (bad) return refuse("invalid_request", 400, bad);
    const kinds = e.kinds ?? [];
    if (!Array.isArray(kinds) || kinds.length > 64 || !kinds.every((kind) => typeof kind === "string" && kind.length <= 64)) {
      return refuse("invalid_request", 400, "kinds is a list of occurrence kinds.");
    }
    const existing = this.sql.exec<EndpointRecord>("SELECT * FROM endpoint WHERE id = ?", id)[0];
    if (!existing && this.sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM endpoint")[0]!.c >= MAX_ENDPOINTS) {
      return refuse("limit_reached", 409, `An organization has at most ${MAX_ENDPOINTS} webhooks.`);
    }
    // The secret is made once and survives an update; the creator and its audiences are whoever set it last.
    const secret = existing?.secret ?? `whsec_${base64url.encode(crypto.getRandomValues(new Uint8Array(32)))}`;
    this.sql.exec(
      `INSERT INTO endpoint (id, url, secret, kinds, created_by, audiences, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET url = excluded.url, kinds = excluded.kinds, created_by = excluded.created_by, audiences = excluded.audiences, enabled = excluded.enabled`,
      id,
      e.url,
      secret,
      JSON.stringify(kinds),
      p.kind === "key" ? `key:${p.subject}` : byOf(p),
      JSON.stringify(p.audiences),
      e.enabled === false ? 0 : 1,
    );
    const row = this.sql.exec<EndpointRecord>("SELECT * FROM endpoint WHERE id = ?", id)[0]!;
    return { ok: true, endpoint: { ...publicEndpoint(row), ...(existing ? {} : { secret }) } };
  }

  async listEndpoints(p: Principal): Promise<Reply<{ endpoints: Endpoint[] }>> {
    const refused = this.refusal(p, "work:read");
    if (refused) return refused;
    return { ok: true, endpoints: this.sql.exec<EndpointRecord>("SELECT * FROM endpoint ORDER BY id").map(publicEndpoint) };
  }

  async removeEndpoint(p: Principal, id: string): Promise<Reply<{ removed: boolean }>> {
    const refused = this.refusal(p, "work:write");
    if (refused) return refused;
    const removed = this.sql.transaction(() => {
      owed.drop(this.sql, { group: `endpoint:${id}` });
      return this.sql.exec("DELETE FROM endpoint WHERE id = ? RETURNING id", id).length > 0;
    });
    return { ok: true, removed };
  }
}
