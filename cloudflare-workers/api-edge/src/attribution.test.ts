import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ATTRIBUTION_COOKIE_MAX_BYTES,
  attributionSetCookie,
  classifyChannel,
  loginAttributionSetCookie,
  mergeAttributionCookie,
  parseAttributionCookie,
  recordSignupAttribution,
  touchFromRequest,
  type Attribution,
  type Touch,
} from "./attribution";
import worker, { type Env } from "./index";

const NOW = 1_790_000_000;

function touch(over: Partial<Touch> = {}): Touch {
  return {
    t: NOW, src: null, med: null, cmp: null, term: null, cnt: null,
    ref: null, lp: "app.opencomputer.dev/", gclid: null, fbclid: null, ...over,
  };
}

function cookieHeader(a: unknown, extra = "oc_session=abc"): string {
  return `${extra}; oc_attr=${encodeURIComponent(JSON.stringify(a))}`;
}

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseAttributionCookie", () => {
  it("returns null when absent or malformed", () => {
    expect(parseAttributionCookie(null)).toBeNull();
    expect(parseAttributionCookie("")).toBeNull();
    expect(parseAttributionCookie("oc_session=abc")).toBeNull();
    expect(parseAttributionCookie("oc_attr=%E0%A4%A")).toBeNull(); // bad encoding
    expect(parseAttributionCookie("oc_attr=not-json")).toBeNull();
    expect(parseAttributionCookie(cookieHeader([1, 2]))).toBeNull();
    expect(parseAttributionCookie(cookieHeader({ v: 2, ft: touch() }))).toBeNull();
    expect(parseAttributionCookie(cookieHeader({ v: 1, ft: { src: "x" } }))).toBeNull(); // no t
  });

  it("parses a valid cookie among others and tolerates one bad touch", () => {
    const ft = touch({ src: "twitter", med: "social", ref: "t.co/abc" });
    const a = parseAttributionCookie(cookieHeader({ v: 1, ft, lt: "junk" }));
    expect(a).toEqual({ v: 1, ft, lt: null });
  });

  it("re-applies field caps and drops non-string fields", () => {
    const a = parseAttributionCookie(cookieHeader({ v: 1, ft: { t: NOW, src: "x".repeat(300), med: 5, ref: "r".repeat(500) } }));
    expect(a?.ft?.src).toHaveLength(100);
    expect(a?.ft?.med).toBeNull();
    expect(a?.ft?.ref).toHaveLength(200);
  });
});

describe("touchFromRequest (C1)", () => {
  it("records nothing without utm_*, click ids or an external referrer", () => {
    expect(touchFromRequest(req("https://app.opencomputer.dev/auth/login"), NOW)).toBeNull();
    expect(
      touchFromRequest(req("https://app.opencomputer.dev/auth/login", { referer: "https://opencomputer.dev/pricing" }), NOW),
    ).toBeNull();
    expect(
      touchFromRequest(req("https://app.opencomputer.dev/auth/login", { referer: "https://docs.opencomputer.dev/x" }), NOW),
    ).toBeNull();
  });

  it("normalizes utm values and strips queries from landing and referrer", () => {
    const t = touchFromRequest(
      req(
        "https://app.opencomputer.dev/auth/login?utm_source=%20Twitter%20&utm_medium=Social&utm_campaign=Launch&utm_term=a&utm_content=b&returnTo=/x",
        { referer: "https://t.co/abc?x=1#frag" },
      ),
      NOW,
    );
    expect(t).toEqual({
      t: NOW, src: "twitter", med: "social", cmp: "launch", term: "a", cnt: "b",
      ref: "t.co/abc", lp: "app.opencomputer.dev/auth/login", gclid: null, fbclid: null,
    });
  });

  it("records an external referrer alone, with src left null", () => {
    const t = touchFromRequest(req("https://app.opencomputer.dev/auth/login", { referer: "https://news.ycombinator.com/item?id=1" }), NOW);
    expect(t?.src).toBeNull();
    expect(t?.ref).toBe("news.ycombinator.com/item");
  });

  it("records click ids and caps lengths", () => {
    const long = "A".repeat(300);
    const t = touchFromRequest(req(`https://app.opencomputer.dev/auth/login?gclid=Abc123&utm_source=${long}`), NOW);
    expect(t?.gclid).toBe("Abc123");
    expect(t?.src).toHaveLength(100);
    expect(touchFromRequest(req("https://app.opencomputer.dev/?fbclid=F1"), NOW)?.fbclid).toBe("F1");
    const p = "/" + "p".repeat(400);
    expect(touchFromRequest(req(`https://app.opencomputer.dev${p}?utm_source=x`), NOW)?.lp).toHaveLength(200);
  });
});

describe("mergeAttributionCookie (C1)", () => {
  const decode = (v: string) => JSON.parse(decodeURIComponent(v)) as Attribution;

  it("writes ft and lt from the first touch", () => {
    const t = touch({ src: "google" });
    expect(decode(mergeAttributionCookie(null, t))).toEqual({ v: 1, ft: t, lt: t });
  });

  it("never overwrites ft, always overwrites lt", () => {
    const first = touch({ src: "twitter", t: NOW - 100 });
    const second = touch({ src: "newsletter", med: "email" });
    const merged = decode(mergeAttributionCookie(cookieHeader({ v: 1, ft: first, lt: first }), second));
    expect(merged.ft).toEqual(first);
    expect(merged.lt).toEqual(second);
  });

  it("replaces a malformed cookie as if absent", () => {
    const t = touch({ src: "bing" });
    expect(decode(mergeAttributionCookie("oc_attr=garbage", t))).toEqual({ v: 1, ft: t, lt: t });
  });

  it("stays within the 2 KB cap and keeps first-touch source", () => {
    const big = (s: string) => touch({
      src: s + "x".repeat(99), med: "m".repeat(100), cmp: "c".repeat(100), term: "é".repeat(100), cnt: "\u00ff".repeat(100),
      ref: "r.example/" + "%".repeat(190), lp: "app.opencomputer.dev/" + "é".repeat(179), gclid: "g".repeat(100), fbclid: "f".repeat(100),
    });
    const existing = cookieHeader({ v: 1, ft: big("a"), lt: big("a") });
    const value = mergeAttributionCookie(existing, big("b"));
    expect(`oc_attr=${value}`.length).toBeLessThanOrEqual(ATTRIBUTION_COOKIE_MAX_BYTES);
    const merged = decode(value);
    expect(merged.ft?.src).toBe(big("a").src);
    expect(merged.ft?.t).toBe(NOW);
  });
});

describe("attributionSetCookie", () => {
  it("scopes to .opencomputer.dev on prod hosts", () => {
    const c = attributionSetCookie("v", new URL("https://app.opencomputer.dev/auth/login"));
    expect(c).toBe("oc_attr=v; Domain=.opencomputer.dev; Path=/; Max-Age=7776000; SameSite=Lax; Secure");
  });

  it("is host-only elsewhere and drops Secure on http", () => {
    expect(attributionSetCookie("v", new URL("http://localhost:8787/auth/login"))).toBe(
      "oc_attr=v; Path=/; Max-Age=7776000; SameSite=Lax",
    );
  });

  it("loginAttributionSetCookie is null without a touch", () => {
    expect(loginAttributionSetCookie(req("https://app.opencomputer.dev/auth/login"), NOW)).toBeNull();
    expect(loginAttributionSetCookie(req("https://app.opencomputer.dev/auth/login?utm_source=x"), NOW)).toMatch(/^oc_attr=/);
  });
});

describe("classifyChannel (C4)", () => {
  it("applies the rules in order", () => {
    expect(classifyChannel(touch({ gclid: "g" }), "invite")).toBe("invite");
    expect(classifyChannel(touch({ gclid: "g" }), "cli")).toBe("cli");
    expect(classifyChannel(null, "browser")).toBe("direct");
    expect(classifyChannel(touch({ gclid: "g", med: "email" }), "browser")).toBe("paid_search");
    for (const med of ["cpc", "ppc", "paid"]) expect(classifyChannel(touch({ med, src: "twitter" }), "browser")).toBe("paid_search");
    for (const med of ["email", "newsletter"]) expect(classifyChannel(touch({ med, src: "google" }), "browser")).toBe("email");
  });

  it("maps the search and social tables from src or ref", () => {
    for (const src of ["google", "bing", "duckduckgo", "yahoo"]) expect(classifyChannel(touch({ src }), "browser")).toBe("organic_search");
    expect(classifyChannel(touch({ ref: "www.google.co.uk/" }), "browser")).toBe("organic_search");
    expect(classifyChannel(touch({ ref: "search.yahoo.com/search" }), "browser")).toBe("organic_search");
    for (const src of ["twitter", "x", "linkedin", "reddit", "facebook", "youtube", "github", "news.ycombinator", "t.co", "x.com"]) {
      expect(classifyChannel(touch({ src }), "browser")).toBe("social");
    }
    for (const ref of ["t.co/abc", "mobile.twitter.com/x", "www.linkedin.com/feed", "news.ycombinator.com/item", "old.reddit.com/r/x", "github.com/diggerhq"]) {
      expect(classifyChannel(touch({ ref }), "browser")).toBe("social");
    }
  });

  it("falls back to referral for other refs and other for untabled sources", () => {
    expect(classifyChannel(touch({ ref: "blog.example.com/post" }), "browser")).toBe("referral");
    expect(classifyChannel(touch({ src: "producthunt", ref: "producthunt.com/posts/x" }), "browser")).toBe("referral");
    expect(classifyChannel(touch({ src: "producthunt" }), "browser")).toBe("other");
    expect(classifyChannel(touch({ src: "producthunt", ref: "news.ycombinator.com/" }), "browser")).toBe("social");
  });
});

type Stmt = { sql: string; args: unknown[] };

function fakeDB(opts: { failInsert?: boolean } = {}) {
  const executed: Stmt[] = [];
  return {
    executed,
    prepare(sql: string) {
      const st = {
        args: [] as unknown[],
        bind(...a: unknown[]) { st.args = a; return st; },
        async run() {
          if (opts.failInsert) throw new Error("d1 down");
          executed.push({ sql, args: st.args });
          return { meta: { changes: 1 } };
        },
      };
      return st;
    },
  };
}

function signupReq(cookie?: string): Request {
  const headers: Record<string, string> = { "user-agent": "UA/1.0", "x-forwarded-for": "203.0.113.7" };
  if (cookie) headers.cookie = cookie;
  return new Request("https://app.opencomputer.dev/auth/callback?code=c", { headers });
}

describe("recordSignupAttribution (C4/C5)", () => {
  it("inserts the row then hands both emits to waitUntil", async () => {
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const db = fakeDB();
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } };
    const ft = touch({ src: "twitter", med: "social", cmp: "launch", ref: "t.co/abc", t: NOW - 50, gclid: null });
    const lt = touch({ src: "newsletter", med: "email" });
    const req = signupReq(cookieHeader({ v: 1, ft, lt }));
    const env = { OPENCOMPUTER_DB: db as unknown as D1Database, POSTHOG_PROJECT_TOKEN: "phc_test", PLAUSIBLE_DOMAIN: "opencomputer.dev" };

    const rec = await recordSignupAttribution(env, ctx, { userID: "u1", entry: "browser", cookie: req.headers.get("cookie"), req, nowSec: NOW });
    expect(rec?.channel).toBe("social");
    expect(db.executed).toHaveLength(1);
    expect(db.executed[0].sql).toContain("INSERT INTO signup_attribution");
    expect(db.executed[0].args).toEqual([
      "u1", "browser", "social",
      "twitter", "social", "launch", null, null, "t.co/abc", "app.opencomputer.dev/", NOW - 50,
      "newsletter", "email", null, null, null, null, "app.opencomputer.dev/", NOW,
      null, null, NOW,
    ]);
    expect(waits).toHaveLength(1);
    await Promise.all(waits);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [phURL, phInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(phURL).toBe("https://us.i.posthog.com/capture/");
    const ph = JSON.parse(String(phInit.body));
    expect(ph).toMatchObject({
      api_key: "phc_test", event: "signed_up", distinct_id: "u1",
      properties: {
        channel: "social", entry: "browser", source: "twitter", medium: "social", campaign: "launch",
        referrer: "t.co/abc", landing: "app.opencomputer.dev/",
        $set_once: { signup_channel: "social", signup_source: "twitter", signup_medium: "social", signup_campaign: "launch", signup_referrer: "t.co/abc" },
      },
    });

    const [plURL, plInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(plURL).toBe("https://plausible.io/api/event");
    expect(JSON.parse(String(plInit.body))).toEqual({
      name: "Signup", url: "https://app.opencomputer.dev/auth/callback", domain: "opencomputer.dev",
      props: { channel: "social", source: "twitter", campaign: "launch" },
    });
    const h = plInit.headers as Record<string, string>;
    expect(h["user-agent"]).toBe("UA/1.0");
    expect(h["x-forwarded-for"]).toBe("203.0.113.7");
  });

  it("honours POSTHOG_HOST and skips unset vars", async () => {
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } };
    const db = fakeDB();
    await recordSignupAttribution(
      { OPENCOMPUTER_DB: db as unknown as D1Database },
      ctx,
      { userID: "u2", entry: "browser", cookie: null, req: signupReq(), nowSec: NOW },
    );
    expect(db.executed[0].args.slice(0, 3)).toEqual(["u2", "browser", "direct"]);
    expect(waits).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();

    await recordSignupAttribution(
      { OPENCOMPUTER_DB: fakeDB() as unknown as D1Database, POSTHOG_PROJECT_TOKEN: "phc", POSTHOG_HOST: "https://eu.i.posthog.com/" },
      ctx,
      { userID: "u3", entry: "cli", cookie: null, req: signupReq(), nowSec: NOW },
    );
    await Promise.all(waits);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("https://eu.i.posthog.com/capture/");
  });

  it("classifies invite regardless of cookie and never throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network"); }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); } };
    const cookie = cookieHeader({ v: 1, ft: touch({ src: "google" }), lt: null });
    const rec = await recordSignupAttribution(
      { OPENCOMPUTER_DB: fakeDB() as unknown as D1Database, POSTHOG_PROJECT_TOKEN: "phc" },
      ctx,
      { userID: "u4", entry: "invite", cookie, req: signupReq(cookie), nowSec: NOW },
    );
    expect(rec?.channel).toBe("invite");
    await expect(Promise.all(waits)).resolves.toBeDefined();

    await expect(
      recordSignupAttribution(
        { OPENCOMPUTER_DB: fakeDB({ failInsert: true }) as unknown as D1Database },
        ctx,
        { userID: "u5", entry: "browser", cookie: null, req: signupReq(), nowSec: NOW },
      ),
    ).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Wiring through the Worker: /auth/login (C3) and the WorkOS callback hook (C4)
// ---------------------------------------------------------------------------

class WiringDB {
  executed: Stmt[] = [];
  user: { id: string; email: string; name: string } | null = null;
  // When set, the users upsert hits the email conflict: the existing row keeps
  // its id but the statement still reports one change.
  existingID: string | null = null;
  invitations: { id: string; org_id: string; role: string }[] = [];

  prepare(sql: string) {
    const db = this;
    const st = {
      args: [] as unknown[],
      bind(...a: unknown[]) { st.args = a; return st; },
      async first<T>(): Promise<T | null> {
        if (sql.includes("FROM users WHERE workos_user_id")) return db.user as T | null;
        if (sql.includes("JOIN org_memberships") && sql.includes("o.id = ?2")) {
          return { id: String(st.args[1]), name: "Team", plan: "free", is_personal: 0, workos_org_id: null, membership_created_at: 1, org_created_at: 1 } as T;
        }
        return null;
      },
      async all<T>(): Promise<{ results: T[] }> {
        if (sql.includes("FROM invitations")) return { results: db.invitations as T[] };
        if (sql.includes("FROM cells")) return { results: [{ cell_id: "cell-a", region: "us-east-2" } as T] };
        return { results: [] };
      },
      async run() {
        db.executed.push({ sql, args: st.args });
        if (sql.includes("INSERT INTO users")) {
          db.user = { id: db.existingID ?? String(st.args[0]), email: String(st.args[1]), name: String(st.args[3]) };
          return { meta: { changes: 1 } };
        }
        return { meta: { changes: 1 } };
      },
    };
    return st;
  }

  async batch(stmts: { run(): Promise<unknown> }[]) {
    return Promise.all(stmts.map((s) => s.run()));
  }
}

function wiringEnv(db: WiringDB): Env {
  return {
    OPENCOMPUTER_DB: db,
    SESSIONS_KV: {},
    CREDIT_ACCOUNT: {},
    CLI_AUTH_START_RATE_LIMIT: { limit: vi.fn(async () => ({ success: true })) },
    CLI_AUTH_EXCHANGE_RATE_LIMIT: { limit: vi.fn(async () => ({ success: true })) },
    SESSION_JWT_SECRET: "test-session-secret",
    WORKOS_API_KEY: "sk_test",
    WORKOS_CLIENT_ID: "client_test",
    STRIPE_API_KEY: "",
    WORKER_ENV: "test",
    CF_ADMIN_SECRET: "",
    STRIPE_WEBHOOK_SECRET: "",
    EVENT_SECRET: "",
    SECRET_ENCRYPTION_KEY: "",
  } as unknown as Env;
}

const wctx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;

function stubWorkOS() {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({
    user: { id: "workos-new", email: "new@example.com", first_name: "New" },
    access_token: "header.payload.signature",
  })));
}

const attrRows = (db: WiringDB) => db.executed.filter((s) => s.sql.includes("INSERT INTO signup_attribution"));

describe("worker wiring", () => {
  it("/auth/login appends oc_attr to its 302 only when the request carries a touch", async () => {
    const env = wiringEnv(new WiringDB());
    const plain = await worker.fetch(new Request("https://app.opencomputer.dev/auth/login?returnTo=/x"), env, wctx);
    expect(plain.status).toBe(302);
    expect(plain.headers.get("location")).toContain("api.workos.com/user_management/authorize");
    expect(plain.headers.get("set-cookie")).toBeNull();

    const tagged = await worker.fetch(
      new Request("https://app.opencomputer.dev/auth/login?utm_source=Twitter&utm_campaign=launch"),
      env,
      wctx,
    );
    expect(tagged.status).toBe(302);
    expect(tagged.headers.get("location")).toContain("api.workos.com/user_management/authorize");
    const setCookie = tagged.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^oc_attr=/);
    expect(setCookie).toContain("Domain=.opencomputer.dev");
    const value = setCookie.split(";", 1)[0];
    expect(parseAttributionCookie(value)?.ft?.src).toBe("twitter");
  });

  it("records attribution for a genuinely created browser user", async () => {
    stubWorkOS();
    const db = new WiringDB();
    const cookie = cookieHeader({ v: 1, ft: touch({ src: "google" }), lt: touch({ src: "google" }) });
    const resp = await worker.fetch(
      new Request("https://app.opencomputer.dev/auth/callback?code=c", { headers: { cookie } }),
      wiringEnv(db),
      wctx,
    );
    expect(resp.status).toBe(302);
    const rows = attrRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].args.slice(0, 4)).toEqual([db.user?.id, "browser", "organic_search", "google"]);
  });

  it("marks invited sign-ups as invite", async () => {
    stubWorkOS();
    const db = new WiringDB();
    db.invitations = [{ id: "inv1", org_id: "team-org", role: "member" }];
    const cookie = cookieHeader({ v: 1, ft: touch({ src: "google" }), lt: null });
    await worker.fetch(new Request("https://app.opencomputer.dev/auth/callback?code=c", { headers: { cookie } }), wiringEnv(db), wctx);
    expect(attrRows(db)[0].args.slice(1, 3)).toEqual(["invite", "invite"]);
  });

  it("records nothing on the email-conflict re-link or for an existing user", async () => {
    stubWorkOS();
    const conflict = new WiringDB();
    conflict.existingID = "existing-user";
    await worker.fetch(new Request("https://app.opencomputer.dev/auth/callback?code=c"), wiringEnv(conflict), wctx);
    expect(conflict.user?.id).toBe("existing-user");
    expect(attrRows(conflict)).toHaveLength(0);

    const existing = new WiringDB();
    existing.user = { id: "u-old", email: "new@example.com", name: "New" };
    await worker.fetch(new Request("https://app.opencomputer.dev/auth/callback?code=c"), wiringEnv(existing), wctx);
    expect(attrRows(existing)).toHaveLength(0);
  });

  it("still logs the user in when the attribution insert fails", async () => {
    stubWorkOS();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const db = new WiringDB();
    const origPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      const st = origPrepare(sql);
      if (sql.includes("signup_attribution")) st.run = async () => { throw new Error("no such table"); };
      return st;
    };
    const resp = await worker.fetch(new Request("https://app.opencomputer.dev/auth/callback?code=c"), wiringEnv(db), wctx);
    expect(resp.status).toBe(302);
    expect(resp.headers.get("set-cookie")).toContain("oc_session=");
  });
});
