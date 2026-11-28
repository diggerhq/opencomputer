import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleDashboard, type DashboardEnv } from "./dashboard";
import { mintSessionJWT } from "./jwt";
import { handlePublicPromo, resetPublicPromoMemo, runPromoRevertSweep } from "./promo";
import {
  BFCM_2026,
  activatePromoClaim,
  addMonthsUTC,
  getPromoClaim,
  reservePromoClaim,
} from "./promo_claims";
import { syncAutumnToD1, type AutumnCustomer, type AutumnSyncEnv } from "./autumn_webhook";
import { d1Of, schemaDB, type DatabaseSync } from "./test_sqlite_d1";

// Black Friday 2026 (promo.ts / promo_claims.ts) against the real schema in
// node:sqlite, with Autumn's REST API stubbed on fetch.

const SECRET = "promo-test-secret";
const ORG = "org-1";
const USER = "user-1";
const BEFORE_END = Date.parse("2026-11-28T12:00:00Z");
const AFTER_END = Date.parse("2026-12-01T08:00:00Z");

let db: DatabaseSync;
let env: DashboardEnv;
let customers: Record<string, AutumnCustomer>;
let attachBodies: Array<Record<string, unknown>>;
let attachStatus: number;

function addOrg(id: string, usagePlan = "base") {
  db.prepare(
    `INSERT INTO orgs (id, name, slug, plan, home_cell, owner_user_id, created_at, updated_at, usage_plan)
     VALUES (?, ?, ?, 'free', 'c1', ?, 0, 0, ?)`,
  ).run(id, id, id, USER, usagePlan);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(BEFORE_END);
  resetPublicPromoMemo();
  db = schemaDB();
  addOrg(ORG);
  db.prepare("INSERT INTO org_memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', 0)").run(ORG, USER);
  env = {
    OPENCOMPUTER_DB: d1Of(db),
    SESSION_JWT_SECRET: SECRET,
    AUTUMN_SECRET_KEY: "am_sk_test",
    AUTUMN_BASE_URL: "https://autumn.test/v1",
  } as unknown as DashboardEnv;
  customers = {
    [ORG]: { id: ORG, subscriptions: [{ plan_id: "trial", add_on: false, status: "active" }], purchases: [] },
  };
  attachBodies = [];
  attachStatus = 200;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const customer = url.match(/\/customers\/([^/?]+)/);
    if (customer) {
      const c = customers[decodeURIComponent(customer[1])];
      return c ? Response.json(c) : new Response("not found", { status: 404 });
    }
    if (url.endsWith("/billing.attach")) {
      attachBodies.push(JSON.parse(String(init?.body)));
      if (attachStatus !== 200) return new Response("nope", { status: attachStatus });
      return Response.json({ payment_url: "https://checkout.stripe.test/s" });
    }
    return new Response("unexpected", { status: 500 });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function dash(method: string, sub: string, body?: unknown): Promise<Response> {
  const jwt = await mintSessionJWT(SECRET, ORG, USER, "free");
  const req = new Request(`https://app.test/api/dashboard${sub}`, {
    method,
    headers: { cookie: `oc_session=${jwt}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handleDashboard(req, env, { waitUntil() {} } as unknown as ExecutionContext, `/api/dashboard${sub}`);
}

function claimRow(org = ORG) {
  return db.prepare("SELECT * FROM promo_claims WHERE promo_id = 'bfcm2026' AND org_id = ?").get(org) as
    | Record<string, unknown>
    | undefined;
}

describe("public promo endpoint", () => {
  it("serves the contract with CORS and a 30s cache", async () => {
    const res = await handlePublicPromo(
      new Request("https://app.test/api/public/promo/bfcm2026"),
      env.OPENCOMPUTER_DB,
      "/api/public/promo/bfcm2026",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("public, max-age=30");
    expect(await res.json()).toEqual({
      id: "bfcm2026",
      active: true,
      endsAt: "2026-12-01T07:59:00Z",
      earlyCap: 50,
      earlyLeft: 50,
      plans: {
        pro: { price: 10, minutes: 4000, normalPrice: 20, normalMinutes: 2000 },
        max: { price: 100, minutes: 50000, normalPrice: 200, normalMinutes: 25000 },
      },
    });
  });

  it("answers preflight, unknown promos, and the end of the window", async () => {
    const path = "/api/public/promo/bfcm2026";
    const pre = await handlePublicPromo(new Request(`https://app.test${path}`, { method: "OPTIONS" }), env.OPENCOMPUTER_DB, path);
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("*");

    const unknown = await handlePublicPromo(new Request("https://app.test/api/public/promo/nope"), env.OPENCOMPUTER_DB, "/api/public/promo/nope");
    expect(unknown.status).toBe(404);

    const ended = await handlePublicPromo(new Request(`https://app.test${path}`), env.OPENCOMPUTER_DB, path, AFTER_END);
    expect(((await ended.json()) as { active: boolean }).active).toBe(false);
  });
});

describe("claim cap", () => {
  it("gives exactly 50 early slots under concurrent activation", async () => {
    const orgs = Array.from({ length: 60 }, (_, i) => `org-cap-${i}`);
    for (const org of orgs) {
      addOrg(org);
      expect(await reservePromoClaim(env.OPENCOMPUTER_DB, BFCM_2026, org, "pro", BEFORE_END)).not.toBeNull();
    }
    const results = await Promise.all(orgs.map((org) => activatePromoClaim(env.OPENCOMPUTER_DB, org, "pro", BEFORE_END)));
    expect(results.every(Boolean)).toBe(true);

    const rows = db.prepare("SELECT early_slot, months, ends_at FROM promo_claims WHERE status = 'active'").all() as Array<{
      early_slot: number | null;
      months: number;
      ends_at: number;
    }>;
    const early = rows.filter((r) => r.early_slot != null);
    expect(early).toHaveLength(50);
    expect(new Set(early.map((r) => r.early_slot)).size).toBe(50);
    expect(early.every((r) => r.months === 12 && r.ends_at === Math.floor(addMonthsUTC(BEFORE_END, 12) / 1000))).toBe(true);
    const late = rows.filter((r) => r.early_slot == null);
    expect(late).toHaveLength(10);
    expect(late.every((r) => r.months === 3)).toBe(true);

    const res = await handlePublicPromo(new Request("https://app.test/x"), env.OPENCOMPUTER_DB, "/api/public/promo/bfcm2026");
    expect(((await res.json()) as { earlyLeft: number }).earlyLeft).toBe(0);
  });

  it("refuses a duplicate early slot at the index", () => {
    db.prepare("INSERT INTO promo_claims (promo_id, org_id, plan, status, claimed_at, early_slot) VALUES ('bfcm2026', 'a', 'pro', 'active', 0, 1)").run();
    expect(() =>
      db.prepare("INSERT INTO promo_claims (promo_id, org_id, plan, status, claimed_at, early_slot) VALUES ('bfcm2026', 'b', 'pro', 'active', 0, 1)").run(),
    ).toThrow(/UNIQUE/);
  });

  it("activates only once and only for a paid plan", async () => {
    await reservePromoClaim(env.OPENCOMPUTER_DB, BFCM_2026, ORG, "max", BEFORE_END);
    expect(await activatePromoClaim(env.OPENCOMPUTER_DB, ORG, "base", BEFORE_END)).toBe(false);
    expect(await activatePromoClaim(env.OPENCOMPUTER_DB, ORG, "max", BEFORE_END)).toBe(true);
    expect(await activatePromoClaim(env.OPENCOMPUTER_DB, ORG, "max", BEFORE_END + 1000)).toBe(false);
    expect(claimRow()).toMatchObject({ status: "active", plan: "max", early_slot: 1, months: 12 });
    // One claim per org: an active claim is never replaced.
    expect(await reservePromoClaim(env.OPENCOMPUTER_DB, BFCM_2026, ORG, "pro", BEFORE_END)).toBeNull();
  });
});

describe("promo checkout", () => {
  it("attaches with the promo price and minutes and reserves the claim", async () => {
    const res = await dash("POST", "/billing/autumn/plan", { plan: "pro", promo: "bfcm2026" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: "https://checkout.stripe.test/s" });
    expect(attachBodies).toHaveLength(1);
    expect(attachBodies[0]).toMatchObject({
      customer_id: ORG,
      plan_id: "pro",
      plan_schedule: "immediate",
      success_url: "https://app.test/billing?usage-plan=pro&promo=bfcm2026",
      customize: {
        price: { amount: 10, interval: "month" },
        items: [
          { feature_id: "work_minutes", included: 4000, reset: { interval: "month" } },
          { feature_id: "byo_model_subscriptions" },
        ],
      },
    });
    expect(claimRow()).toMatchObject({ status: "pending", plan: "pro" });

    // Pending: still eligible, no claim to show yet.
    let promo = await (await dash("GET", "/billing/promo")).json();
    expect(promo).toMatchObject({ id: "bfcm2026", active: true, earlyLeft: 50, eligible: true, claim: null });

    // Paid: Autumn's projection activates the claim.
    customers[ORG] = { id: ORG, subscriptions: [{ plan_id: "pro", add_on: false, status: "active" }], purchases: [] };
    await syncAutumnToD1(env as unknown as AutumnSyncEnv, ORG);
    promo = await (await dash("GET", "/billing/promo")).json();
    expect(promo).toMatchObject({
      earlyLeft: 49,
      eligible: false,
      claim: { plan: "pro", months: 12, endsAt: new Date(addMonthsUTC(BEFORE_END, 12)).toISOString() },
    });

    const again = await dash("POST", "/billing/autumn/plan", { plan: "max", promo: "bfcm2026" });
    expect(again.status).toBe(409);
  });

  it("leaves the plain checkout untouched", async () => {
    const res = await dash("POST", "/billing/autumn/plan", { plan: "max" });
    expect(res.status).toBe(200);
    expect(attachBodies[0].customize).toBeUndefined();
    expect(claimRow()).toBeUndefined();
  });

  it("refuses existing paid subscribers, unknown promos and a closed window", async () => {
    customers[ORG] = { id: ORG, subscriptions: [{ plan_id: "pro", add_on: false, status: "active" }], purchases: [] };
    expect((await dash("POST", "/billing/autumn/plan", { plan: "max", promo: "bfcm2026" })).status).toBe(409);
    expect((await dash("POST", "/billing/autumn/plan", { plan: "pro", promo: "nope" })).status).toBe(400);
    vi.setSystemTime(AFTER_END);
    customers[ORG].subscriptions = [];
    expect((await dash("POST", "/billing/autumn/plan", { plan: "pro", promo: "bfcm2026" })).status).toBe(410);
    expect(attachBodies).toHaveLength(0);
    expect(claimRow()).toBeUndefined();
  });

  it("marks an org on a paid plan ineligible on the dashboard", async () => {
    db.prepare("UPDATE orgs SET usage_plan = 'max' WHERE id = ?").run(ORG);
    const promo = (await (await dash("GET", "/billing/promo")).json()) as { eligible: boolean };
    expect(promo.eligible).toBe(false);
  });
});

describe("promo revert sweep", () => {
  const DAY = 86_400;
  async function activeClaim(org: string, plan: "pro" | "max", activatedMs: number) {
    if (org !== ORG) addOrg(org);
    await reservePromoClaim(env.OPENCOMPUTER_DB, BFCM_2026, org, plan, activatedMs);
    await activatePromoClaim(env.OPENCOMPUTER_DB, org, plan, activatedMs);
    return (await getPromoClaim(env.OPENCOMPUTER_DB, BFCM_2026, org))!;
  }

  it("schedules the catalog plan once the promo's last period is running", async () => {
    // Fill the early slots so this claim gets the 3-month term.
    for (let i = 0; i < 50; i++) await activeClaim(`org-early-${i}`, "pro", BEFORE_END);
    const claim = await activeClaim(ORG, "pro", BEFORE_END);
    expect(claim.months).toBe(3);
    const endsAt = claim.ends_at!;

    // Second month: the current period ends a month before the promo does.
    customers[ORG] = {
      id: ORG,
      subscriptions: [{ plan_id: "pro", add_on: false, status: "active", current_period_end: (endsAt - 30 * DAY) * 1000 }],
    };
    const early = await runPromoRevertSweep(env, (endsAt - 34 * DAY) * 1000);
    expect(early.reverted).toBe(0);
    expect(claimRow()).toMatchObject({ status: "active" });

    // Last month: the current period ends when the promo does.
    customers[ORG].subscriptions![0].current_period_end = endsAt * 1000;
    const due = await runPromoRevertSweep(env, (endsAt - 20 * DAY) * 1000);
    expect(due).toMatchObject({ reverted: 1 });
    expect(attachBodies).toEqual([{ customer_id: ORG, plan_id: "pro", plan_schedule: "end_of_cycle" }]);
    expect(claimRow()).toMatchObject({ status: "reverted" });
  });

  it("ends a claim whose org left the promo plan or scheduled another", async () => {
    const claim = await activeClaim(ORG, "pro", BEFORE_END);
    const other = await activeClaim("org-2", "max", BEFORE_END);
    customers[ORG] = { id: ORG, subscriptions: [{ plan_id: "max", add_on: false, status: "active" }] };
    customers["org-2"] = {
      id: "org-2",
      subscriptions: [
        { plan_id: "max", add_on: false, status: "active", current_period_end: other.ends_at! * 1000 },
        { plan_id: "pro", add_on: false, status: "scheduled" },
      ],
    };
    const out = await runPromoRevertSweep(env, (claim.ends_at! - DAY) * 1000);
    expect(out).toMatchObject({ checked: 2, ended: 2, reverted: 0 });
    expect(attachBodies).toHaveLength(0);
  });

  it("waits out a pending cancellation and gives up after repeated failures", async () => {
    const claim = await activeClaim(ORG, "pro", BEFORE_END);
    const sub = { plan_id: "pro", add_on: false, status: "active", current_period_end: claim.ends_at! * 1000, canceled_at: 1 };
    customers[ORG] = { id: ORG, subscriptions: [sub] };
    let at = (claim.ends_at! - DAY) * 1000;
    await runPromoRevertSweep(env, at);
    expect(claimRow()).toMatchObject({ status: "active" });
    expect(attachBodies).toHaveLength(0);

    sub.canceled_at = null as unknown as number;
    attachStatus = 500;
    for (let i = 0; i < 5; i++) {
      at += 3_601_000;
      await runPromoRevertSweep(env, at);
    }
    expect(claimRow()).toMatchObject({ status: "revert_failed", revert_attempts: 5 });
  });
});
