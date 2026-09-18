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
  ) {}

  bind(orgID: string): this {
    this.orgID = orgID;
    return this;
  }

  async first<T>(): Promise<T | null> {
    expect(this.orgID).toBe("org_test");
    return (this.halted === null
      ? null
      : { is_halted: this.halted, halted_at: this.haltedAt }) as T | null;
  }
}

function env(halted: number | null, haltedAt: number | null = null) {
  return {
    OPENCOMPUTER_DB: {
      prepare(sql: string) {
        expect(sql).toBe("SELECT is_halted, halted_at FROM orgs WHERE id = ?1");
        return new FakeStatement(halted, haltedAt);
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
    });
    await expect(
      getManagedAgentBillingAdmission(env(null), "org_test"),
    ).resolves.toEqual({
      allowed: true,
      isHalted: false,
      haltedAt: null,
      reason: null,
    });
  });

  it("returns a typed, actionable 402", async () => {
    const response = insufficientManagedAgentCredits(
      new Request("https://mo-oc-dev.com/api/managed-agents/sessions"),
    );
    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "insufficient_credits",
        message:
          "Insufficient prepaid credits. Top up or enable automatic top-up: https://mo-oc-dev.com/billing",
        actionUrl: "https://mo-oc-dev.com/billing",
      },
    });
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
