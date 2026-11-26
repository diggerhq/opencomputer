import { describe, expect, it, vi } from "vitest";

import { admitDelivery, billingWarningMessage, forgetCreditsNotice, onProPlan, outOfCreditsNotice, refuseForCredits } from "../src/computer/admission.js";
import { CHECKPOINT_MS, ComputerRuntimeBilling } from "../src/computer/billing.js";
import { MANAGED_ANTHROPIC_BASE_URL, modelCredentials, requestManagedModelKey } from "../src/computer/model-key.js";
import type { ManagedAgentBillingAdmission } from "../src/edge/billing-admission.js";
import { hmacSha256Hex, postAgentRuntimeUsage } from "../src/edge/runtime-usage.js";
import { sqlStorage } from "./fixtures/computer-sql.js";

/**
 * Work 052, billing a computer like a serverless agent: runtime segments
 * (billing.ts) and their delivery through the shared usage request
 * (src/edge/runtime-usage.ts), the credit gate (admission.ts) and the
 * organization's managed model key (model-key.ts).
 */

const T0 = Date.UTC(2026, 9, 11, 12, 0, 0);
const KEY = "T0ACME:C1:100.1";
const CONFIG = { OPENCOMPUTER_APP_URL: "https://app.example", BLUE_USAGE_HMAC_SECRET: "usage-secret" };

function recorder(status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: typeof status === "number" ? status : 200 });
  });
  return { calls, fetcher: fetcher as unknown as typeof fetch, setStatus: (next: number) => (status = next) };
}

function billing(options: { billable?: boolean; config?: typeof CONFIG | Record<string, never>; fetcher?: typeof fetch } = {}) {
  return new ComputerRuntimeBilling({
    sql: sqlStorage(),
    billable: () => options.billable ?? true,
    usage: (segment) => ({ orgId: "org_a", deploymentId: "computer", agentId: "computer", sessionId: segment.runnerKey, microvmId: "oc-org-a" }),
    config: () => options.config ?? CONFIG,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  });
}

describe("computer runtime segments", () => {
  it("bills from starting or busy until idle, once per turn, in whole seconds", () => {
    const b = billing();
    b.report(KEY, "starting", T0);
    b.report(KEY, "busy", T0 + 2_000); // still the same turn: no second segment
    expect(b.working()).toEqual([KEY]);
    b.report(KEY, "idle", T0 + 61_500);
    b.report(KEY, "idle", T0 + 90_000); // a repeated idle closes nothing
    expect(b.working()).toEqual([]);
    const [segment, ...rest] = b.segments();
    expect(rest).toEqual([]);
    expect(segment).toMatchObject({ runnerKey: KEY, startedAt: T0, endedAt: T0 + 61_500, quantitySeconds: 62, closeReason: "idle", deliveryStatus: "pending" });
    expect(segment!.id).toMatch(/^crt_[0-9a-f]{32}:0$/);
  });

  it("closes on stopped, error and the host leaving; idle time between turns is never billed", () => {
    const b = billing();
    b.report("a", "busy", T0);
    b.report("a", "stopped", T0 + 10_000);
    b.report("b", "busy", T0);
    b.report("b", "error", T0 + 5_000);
    b.report("c", "busy", T0);
    b.report("d", "starting", T0 + 1_000);
    b.closeAll("host_disconnected", T0 + 20_000);
    b.report("a", "idle", T0 + 30_000); // nothing open: nothing to close
    expect(b.segments().map((s) => [s.runnerKey, s.quantitySeconds, s.closeReason])).toEqual([
      ["b", 5, "error"],
      ["a", 10, "stopped"],
      ["c", 20, "host_disconnected"],
      ["d", 19, "host_disconnected"],
    ]);
    expect(b.working()).toEqual([]);
  });

  it("bills a long turn every five minutes, each piece under its own key", () => {
    const b = billing();
    b.report(KEY, "busy", T0);
    expect(b.nextDueAt()).toBe(T0 + CHECKPOINT_MS);
    b.checkpoint(T0 + CHECKPOINT_MS - 1); // not yet
    expect(b.segments()).toEqual([]);
    b.checkpoint(T0 + CHECKPOINT_MS);
    b.checkpoint(T0 + 2 * CHECKPOINT_MS + 30_000);
    b.report(KEY, "idle", T0 + 2 * CHECKPOINT_MS + 45_000);
    const segments = b.segments();
    expect(segments.map((s) => [s.quantitySeconds, s.closeReason])).toEqual([
      [300, "checkpoint"],
      [330, "checkpoint"],
      [15, "idle"],
    ]);
    const base = segments[0]!.id.replace(/:0$/, "");
    expect(segments.map((s) => s.id)).toEqual([`${base}:0`, `${base}:1`, `${base}:2`]);
    // Contiguous: nothing billed twice, nothing dropped.
    expect(segments[1]!.startedAt).toBe(segments[0]!.endedAt);
    expect(segments[2]!.startedAt).toBe(segments[1]!.endedAt);
  });

  it("never bills a warm pool computer", () => {
    const b = billing({ billable: false });
    b.report(KEY, "busy", T0);
    b.checkpoint(T0 + CHECKPOINT_MS);
    b.closeAll("host_disconnected", T0 + 2 * CHECKPOINT_MS);
    expect(b.working()).toEqual([]);
    expect(b.segments()).toEqual([]);
    expect(b.nextDueAt()).toBeNull();
  });

  it("delivers each segment once, signed like a serverless agent's, retrying failures under the same key", async () => {
    vi.useFakeTimers({ now: T0 + 70_000 });
    try {
      const { calls, fetcher, setStatus } = recorder(502);
      const b = billing({ fetcher });
      b.report(KEY, "busy", T0);
      b.report(KEY, "idle", T0 + 60_000);
      const [segment] = b.segments();
      expect(b.nextDueAt()).toBe(T0 + 60_000);

      // The edge fails: pending, backed off, attempt counted.
      expect(await b.deliver(Date.now())).toBe(0);
      expect(b.segments()[0]).toMatchObject({ deliveryStatus: "pending", deliveryAttempts: 1 });
      expect(b.nextDueAt()).toBe(Date.now() + 2_000);
      expect(await b.deliver(Date.now())).toBe(0); // not due yet: no call
      expect(calls).toHaveLength(1);

      setStatus(200);
      vi.advanceTimersByTime(2_000);
      expect(await b.deliver(Date.now())).toBe(1);
      expect(await b.deliver(Date.now() + 600_000)).toBe(0); // delivered: never again
      expect(calls).toHaveLength(2);
      expect(b.segments()[0]!.deliveryStatus).toBe("delivered");
      expect(b.nextDueAt()).toBeNull();

      // Both attempts carried the segment's ID as the idempotency key.
      for (const call of calls) {
        expect(call.url).toBe("https://app.example/internal/agent-runtime-usage");
        expect(call.body).toEqual({
          org_id: "org_a",
          deployment_id: "computer",
          agent_id: "computer",
          session_id: KEY,
          microvm_id: "oc-org-a",
          resource_tier: "2gb_1vcpu",
          quantity_seconds: 60,
          segment_started_at: new Date(T0).toISOString(),
          segment_ended_at: new Date(T0 + 60_000).toISOString(),
          close_reason: "idle",
          idempotency_key: segment!.id,
        });
        const signature = await hmacSha256Hex("usage-secret", `${call.headers["x-timestamp"]}./internal/agent-runtime-usage.${JSON.stringify(call.body)}`);
        expect(call.headers["x-signature"]).toBe(signature);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps segments pending, and wakes nobody for them, until delivery is configured", async () => {
    const { calls, fetcher } = recorder();
    const b = billing({ config: {}, fetcher });
    b.report(KEY, "busy", T0);
    b.report(KEY, "idle", T0 + 1_000);
    expect(b.nextDueAt()).toBeNull();
    expect(await b.deliver(T0 + 10_000)).toBe(0);
    expect(calls).toEqual([]);
    expect(b.segments()[0]!.deliveryStatus).toBe("pending");
  });

  it("refuses to post without the edge's URL and secret", async () => {
    await expect(
      postAgentRuntimeUsage({}, { orgId: "o", deploymentId: "d", agentId: "a", sessionId: "s", microvmId: "m", quantitySeconds: 1, startedAtMs: T0, endedAtMs: T0, closeReason: "idle", idempotencyKey: "k" }),
    ).rejects.toThrow(/not configured/);
  });
});

function billingService(answer: Partial<ManagedAgentBillingAdmission> | Error) {
  return {
    checkAdmission: vi.fn(async () => {
      if (answer instanceof Error) throw answer;
      return { allowed: true, isHalted: false, haltedAt: null, reason: null, ...answer } as ManagedAgentBillingAdmission;
    }),
  };
}

describe("the computer's credit gate", () => {
  it("admits, and refuses every organization out of credits, paid or free", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await admitDelivery({}, "org_a")).toEqual({ deliver: true });
      expect(await admitDelivery({ OPENCOMPUTER_BILLING: billingService({ paid: false, modelAccess: "full" }) }, "org_a")).toEqual({ deliver: true });
      expect(
        await admitDelivery({ OPENCOMPUTER_BILLING: billingService({ allowed: false, isHalted: true, reason: "insufficient_credits" }) }, "org_a"),
      ).toEqual({ deliver: false, haltReason: null });
      expect(
        await admitDelivery(
          { OPENCOMPUTER_BILLING: billingService({ allowed: false, isHalted: true, reason: "insufficient_credits", paid: true, haltReason: "payment" }) },
          "org_a",
        ),
      ).toEqual({ deliver: false, haltReason: "payment" });
      expect(
        await admitDelivery({ OPENCOMPUTER_BILLING: billingService({ isHalted: true, paid: true, modelAccess: "fallback", usagePlan: "pro" }) }, "org_a"),
      ).toEqual({ deliver: false, onPro: false, haltReason: null });
      expect(
        await admitDelivery({ OPENCOMPUTER_BILLING: billingService({ isHalted: true, paid: true, modelAccess: "fallback", usagePlan: "max" }) }, "org_a"),
      ).toEqual({ deliver: false, onPro: true, haltReason: null });
      expect(log.mock.calls.map((call) => JSON.parse(String(call[0])).event)).toContain("computer.admission_denied_halted_paid");
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  });

  it("delivers with billing's warning before the stop, and none once halted", async () => {
    const warning = { warning: "trial_minutes", warningSince: 1_800_000_000 };
    expect(await admitDelivery({ OPENCOMPUTER_BILLING: billingService({ paid: false, modelAccess: "full", ...warning }) }, "org_a")).toEqual({
      deliver: true,
      warning: { reason: "trial_minutes", since: 1_800_000_000 },
    });
    expect(await admitDelivery({ OPENCOMPUTER_BILLING: billingService({ paid: false, modelAccess: "full", warning: null }) }, "org_a")).toEqual({ deliver: true });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(
        await admitDelivery({ OPENCOMPUTER_BILLING: billingService({ allowed: false, isHalted: true, reason: "insufficient_credits", ...warning }) }, "org_a"),
      ).toEqual({ deliver: false, haltReason: null });
    } finally {
      log.mockRestore();
    }
  });

  it("words each warning with a billing button and the link in the fallback text", () => {
    for (const reason of ["trial_minutes", "trial_days", "trial_tokens", "allowance_80", "credits_low", "payment_failed"]) {
      const message = billingWarningMessage("https://o", reason)!;
      expect(message.text).toMatch(/^:warning: .* at https:\/\/o\/billing/);
      expect(message.blocks[0]).toMatchObject({ type: "section", text: { type: "mrkdwn" } });
      expect(JSON.stringify(message.blocks[0])).not.toContain("https://o");
      expect(message.blocks[1]).toMatchObject({ type: "actions", elements: [{ type: "button", url: "https://o/billing", action_id: "billing_link" }] });
    }
    expect(billingWarningMessage("https://o", "allowance_80")!.text).toContain("80% of this month's work minutes");
    expect(billingWarningMessage("https://o", "payment_failed")!.text).toContain("payment didn't go through");
    expect(billingWarningMessage("https://o", "something_new")).toBeNull();
  });

  it("reads Pro from billing for a turn the provider refused, and free when billing refuses or is down", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await onProPlan({ OPENCOMPUTER_BILLING: billingService({ usagePlan: "max" }) }, "org_a")).toBe(true);
      expect(await onProPlan({ OPENCOMPUTER_BILLING: billingService({ usagePlan: "base" }) }, "org_a")).toBe(false);
      expect(
        await onProPlan({ OPENCOMPUTER_BILLING: billingService({ allowed: false, isHalted: true, reason: "insufficient_credits" }) }, "org_a"),
      ).toBe(false);
      expect(await onProPlan({ OPENCOMPUTER_BILLING: billingService(new Error("down")) }, "org_a")).toBe(false);
      expect(await onProPlan({}, "org_a")).toBe(false);
    } finally {
      error.mockRestore();
    }
  });

  it("throws when billing cannot answer, so the message is retried rather than refused", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(admitDelivery({ OPENCOMPUTER_BILLING: billingService(new Error("down")) }, "org_a")).rejects.toMatchObject({
        code: "billing_admission_unavailable",
      });
    } finally {
      error.mockRestore();
    }
  });

  it("tells a thread once, clears its status every time, and tells it again after an admitted message", async () => {
    const sql = sqlStorage();
    sql.exec("CREATE TABLE notices (thread_key TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (thread_key, kind));");
    const calls: Array<[string, Record<string, unknown>]> = [];
    const slack = async (method: string, body: Record<string, unknown>) => {
      calls.push([method, body]);
      return { ok: true };
    };
    const refuse = () => refuseForCredits({ sql, slack, channelId: "C1", threadTs: "100.1", origin: "https://app.example" });
    expect(await refuse()).toBe(true);
    expect(await refuse()).toBe(false);
    expect(calls).toEqual([
      [
        "chat.postMessage",
        {
          channel: "C1",
          thread_ts: "100.1",
          text: ":information_source: You've used your free credits, so I can't take this on. Upgrade to Pro ($200/mo) at https://app.example/billing?plan=max to keep going, then mention me again.",
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: ":information_source: You've used your free credits, so I can't take this on. Upgrade to Pro ($200/mo) to keep going, then mention me again." } },
            {
              type: "actions",
              elements: [{ type: "button", text: { type: "plain_text", text: "Upgrade to Pro ($200/mo)" }, url: "https://app.example/billing?plan=max", action_id: "billing_link" }],
            },
          ],
        },
      ],
      ["agents.sessions.setStatus", { channel_id: "C1", thread_ts: "100.1", status: "active" }],
      ["agents.sessions.setStatus", { channel_id: "C1", thread_ts: "100.1", status: "active" }],
    ]);
    expect(outOfCreditsNotice("https://o")).toContain("https://o/billing?plan=max");
    expect(outOfCreditsNotice("https://o")).not.toMatch(/top up|add credits/i);
    expect(outOfCreditsNotice("https://o", true)).toBe(
      ":information_source: You've used this month's Pro credits, so I can't take this on until they renew. See your renewal date at https://o/billing.",
    );
    forgetCreditsNotice(sql, "C1", "100.1");
    expect(await refuse()).toBe(true);
  });

  it("names the work-minute limit that was hit", () => {
    expect(outOfCreditsNotice("https://o", false, "trial_days")).toContain("3-day trial has ended");
    expect(outOfCreditsNotice("https://o", false, "trial_minutes")).toContain("600 work minutes");
    expect(outOfCreditsNotice("https://o", false, "trial_tokens")).toContain("trial's model credit");
    expect(outOfCreditsNotice("https://o", true, "credits_empty")).toContain("work minutes and your credits");
    expect(outOfCreditsNotice("https://o", false, "payment")).toContain("payment didn't go through");
    expect(outOfCreditsNotice("https://o", false, "lapsed")).toContain("plan has ended");
    for (const reason of ["trial_days", "trial_minutes", "trial_tokens", "credits_empty", "payment", "lapsed"]) {
      expect(outOfCreditsNotice("https://o", false, reason)).toContain("https://o/billing");
      expect(outOfCreditsNotice("https://o", false, reason)).not.toContain("plan=max");
    }
    expect(outOfCreditsNotice("https://o", false, "credits_exhausted")).toBe(outOfCreditsNotice("https://o"));
  });
});

describe("the computer's model credentials", () => {
  it("prefers the organization's managed key, on OpenRouter's Anthropic API", () => {
    const shared = { COMPUTER_ANTHROPIC_API_KEY: "sk-ant" };
    expect(modelCredentials("sk-or-org", shared)).toEqual({
      credentials: { anthropicApiKey: "sk-or-org", anthropicBaseUrl: MANAGED_ANTHROPIC_BASE_URL },
      fallback: false,
    });
    expect(MANAGED_ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    expect(modelCredentials(null, shared)).toEqual({ credentials: { anthropicApiKey: "sk-ant" }, fallback: true });
    expect(modelCredentials(null, {})).toEqual({ credentials: {}, fallback: true });
  });

  it("never hands out a shared Claude OAuth token (work 097: a seat is one person's)", () => {
    // A deployment that still sets the retired variable gets the API key, or nothing.
    const stale = { COMPUTER_CLAUDE_CODE_OAUTH_TOKEN: "oauth", COMPUTER_ANTHROPIC_API_KEY: "sk-ant" } as Record<string, string>;
    expect(modelCredentials(null, stale)).toEqual({ credentials: { anthropicApiKey: "sk-ant" }, fallback: true });
    expect(modelCredentials(null, { COMPUTER_CLAUDE_CODE_OAUTH_TOKEN: "oauth" } as Record<string, string>)).toEqual({ credentials: {}, fallback: true });
  });

  it("asks the public edge to create the key, signed like sessions-api's ensureManagedProvisioned", async () => {
    const calls: Array<{ url: string; headers: Headers; body: string }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body) });
      return Response.json({ status: "active" });
    }) as typeof fetch;
    const env = { OPENCOMPUTER_APP_URL: "https://app.example", OC_MANAGED_CRED_HMAC_SECRET: "managed-secret" };
    expect(await requestManagedModelKey(env, "org_a", fetcher)).toBe("requested");
    expect(calls[0]!.url).toBe("https://app.example/internal/model-billing/enable");
    expect(JSON.parse(calls[0]!.body)).toEqual({ org_id: "org_a" });
    const ts = calls[0]!.headers.get("x-timestamp")!;
    expect(calls[0]!.headers.get("x-signature")).toBe(await hmacSha256Hex("managed-secret", `${ts}.${calls[0]!.body}`));

    expect(await requestManagedModelKey({}, "org_a", fetcher)).toBe("not_configured");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const halted = (async () => Response.json({ status: "halted" }, { status: 500 })) as unknown as typeof fetch;
      expect(await requestManagedModelKey(env, "org_a", halted)).toBe("failed");
      const down = (async () => {
        throw new Error("network");
      }) as unknown as typeof fetch;
      expect(await requestManagedModelKey(env, "org_a", down)).toBe("failed");
    } finally {
      warn.mockRestore();
    }
  });
});
