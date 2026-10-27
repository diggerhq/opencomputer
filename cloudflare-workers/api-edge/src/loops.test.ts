import { afterEach, describe, expect, it, vi } from "vitest";
import { syncAutumnToD1 } from "./autumn_webhook";
import { isExcludedEmail, notifyTrialEvent, sendLoopsEvent, trialReason } from "./loops";

const owner = { email: "ada@example.com", userId: "user_1" };

function mockFetch(status = 200) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)),
    });
    return new Response(null, { status });
  });
  return calls;
}

describe("Loops exclusions", () => {
  it("skips our own domains and the configured addresses", () => {
    expect(isExcludedEmail("igor@digger.dev")).toBe(true);
    expect(isExcludedEmail("Mo@OpenComputer.dev")).toBe(true);
    expect(isExcludedEmail("ada@example.com")).toBe(false);
    expect(isExcludedEmail("ada@example.com", "@example.com")).toBe(true);
    expect(isExcludedEmail("bob@example.com", "ada@example.com, @other.io")).toBe(false);
  });

  it("matches Gmail addresses ignoring dots and +tags", () => {
    expect(isExcludedEmail("Te.St+trial3@gmail.com", "test@gmail.com")).toBe(true);
    expect(isExcludedEmail("test@googlemail.com", "test@gmail.com")).toBe(false);
    expect(isExcludedEmail("te.st@example.com", "test@example.com")).toBe(false);
  });

  it("names only trial reasons", () => {
    expect(trialReason("trial_days")).toBe("days");
    expect(trialReason("trial_minutes")).toBe("minutes");
    expect(trialReason("trial_tokens")).toBe("tokens");
    expect(trialReason("credits_low")).toBeNull();
    expect(trialReason(null)).toBeNull();
  });
});

describe("Loops client", () => {
  afterEach(() => vi.restoreAllMocks());

  it("is off without an API key", async () => {
    const calls = mockFetch();
    expect(await sendLoopsEvent({}, owner, "signed_up", { idempotencyKey: "org_1:signed_up" })).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("sends the event with contact properties and an idempotency key", async () => {
    const calls = mockFetch();
    const ok = await sendLoopsEvent({ LOOPS_API_KEY: "loops-key" }, owner, "signed_up", {
      idempotencyKey: "org_1:signed_up",
      eventProperties: { via: "browser" },
      contactProperties: { firstName: "Ada", orgId: "org_1" },
    });
    expect(ok).toBe(true);
    expect(calls).toEqual([
      {
        url: "https://app.loops.so/api/v1/events/send",
        method: "POST",
        headers: {
          authorization: "Bearer loops-key",
          "content-type": "application/json",
          "idempotency-key": "org_1:signed_up",
        },
        body: {
          firstName: "Ada",
          orgId: "org_1",
          email: "ada@example.com",
          userId: "user_1",
          eventName: "signed_up",
          eventProperties: { via: "browser" },
        },
      },
    ]);
  });

  it("does not send to internal accounts", async () => {
    const calls = mockFetch();
    await sendLoopsEvent({ LOOPS_API_KEY: "k" }, { email: "x@digger.dev", userId: "u" }, "signed_up", {
      idempotencyKey: "o:signed_up",
    });
    expect(calls).toHaveLength(0);
  });

  it("reports a failure without throwing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch(500);
    expect(await sendLoopsEvent({ LOOPS_API_KEY: "k" }, owner, "trial_low", { idempotencyKey: "o:trial_low" })).toBe(
      false,
    );
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network"));
    expect(await sendLoopsEvent({ LOOPS_API_KEY: "k" }, owner, "trial_low", { idempotencyKey: "o:trial_low" })).toBe(
      false,
    );
  });
});

// A D1 fake holding one org, its owner and the lifecycle_emails claims.
function fakeDb(opts: { provider?: string; email?: string; org?: Record<string, unknown> } = {}) {
  const org: Record<string, unknown> = {
    is_halted: 0,
    autumn_concurrency_override: null,
    usage_plan: "base",
    payment_past_due_at: null,
    trial_started_at: Math.floor(Date.now() / 1000) - 86_400,
    billing_warning: null,
    ...opts.org,
  };
  const claims = new Set<string>();
  const db = {
    org,
    claims,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            first: async () => {
              if (sql.includes("JOIN users")) {
                return (opts.provider ?? "autumn") === "autumn"
                  ? { user_id: "user_1", email: opts.email ?? "ada@example.com" }
                  : null;
              }
              return { ...org };
            },
            run: async () => {
              if (sql.includes("INSERT OR IGNORE INTO lifecycle_emails")) {
                const key = `${args[0]}:${args[1]}`;
                if (claims.has(key)) return { meta: { changes: 0 } };
                claims.add(key);
              } else if (sql.includes("AND usage_plan = ?3")) {
                if (org.usage_plan !== args[2]) return { meta: { changes: 0 } };
                org.usage_plan = args[0];
              } else if (sql.includes("SET is_halted")) {
                org.is_halted = args[0];
                org.halted_at = args[1];
                org.usage_plan = args[3];
                org.halt_reason = args[6];
                org.billing_warning = args[7];
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
  return db as typeof db & D1Database;
}

describe("trial events", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends each trial event once per org", async () => {
    const calls = mockFetch();
    const db = fakeDb();
    const env = { OPENCOMPUTER_DB: db, LOOPS_API_KEY: "k" };
    await notifyTrialEvent(env, "org_1", "trial_low", "minutes");
    await notifyTrialEvent(env, "org_1", "trial_low", "days");
    await notifyTrialEvent(env, "org_1", "trial_ended", "minutes");
    expect(calls.map((c) => [c.body.eventName, c.body.eventProperties, c.headers["idempotency-key"]])).toEqual([
      ["trial_low", { reason: "minutes" }, "org_1:trial_low"],
      ["trial_ended", { reason: "minutes" }, "org_1:trial_ended"],
    ]);
  });

  it("skips legacy billing, internal owners and a missing key without claiming", async () => {
    const calls = mockFetch();
    for (const db of [fakeDb({ provider: "legacy" }), fakeDb({ email: "mo@opencomputer.dev" })]) {
      await notifyTrialEvent({ OPENCOMPUTER_DB: db, LOOPS_API_KEY: "k" }, "org_1", "trial_low", "days");
      expect(db.claims.size).toBe(0);
    }
    const db = fakeDb();
    await notifyTrialEvent({ OPENCOMPUTER_DB: db }, "org_1", "trial_low", "days");
    expect(db.claims.size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("trial events from the Autumn projection", () => {
  afterEach(() => vi.restoreAllMocks());

  function mockAutumn(minutes: number, credits = 5) {
    const loops: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).startsWith("https://autumn.test/v1/customers/")) {
        return Response.json({
          id: "org_1",
          subscriptions: [{ plan_id: "trial", add_on: false, status: "active" }],
          balances: { credits: { remaining: credits }, work_minutes: { remaining: minutes } },
        });
      }
      if (String(input).startsWith("https://app.loops.so/")) loops.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 200 });
    });
    return loops;
  }

  const syncEnv = (db: D1Database) => ({
    AUTUMN_SECRET_KEY: "autumn-secret",
    AUTUMN_BASE_URL: "https://autumn.test/v1",
    OPENCOMPUTER_DB: db,
    LOOPS_API_KEY: "k",
  });

  it("sends trial_low when the first trial warning is raised, and not again", async () => {
    const loops = mockAutumn(100);
    const db = fakeDb();
    await syncAutumnToD1(syncEnv(db), "org_1");
    await syncAutumnToD1(syncEnv(db), "org_1");
    expect(db.org.billing_warning).toBe("trial_minutes");
    expect(loops).toEqual([expect.objectContaining({ eventName: "trial_low", eventProperties: { reason: "minutes" } })]);
  });

  it("does not resend when a standing warning changes reason", async () => {
    const loops = mockAutumn(100, 1);
    const db = fakeDb({ org: { billing_warning: "trial_minutes" } });
    await syncAutumnToD1(syncEnv(db), "org_1");
    expect(db.org.billing_warning).toBe("trial_tokens");
    expect(loops).toEqual([]);
  });

  it("sends trial_ended when the trial halts the org, once", async () => {
    const loops = mockAutumn(0);
    const db = fakeDb({ org: { billing_warning: "trial_minutes" } });
    await syncAutumnToD1(syncEnv(db), "org_1");
    await syncAutumnToD1(syncEnv(db), "org_1");
    expect(db.org.halt_reason).toBe("trial_minutes");
    expect(loops).toEqual([expect.objectContaining({ eventName: "trial_ended", eventProperties: { reason: "minutes" } })]);
  });

  it("mirrors a plan change onto the contact", async () => {
    const loops: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).startsWith("https://autumn.test/v1/customers/")) {
        return Response.json({
          id: "org_1",
          subscriptions: [{ plan_id: "pro", add_on: false, status: "active" }],
          balances: { credits: { remaining: 20 }, work_minutes: { remaining: 3000 } },
        });
      }
      if (String(input).startsWith("https://app.loops.so/")) loops.push({ url: String(input), ...JSON.parse(String(init?.body)) });
      return new Response(null, { status: 200 });
    });
    await syncAutumnToD1(syncEnv(fakeDb()), "org_1");
    expect(loops).toEqual([
      { url: "https://app.loops.so/api/v1/contacts/update", plan: "pro", email: "ada@example.com", userId: "user_1" },
    ]);
  });
});
