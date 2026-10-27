import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";
import {
  decodeFirstTouch,
  encodeFirstTouch,
  firstTouchFromRequest,
  firstTouchSetCookie,
  signupAttributionRow,
  signupChannel,
  signupPostHogEvent,
  type FirstTouch,
} from "./signup_attribution";

// The callback test runs the edge's SQL against the real schema: the snapshot,
// then every migration statement it does not already contain, in node:sqlite (see agent_feedback.test.ts for why
// the builtins are reached this way).
interface SqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
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
    this.params = p;
    return this;
  }
  private args(): unknown[] {
    return this.params.map((v) => (v === undefined ? null : v));
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.args()) as T | undefined) ?? null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.prepare(this.sql).all(...this.args()) as T[] };
  }
  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const out = this.db.prepare(this.sql).run(...this.args()) as { changes?: number | bigint };
    return { success: true, meta: { changes: Number(out?.changes ?? 0) } };
  }
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

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const NOW_SEC = NOW / 1000;

const nav = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, { headers: { "sec-fetch-dest": "document", ...headers } });

describe("first-touch cookie", () => {
  it("captures campaign parameters, the external referrer and the landing path", () => {
    const ft = firstTouchFromRequest(
      nav("https://opencomputer.dev/pricing?utm_source=google&utm_medium=cpc&utm_campaign=launch&gclid=abc&email=a@b.c", {
        referer: "https://www.google.com/search?q=sandboxes",
      }),
      NOW,
    );
    expect(ft).toEqual({
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "launch",
      gclid: "abc",
      referrer: "https://www.google.com/search",
      landing: "/pricing",
      ts: NOW_SEC,
    });
  });

  it("drops internal referrers", () => {
    for (const referer of ["https://opencomputer.dev/", "https://app.opencomputer.dev/x", "https://docs.opencomputer.dev/"]) {
      expect(firstTouchFromRequest(nav("https://app.opencomputer.dev/", { referer }), NOW).referrer).toBeUndefined();
    }
  });

  it("round-trips and caps values", () => {
    const ft = firstTouchFromRequest(nav(`https://opencomputer.dev/?utm_campaign=${"x".repeat(500)}&ref=ünï`), NOW);
    const back = decodeFirstTouch(encodeFirstTouch(ft))!;
    expect(back.utm_campaign).toHaveLength(100);
    expect(back.ref).toBe("ünï");
    expect(back.ts).toBe(NOW_SEC);
  });

  it("decodes bad cookies to null, never throwing", () => {
    for (const raw of [null, "", "!!!", "e30", btoa("[1]"), btoa("not json"), "A".repeat(5000), "_-_-"]) {
      const out = decodeFirstTouch(raw);
      expect(out === null || Object.keys(out).length === 0).toBe(true);
    }
    expect(decodeFirstTouch(encodeFirstTouch({ utm_source: 5, evil: "x", ts: "now" } as unknown as FirstTouch))).toEqual({});
  });

  it("is set on a first page view only, on the shared domain", () => {
    const cookie = firstTouchSetCookie(nav("https://opencomputer.dev/?utm_source=test"), NOW)!;
    expect(cookie).toMatch(/^oc_ft=[A-Za-z0-9_-]+; Domain=\.opencomputer\.dev; Path=\/; Max-Age=7776000; Secure; SameSite=Lax$/);
    expect(firstTouchSetCookie(nav("https://opencomputer.dev/", { cookie: "a=1; oc_ft=xyz" }))).toBeNull();
    expect(firstTouchSetCookie(new Request("https://opencomputer.dev/x.js", { headers: { "sec-fetch-dest": "script" } }))).toBeNull();
    expect(firstTouchSetCookie(new Request("https://opencomputer.dev/", { method: "POST", headers: { "sec-fetch-dest": "document" } }))).toBeNull();
    // Off opencomputer.dev (dev environments) the cookie is host-only.
    expect(firstTouchSetCookie(nav("https://app2.opensandbox.ai/"))).not.toContain("Domain=");
  });
});

describe("signupChannel", () => {
  it.each<[FirstTouch | null, string]>([
    [null, "unknown"],
    [{ ts: 1 }, "direct"],
    [{ landing: "/" }, "direct"],
    [{ gclid: "x" }, "google_ads"],
    [{ utm_source: "google", utm_medium: "cpc" }, "google_ads"],
    [{ utm_source: "Google", utm_medium: "paid_search" }, "google_ads"],
    [{ utm_source: "linkedin", utm_medium: "paid_social" }, "other_paid"],
    [{ utm_source: "bing", utm_medium: "cpc" }, "other_paid"],
    [{ li_fat_id: "x" }, "other_paid"],
    [{ utm_source: "google" }, "organic_search"],
    [{ utm_source: "google", utm_medium: "organic" }, "organic_search"],
    [{ referrer: "https://www.google.co.uk/" }, "organic_search"],
    [{ referrer: "https://duckduckgo.com/" }, "organic_search"],
    [{ utm_source: "x" }, "social"],
    [{ utm_source: "newsletter", utm_medium: "social" }, "social"],
    [{ ref: "hn" }, "social"],
    [{ fbclid: "x" }, "social"],
    [{ referrer: "https://t.co/abc" }, "social"],
    [{ referrer: "https://www.linkedin.com/feed/" }, "social"],
    [{ referrer: "https://old.reddit.com/r/x" }, "social"],
    [{ referrer: "https://news.ycombinator.com/item" }, "social"],
    [{ referrer: "https://github.com/diggerhq/opencomputer" }, "referral"],
    [{ ref: "producthunt" }, "referral"],
    [{ utm_source: "newsletter", utm_medium: "email" }, "referral"],
  ])("%j is %s", (ft, channel) => {
    expect(signupChannel(ft)).toBe(channel);
  });
});

describe("signup row and PostHog event", () => {
  it("stores the cookie's fields and sends click ids as booleans only", () => {
    const cookie = encodeFirstTouch({ utm_source: "test", gclid: "g1", landing: "/", ts: 100 });
    const row = signupAttributionRow(
      { userId: "u1", orgId: "o1", client: "web", authMethod: "GoogleOAuth", planIntent: "pro", cookie },
      NOW_SEC,
    );
    expect(row).toMatchObject({ utm_source: "test", gclid: "g1", channel: "google_ads", auth_method: "GoogleOAuth", first_seen_at: 100 });
    const event = signupPostHogEvent("phc", row, "o1");
    expect(event).toMatchObject({ event: "signed_up", distinct_id: "u1" });
    expect(event.properties).toMatchObject({ has_gclid: true, utm_source: "test", channel: "google_ads", plan_intent: "pro" });
    expect(JSON.stringify(event)).not.toContain("g1");
  });

  it("records no cookie as unknown", () => {
    const row = signupAttributionRow({ userId: "u1", orgId: "o1", client: "cli", authMethod: 7, planIntent: null, cookie: null }, NOW_SEC);
    expect(row).toMatchObject({ channel: "unknown", client: "cli", auth_method: null, utm_source: null });
  });
});

describe("browser signup records attribution", () => {
  let db: DatabaseSync;
  let posthog: Array<Record<string, unknown>>;
  let env: Env;
  const ctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

  beforeEach(() => {
    db = schemaDB();
    posthog = [];
    env = {
      OPENCOMPUTER_DB: {
        prepare: (sql: string) => new Stmt(db, sql),
        batch: async (stmts: Stmt[]) => Promise.all(stmts.map((s) => s.run())),
      },
      SESSION_JWT_SECRET: "test-secret",
      WORKOS_API_KEY: "sk_test",
      WORKOS_CLIENT_ID: "client_test",
      WORKER_ENV: "test",
      POSTHOG_PROJECT_TOKEN: "phc_test",
    } as unknown as Env;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (String(url).includes("posthog")) {
        posthog.push(JSON.parse(String(init?.body)));
        return new Response("{}");
      }
      return Response.json({
        user: { id: "wos_1", email: "new@example.com", first_name: "New" },
        access_token: "x.e30.y",
        authentication_method: "GitHubOAuth",
      });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const callback = (cookie?: string) =>
    worker.fetch(
      new Request("https://app.opencomputer.dev/auth/callback?code=c1", cookie ? { headers: { cookie } } : {}),
      env,
      ctx,
    );

  it("stores the first touch and auth method once, for the new user only", async () => {
    const ft = encodeFirstTouch({ utm_source: "test", landing: "/", ts: 100 });
    const res = await callback(`oc_ft=${ft}`);
    expect(res.status).toBe(302);
    const rows = db.prepare("SELECT * FROM signup_attribution").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ utm_source: "test", channel: "referral", client: "web", auth_method: "GitHubOAuth", landing_path: "/" });
    expect(posthog.map((e) => e.event)).toEqual(["signed_up"]);

    // A second login by the same user is not a signup.
    await callback(`oc_ft=${encodeFirstTouch({ utm_source: "other" })}`);
    expect(db.prepare("SELECT utm_source FROM signup_attribution").all()).toEqual([{ utm_source: "test" }]);
    expect(posthog).toHaveLength(1);
  });

  it("records a signup retried after a partial first callback, once", async () => {
    // The first callback inserted the user, then failed before the workspace existed.
    const nowSec = Math.floor(Date.now() / 1000);
    db.prepare("INSERT INTO users (id, email, workos_user_id, name, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("u_partial", "new@example.com", "wos_1", "New", nowSec - 30);
    const res = await callback(`oc_ft=${encodeFirstTouch({ utm_source: "retry" })}`);
    expect(res.status).toBe(302);
    expect(db.prepare("SELECT user_id, utm_source FROM signup_attribution").all()).toEqual([
      { user_id: "u_partial", utm_source: "retry" },
    ]);
    await callback(`oc_ft=${encodeFirstTouch({ utm_source: "retry" })}`);
    expect(posthog.map((e) => e.event)).toEqual(["signed_up"]);
  });

  it("does not attribute an existing account's login", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    db.prepare("INSERT INTO users (id, email, workos_user_id, name, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("u_old", "new@example.com", "wos_1", "New", nowSec - 2 * 60 * 60);
    const res = await callback(`oc_ft=${encodeFirstTouch({ utm_source: "late" })}`);
    expect(res.status).toBe(302);
    expect(db.prepare("SELECT * FROM signup_attribution").all()).toEqual([]);
    expect(posthog).toEqual([]);
  });

  it("logs in with a garbage cookie, recording unknown fields", async () => {
    const res = await callback("oc_ft=%%%garbage");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://app.opencomputer.dev/dashboard");
    expect(db.prepare("SELECT channel FROM signup_attribution").all()).toEqual([{ channel: "unknown" }]);
  });

  it("logs in when the attribution insert fails", async () => {
    db.exec("DROP TABLE signup_attribution");
    const res = await callback(`oc_ft=${encodeFirstTouch({ utm_source: "test" })}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toContain("oc_session=");
  });
});
