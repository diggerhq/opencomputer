import { afterEach, describe, expect, it, vi } from "vitest";
import { emitBillingEvent } from "./billing_events";
import {
  alertChannel,
  alertForBillingEvent,
  runActivationAlerts,
  sendSlackAlert,
  teammateInvitedAlert,
  trialEndedAlert,
  type Alert,
} from "./slack_alerts";

// The SQL runs against the real schema (snapshot plus migrations) in node:sqlite,
// as in slack_connect.test.ts; this shim also reports meta.changes, which the
// claim depends on.
interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes: number | bigint };
}
interface DatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}
declare const process: { cwd(): string; getBuiltinModule(id: string): unknown };
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as { DatabaseSync: new (path: string) => DatabaseSync };
const fs = process.getBuiltinModule("node:fs") as {
  readFileSync(path: string, enc: "utf8"): string;
  readdirSync(path: string): string[];
};

class Stmt {
  private params: unknown[] = [];
  constructor(private db: DatabaseSync, private sql: string) {}
  bind(...p: unknown[]): this {
    this.params = p.map((v) => (v === undefined ? null : v));
    return this;
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.params) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.params) as T[] };
  }
  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { success: true, meta: { changes: Number(r.changes) } };
  }
}

function d1(db: DatabaseSync): D1Database {
  return { prepare: (sql: string) => new Stmt(db, sql) } as unknown as D1Database;
}

function schemaDB(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  const root = process.cwd();
  db.exec(fs.readFileSync(`${root}/schema-snapshots/current_schema.sql`, "utf8"));
  for (const file of fs.readdirSync(`${root}/migrations`).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = fs.readFileSync(`${root}/migrations/${file}`, "utf8").replace(/^\s*--.*$/gm, "");
    for (const statement of sql.split(/;\s*$/m).filter((s) => s.trim())) {
      try {
        db.exec(statement);
      } catch (err) {
        if (!/already exists|duplicate column/.test(String(err))) throw err;
      }
    }
  }
  return db;
}

// blue's migrations 0001 + 0004.
function sessionsDB(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE session_creations (
    session_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL,
    countable INTEGER NOT NULL DEFAULT 1, exclusion_reason TEXT, outcome_at TEXT)`);
  return db;
}

const NOW = Date.parse("2026-10-28T12:00:00Z");
let seq = 0;

function addOrg(
  db: DatabaseSync,
  email: string,
  opts: { name?: string; plan?: string; attribution?: Record<string, string> } = {},
): string {
  const n = ++seq;
  const userID = `user-${n}`;
  const orgID = `org-${n}`;
  db.prepare(`INSERT INTO users (id, email, created_at) VALUES (?, ?, 0)`).run(userID, email);
  db.prepare(
    `INSERT INTO orgs (id, name, slug, plan, home_cell, owner_user_id, created_at, updated_at, usage_plan)
     VALUES (?, ?, ?, 'free', 'c', ?, 0, 0, ?)`,
  ).run(orgID, opts.name ?? `${email}'s workspace`, `slug-${n}`, userID, opts.plan ?? "base");
  if (opts.attribution) {
    const a = { channel: "unknown", client: "web", created_at: "0", ...opts.attribution };
    const cols = Object.keys(a);
    db.prepare(
      `INSERT INTO signup_attribution (user_id, ${cols.join(", ")}) VALUES (?, ${cols.map(() => "?").join(", ")})`,
    ).run(userID, ...Object.values(a));
  }
  return orgID;
}

function slack(fail = false) {
  const posts: Array<{ channel: string; text: string }> = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (fail) return new Response(JSON.stringify({ ok: false, error: "not_in_channel" }), { status: 200 });
    posts.push({ channel: body.channel, text: body.text });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  return { posts, fetchImpl };
}

function env(db: DatabaseSync, extra: Record<string, unknown> = {}) {
  return { OPENCOMPUTER_DB: d1(db), SLACK_CONNECT_TOKEN: "xoxb-test", SIGNUPS_SLACK_CHANNEL: "#signups", ...extra };
}

describe("billing-event alerts", () => {
  it("posts a work-email signup once, with its attribution", async () => {
    const db = schemaDB();
    const org = addOrg(db, "jane@acme.com", {
      name: "Acme",
      attribution: {
        channel: "google_ads",
        utm_source: "google",
        utm_medium: "cpc",
        utm_campaign: "launch-oct",
        utm_term: "ai <agents>",
        gclid: "abc",
        landing_path: "/pricing",
        first_seen_at: "1000000",
        created_at: "1259200",
        auth_method: "GitHubOAuth",
        plan_intent: "pro",
      },
    });
    const { posts, fetchImpl } = slack();
    const alert = alertForBillingEvent({}, "billing.trial_started", org, {}, NOW)!;
    expect(await sendSlackAlert(env(db), alert, fetchImpl, NOW)).toBe(true);
    // A replayed webhook or a concurrent projection posts nothing.
    expect(await sendSlackAlert(env(db), alert, fetchImpl, NOW)).toBe(false);
    expect(posts).toEqual([
      {
        channel: "#signups",
        text: [
          "🟢 jane@acme.com signed up · Acme · Google Ads / launch-oct · GitHub login · clicked Pro",
          "> UTM: source google, medium cpc, term ai &lt;agents&gt;",
          "> Ad click: Google",
          "> Landed on: /pricing",
          "> First visit: 3 days before signup",
        ].join("\n"),
      },
    ]);
  });

  it("alerts free-email signups and skips every internal account", async () => {
    const db = schemaDB();
    const { posts, fetchImpl } = slack();
    const free = addOrg(db, "joe@gmail.com");
    const staff = addOrg(db, "mo@opencomputer.dev");
    const staffGmail = addOrg(db, "i.zalutski+test@gmail.com");
    for (const org of [free, staff, staffGmail]) {
      await sendSlackAlert(env(db), alertForBillingEvent({}, "billing.trial_started", org, {}, NOW)!, fetchImpl, NOW);
    }
    await sendSlackAlert(env(db), trialEndedAlert(staff, "days"), fetchImpl, NOW);
    expect(posts).toHaveLength(1);
    expect(posts[0].text).toMatch(/^🟢 joe@gmail\.com signed up/);
  });

  it("renders each revenue event", async () => {
    const db = schemaDB();
    const org = addOrg(db, "sam@globex.io", { name: "Globex", plan: "pro", attribution: { channel: "referral", referrer: "https://news.ycombinator.com/item" } });
    const { posts, fetchImpl } = slack();
    const events: Array<[string, Record<string, string | number | boolean | null>]> = [
      ["billing.plan_changed", { from: "base", to: "pro", kind: "trial_converted" }],
      ["billing.plan_changed", { from: "pro", to: "max", kind: "upgrade" }],
      ["billing.plan_changed", { from: "max", to: "pro", kind: "downgrade" }],
      ["billing.plan_changed", { from: "pro", to: "base", kind: "cancel" }],
      ["billing.plan_changed", { from: "pro", to: "base", kind: "lapsed" }],
      ["billing.payment_failed", { plan: "pro" }],
      ["billing.payment_recovered", { plan: "pro" }],
      ["billing.payment_failed", { plan: "top_up", reason: "card_declined" }],
      ["billing.credits_purchased", { amount: 99, auto: false }],
      ["billing.credits_purchased", { amount: 250, auto: true }],
      ["billing.work_minutes_recorded", { minutes: 3 }],
    ];
    for (const [name, data] of events) {
      const alert = alertForBillingEvent({}, name, org, data, NOW);
      if (alert) await sendSlackAlert(env(db), alert, fetchImpl, NOW);
    }
    await sendSlackAlert(env(db), teammateInvitedAlert(org, "kim@globex.io"), fetchImpl, NOW);
    await sendSlackAlert(env(db), teammateInvitedAlert(org, "kim@globex.io"), fetchImpl, NOW);
    const ctx = "Globex · Pro · Referral (news.ycombinator.com)";
    expect(posts.map((p) => p.text)).toEqual([
      `💰 sam@globex.io converted to Pro · ${ctx}`,
      `📈 sam@globex.io upgraded Pro → Max · ${ctx}`,
      `📉 sam@globex.io downgraded Max → Pro · ${ctx}`,
      `📉 sam@globex.io cancelled Pro · ${ctx}`,
      // Same transition and day as the cancel: one post.
      `🔴 sam@globex.io had a payment fail · ${ctx}`,
      `✅ sam@globex.io recovered a failed payment · ${ctx}`,
      `🔴 sam@globex.io had an auto top-up payment fail · ${ctx} · card_declined`,
      `💳 sam@globex.io bought $250 of credits (auto top-up) · ${ctx}`,
      `👥 sam@globex.io invited kim@globex.io · ${ctx}`,
    ]);
  });

  it("routes a kind to its own channel", () => {
    const e = { SIGNUPS_SLACK_CHANNEL: "#signups", SLACK_ALERT_CHANNELS: "payment_failed=C0REV, converted = C0REV" };
    expect(alertChannel(e, "payment_failed")).toBe("C0REV");
    expect(alertChannel(e, "converted")).toBe("C0REV");
    expect(alertChannel(e, "trial_started")).toBe("#signups");
    expect(alertChannel({}, "trial_started")).toBeNull();
  });

  it("releases the claim when Slack refuses, so a retry posts", async () => {
    const db = schemaDB();
    const org = addOrg(db, "ann@initech.com");
    const alert: Alert = trialEndedAlert(org, "tokens");
    expect(await sendSlackAlert(env(db), alert, slack(true).fetchImpl, NOW)).toBe(false);
    const { posts, fetchImpl } = slack();
    expect(await sendSlackAlert(env(db), alert, fetchImpl, NOW)).toBe(true);
    expect(posts).toHaveLength(1);
  });

  it("is dormant without a token or channel", async () => {
    const db = schemaDB();
    const org = addOrg(db, "ann@initech.com");
    const { posts, fetchImpl } = slack();
    await sendSlackAlert(env(db, { SLACK_CONNECT_TOKEN: undefined }), trialEndedAlert(org, "days"), fetchImpl, NOW);
    await sendSlackAlert(env(db, { SIGNUPS_SLACK_CHANNEL: undefined }), trialEndedAlert(org, "days"), fetchImpl, NOW);
    expect(posts).toEqual([]);
  });
});

describe("emitBillingEvent", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("feeds the Slack sink alongside the analytics sinks", async () => {
    const db = schemaDB();
    const org = addOrg(db, "lee@hooli.com", { name: "Hooli" });
    const { posts, fetchImpl } = slack();
    vi.stubGlobal("fetch", fetchImpl);
    await emitBillingEvent(env(db), "billing.trial_started", { orgId: org, userId: "u", data: { via: "web" } });
    expect(posts.map((p) => p.text)).toEqual(["🟢 lee@hooli.com signed up · Hooli\n> No first-touch data (cookies blocked, or before attribution)"]);
  });
});

describe("activation alerts", () => {
  it("posts each org's first agent session once, never an older customer's", async () => {
    const db = schemaDB();
    const sessions = sessionsDB();
    const fresh = addOrg(db, "joe@gmail.com");
    const old = addOrg(db, "kay@umbrella.com");
    const staff = addOrg(db, "utpal@digger.dev");
    const add = sessions.prepare(`INSERT INTO session_creations (session_id, account_id, source, created_at, countable) VALUES (?, ?, ?, ?, ?)`);
    add.run("s0", fresh, "api", "2026-10-28T11:40:00.000Z", 0); // not countable: does not activate
    add.run("s1", fresh, "playground", "2026-10-28T11:50:00.000Z", 1);
    add.run("s2", fresh, "api", "2026-10-28T11:55:00.000Z", 1);
    add.run("s3", old, "api", "2026-10-20T09:00:00.000Z", 1);
    add.run("s4", old, "schedule", "2026-10-28T11:58:00.000Z", 1);
    add.run("s5", staff, "api", "2026-10-28T11:58:00.000Z", 1);
    const { posts, fetchImpl } = slack();
    const e = env(db, { SERVERLESS_AGENTS_DB: d1(sessions) });
    expect(await runActivationAlerts(e, NOW, fetchImpl)).toBe(1);
    expect(await runActivationAlerts(e, NOW + 300_000, fetchImpl)).toBe(0);
    expect(posts.map((p) => p.text)).toEqual(["🚀 joe@gmail.com ran their first agent session · trial · via playground"]);
  });

  it("is dormant without the session index", async () => {
    const db = schemaDB();
    expect(await runActivationAlerts(env(db), NOW, slack().fetchImpl)).toBe(0);
  });
});
