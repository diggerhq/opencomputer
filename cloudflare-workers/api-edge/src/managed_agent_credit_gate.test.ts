import { describe, expect, it, vi } from "vitest";
import {
  enforceManagedAgentCreditGate,
  getManagedAgentBillingAdmission,
  insufficientManagedAgentCredits,
  isManagedAgentBillableRequest,
  isManagedAgentCreditHalted,
} from "./managed_agent_credit_gate";

class FakeStatement {
  private orgID = "";

  constructor(
    private readonly halted: number | null,
    private readonly haltedAt: number | null,
    private readonly usagePlan: string,
    private readonly plan: string,
    private readonly billingProvider: string,
    private readonly haltReason: string | null,
  ) {}

  bind(orgID: string): this {
    this.orgID = orgID;
    return this;
  }

  async first<T>(): Promise<T | null> {
    expect(this.orgID).toBe("org_test");
    return (this.halted === null
      ? null
      : {
          is_halted: this.halted,
          halted_at: this.haltedAt,
          usage_plan: this.usagePlan,
          plan: this.plan,
          billing_provider: this.billingProvider,
          halt_reason: this.haltReason,
        }) as T | null;
  }
}

function env(
  halted: number | null,
  haltedAt: number | null = null,
  usagePlan = "base",
  plan = "free",
  billingProvider = "autumn",
  haltReason: string | null = null,
) {
  return {
    OPENCOMPUTER_DB: {
      prepare(sql: string) {
        expect(sql).toBe(
          "SELECT is_halted, halted_at, usage_plan, plan, billing_provider, halt_reason FROM orgs WHERE id = ?1",
        );
        return new FakeStatement(halted, haltedAt, usagePlan, plan, billingProvider, haltReason);
      },
    } as unknown as D1Database,
  };
}

describe("managed-agent credit admission", () => {
  it.each([
    "/api/managed-agents/sessions",
    "/api/managed-agents/sessions/session_1/turns",
    "/api/managed-agents/sessions/session_1/resume",
    "/api/managed-agents/schedules/daily-review/run",
  ])("recognizes billable POST %s", (path) => {
    expect(isManagedAgentBillableRequest("POST", path)).toBe(true);
  });

  it.each([
    ["GET", "/api/managed-agents/sessions"],
    ["POST", "/api/managed-agents/sessions/session_1/suspend"],
    ["POST", "/api/managed-agents/sessions/session_1/end"],
    ["GET", "/api/managed-agents/schedules"],
  ])("does not gate non-billable %s %s", (method, path) => {
    expect(isManagedAgentBillableRequest(method, path)).toBe(false);
  });

  it("reads the D1 halt projection", async () => {
    await expect(isManagedAgentCreditHalted(env(1), "org_test")).resolves.toBe(
      true,
    );
    await expect(isManagedAgentCreditHalted(env(0), "org_test")).resolves.toBe(
      false,
    );
    await expect(
      isManagedAgentCreditHalted(env(null), "org_test"),
    ).resolves.toBe(false);
  });

  it("returns the private autonomous-admission decision", async () => {
    await expect(
      getManagedAgentBillingAdmission(env(1, 1_789_707_077), "org_test"),
    ).resolves.toEqual({
      allowed: false,
      isHalted: true,
      haltedAt: 1_789_707_077,
      reason: "insufficient_credits",
      paid: false,
      modelAccess: null,
      usagePlan: "base",
      haltReason: "credits_exhausted",
    });
    await expect(
      getManagedAgentBillingAdmission(env(null), "org_test"),
    ).resolves.toEqual({
      allowed: true,
      isHalted: false,
      haltedAt: null,
      reason: null,
      paid: false,
      modelAccess: "full",
      usagePlan: null,
      haltReason: null,
    });
    await expect(
      getManagedAgentBillingAdmission(env(0, null, "pro"), "org_test"),
    ).resolves.toEqual({
      allowed: true,
      isHalted: false,
      haltedAt: null,
      reason: null,
      paid: true,
      modelAccess: "full",
      usagePlan: "pro",
      haltReason: null,
    });
  });

  it.each(["pro", "max"])(
    "admits an exhausted %s org onto the fallback model",
    async (plan) => {
      await expect(
        getManagedAgentBillingAdmission(env(1, 1_789_707_077, plan), "org_test"),
      ).resolves.toEqual({
        allowed: true,
        isHalted: true,
        haltedAt: 1_789_707_077,
        reason: null,
        paid: true,
        modelAccess: "fallback",
        usagePlan: plan,
        haltReason: "credits_exhausted",
      });
      const request = new Request(
        "https://mo-oc-dev.com/api/managed-agents/sessions/session_1/turns",
        { method: "POST" },
      );
      await expect(
        enforceManagedAgentCreditGate(request, env(1, 1_789_707_077, plan), "org_test"),
      ).resolves.toBeNull();
    },
  );

  it.each(["credits_empty", "payment", "trial_days"])(
    "stops a paid org halted on the work-minute rule (%s)",
    async (reason) => {
      await expect(
        getManagedAgentBillingAdmission(env(1, 1_789_707_077, "pro", "free", "autumn", reason), "org_test"),
      ).resolves.toMatchObject({ allowed: false, isHalted: true, paid: true, modelAccess: null });
    },
  );

  it("keeps the fallback for a paid org halted on the credit rule", async () => {
    await expect(
      getManagedAgentBillingAdmission(env(1, 1_789_707_077, "max", "free", "autumn", "credits_exhausted"), "org_test"),
    ).resolves.toMatchObject({ allowed: true, modelAccess: "fallback" });
  });

  it("keeps an existing Pro org eligible before its usage-plan projection", async () => {
    await expect(
      getManagedAgentBillingAdmission(
        env(1, 1_789_707_077, "base", "pro"),
        "org_test",
      ),
    ).resolves.toEqual({
      allowed: true,
      isHalted: true,
      haltedAt: 1_789_707_077,
      reason: null,
      paid: true,
      modelAccess: "fallback",
      usagePlan: "pro",
      haltReason: "credits_exhausted",
    });
  });

  it("reports the usage plan the computer sizes by", async () => {
    const usagePlan = async (usage: string | null, plan = "free") =>
      (
        await getManagedAgentBillingAdmission(
          env(0, null, usage as string, plan),
          "org_test",
        )
      ).usagePlan;
    await expect(usagePlan("max")).resolves.toBe("max");
    await expect(usagePlan("pro")).resolves.toBe("pro");
    await expect(usagePlan("base")).resolves.toBe("base");
    await expect(usagePlan(null)).resolves.toBe("base");
    // Legacy Pro org before its Autumn projection.
    await expect(usagePlan("base", "pro")).resolves.toBe("pro");
    await expect(usagePlan(null, "pro")).resolves.toBe("pro");
    await expect(usagePlan("enterprise")).resolves.toBeNull();
  });

  it("admits a halted Autumn org whose re-check finds credits", async () => {
    const selfHeal = vi.fn(async () => false);
    await expect(
      getManagedAgentBillingAdmission(env(1, 1_789_707_077), "org_test", selfHeal),
    ).resolves.toMatchObject({
      allowed: true,
      isHalted: false,
      haltedAt: null,
      modelAccess: "full",
    });
    expect(selfHeal).toHaveBeenCalledWith("org_test");
    const request = new Request(
      "https://mo-oc-dev.com/api/managed-agents/sessions/session_1/turns",
      { method: "POST" },
    );
    await expect(
      enforceManagedAgentCreditGate(request, env(1, 1_789_707_077), "org_test", selfHeal),
    ).resolves.toBeNull();
  });

  it("still denies when the re-check confirms the halt", async () => {
    const selfHeal = vi.fn(async () => true);
    await expect(
      getManagedAgentBillingAdmission(env(1, 1_789_707_077), "org_test", selfHeal),
    ).resolves.toMatchObject({ allowed: false, isHalted: true });
  });

  it("re-checks only halted Autumn orgs", async () => {
    const selfHeal = vi.fn(async () => false);
    await getManagedAgentBillingAdmission(env(0), "org_test", selfHeal);
    await expect(
      getManagedAgentBillingAdmission(
        env(1, 1_789_707_077, "base", "free", "stripe"),
        "org_test",
        selfHeal,
      ),
    ).resolves.toMatchObject({ allowed: false });
    expect(selfHeal).not.toHaveBeenCalled();
  });

  it("hard-stops an exhausted base org with the upgrade 402", async () => {
    const request = new Request(
      "https://mo-oc-dev.com/api/managed-agents/sessions/session_1/turns",
      { method: "POST" },
    );
    const response = await enforceManagedAgentCreditGate(
      request,
      env(1, 1_789_707_077, "base"),
      "org_test",
    );
    expect(response?.status).toBe(402);
  });

  it("returns a typed, actionable 402", async () => {
    const response = insufficientManagedAgentCredits(
      new Request("https://mo-oc-dev.com/api/managed-agents/sessions"),
    );
    expect(response.status).toBe(402);
    const body = (await response.json()) as { error: Record<string, unknown> };
    expect(body.error).toMatchObject({
      code: "insufficient_credits",
      actionUrl: "https://mo-oc-dev.com/billing?plan=max",
      billingUrl: "https://mo-oc-dev.com/billing",
      upgradeUrl: "https://mo-oc-dev.com/billing?plan=max",
    });
    expect(body.error.message).toContain("https://mo-oc-dev.com/billing?plan=max");
    expect(body.error.message).toContain("upgrade to Pro ($200/mo)");
    expect(body.error.message).toContain("do not retry");
    expect(body.error.message).not.toMatch(/top.?up|\$20\b/i);
  });

  it("allows active organizations and fails open when D1 is unavailable", async () => {
    const request = new Request(
      "https://mo-oc-dev.com/api/managed-agents/sessions/session_1/turns",
      { method: "POST" },
    );
    await expect(
      enforceManagedAgentCreditGate(request, env(0), "org_test"),
    ).resolves.toBeNull();

    const error = new Error("D1 unavailable");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const brokenEnv = {
      OPENCOMPUTER_DB: {
        prepare() {
          throw error;
        },
      } as unknown as D1Database,
    };
    await expect(
      enforceManagedAgentCreditGate(request, brokenEnv, "org_test"),
    ).resolves.toBeNull();
    expect(consoleError).toHaveBeenCalledWith(
      "managed-agents: credit admission unavailable org=org_test",
      error,
    );
    consoleError.mockRestore();
  });
});
