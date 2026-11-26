// DeliveryDurableObject (tracks and threads, spec sections 35.3, 36.5 and 40.6): a reader of the
// organization's occurrence stream with its own cursor, one per organization and kind of
// destination, named `<org>:<kind>`. Two handlers behind one cursor loop: `wake` (a turn for a
// track's agent or a parent session) and `slack` (the echo). Each occurrence it must act on is an owed call
// written in the transaction that advances the cursor, so a slow destination delays neither the
// read nor another destination.

import { DurableObject } from "cloudflare:workers";

import {
  type ActorEnv,
  type DeliveryKind,
  type Occurrence,
  type Sql,
  alarms,
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
import type { DeliveryRpc } from "../actor/contracts.js";
import {
  DELIVERY_KINDS,
  type OrgForDelivery,
  PAGE,
  POLL_MS,
  RETRY_MS,
  SLACK_KINDS,
  WAKE_DEBOUNCE_MS,
  WAKE_KINDS,
} from "./contract.js";

const POLL = "poll";
const WAKE = "wake";


/** A wake's turn id: the same for the same target and last occurrence, so a repeat is a duplicate. */
async function wakeTurnId(target: string, lastN: number): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${target}:${lastN}`)));
  return `tn_${[...digest.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export class DeliveryDurableObject extends DurableObject<ActorEnv> implements DeliveryRpc {
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
      (sql) => {
        // Endpoints are Svix's; the row says the organization's Svix application exists, so an
        // organization that never made a webhook sends Svix nothing.
        sql.exec("DROP TABLE endpoint");
        sql.exec("DELETE FROM _owed WHERE call = 'webhook'");
        sql.exec("CREATE TABLE svix (k INTEGER PRIMARY KEY CHECK (k = 1))");
      },
      (sql) => {
        // Customer webhooks are gone: nothing is handed to Svix any more.
        sql.exec("DROP TABLE svix");
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
    return owed.run(this.sql, (call, body) => this.send(call, body), Date.now(), this.emit);
  }

  private async send(call: string, body: unknown): Promise<void> {
    const org = orgOf(this.env, this.org) as OrgForDelivery;
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
}
