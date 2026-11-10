import { describe, expect, it, vi } from "vitest";

import {
  managedModelBilling,
  requireAutonomousBillingAdmission,
  type ManagedAgentBillingAdmission,
} from "../src/edge/billing-admission.js";

function service(result: ManagedAgentBillingAdmission) {
  return {
    checkAdmission: vi.fn(async () => result),
  };
}

describe("autonomous billing admission", () => {
  it("preserves development configs without a billing binding", async () => {
    await expect(
      requireAutonomousBillingAdmission({}, "org-development"),
    ).resolves.toBeUndefined();
  });

  it("allows an active organization", async () => {
    const binding = service({
      allowed: true,
      isHalted: false,
      haltedAt: null,
      reason: null,
    });
    await expect(
      requireAutonomousBillingAdmission(
        { OPENCOMPUTER_BILLING: binding },
        "org-active",
      ),
    ).resolves.toBeUndefined();
    expect(binding.checkAdmission).toHaveBeenCalledWith("org-active");
  });

  it("rejects a halted organization before launch", async () => {
    const binding = service({
      allowed: false,
      isHalted: true,
      haltedAt: 1_789_707_077,
      reason: "insufficient_credits",
    });
    await expect(
      requireAutonomousBillingAdmission(
        { OPENCOMPUTER_BILLING: binding },
        "org-halted",
      ),
    ).rejects.toMatchObject({
      code: "insufficient_credits",
      message: "Insufficient prepaid credits",
    });
  });

  it("fails closed when the billing authority is unavailable", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      requireAutonomousBillingAdmission(
        {
          OPENCOMPUTER_BILLING: {
            checkAdmission: async () => {
              throw new Error("service binding unavailable");
            },
          },
        },
        "org-unknown",
      ),
    ).rejects.toMatchObject({
      code: "billing_admission_unavailable",
      message: "Billing admission is temporarily unavailable",
    });
    consoleError.mockRestore();
  });
});

describe("managed model billing", () => {
  it("keeps full model access without a billing binding", async () => {
    await expect(managedModelBilling({}, "org-development")).resolves.toEqual({
      paid: false,
      fallback: false,
      stopped: false,
    });
  });

  it("moves an exhausted paid organization to the fallback", async () => {
    const binding = service({
      allowed: true,
      isHalted: true,
      haltedAt: 1_789_707_077,
      reason: null,
      paid: true,
      modelAccess: "fallback",
    });
    await expect(
      managedModelBilling({ OPENCOMPUTER_BILLING: binding }, "org-pro"),
    ).resolves.toEqual({ paid: true, fallback: true, stopped: false });
    expect(binding.checkAdmission).toHaveBeenCalledWith("org-pro");
  });

  it("never falls back for a base organization", async () => {
    const binding = service({
      allowed: false,
      isHalted: true,
      haltedAt: 1_789_707_077,
      reason: "insufficient_credits",
      paid: false,
      modelAccess: null,
    });
    await expect(
      managedModelBilling({ OPENCOMPUTER_BILLING: binding }, "org-base"),
    ).resolves.toEqual({ paid: false, fallback: false, stopped: true });
  });

  it("stops a paid organization halted on work minutes", async () => {
    const binding = service({
      allowed: false,
      isHalted: true,
      haltedAt: 1_789_707_077,
      reason: "insufficient_credits",
      paid: true,
      modelAccess: null,
      haltReason: "credits_empty",
    });
    await expect(
      managedModelBilling({ OPENCOMPUTER_BILLING: binding }, "org-pro"),
    ).resolves.toEqual({ paid: true, fallback: false, stopped: true });
  });

  it("carries the halt reason on a refusal", async () => {
    const binding = service({
      allowed: false,
      isHalted: true,
      haltedAt: 1_789_707_077,
      reason: "insufficient_credits",
      haltReason: "trial_days",
    });
    await expect(
      requireAutonomousBillingAdmission({ OPENCOMPUTER_BILLING: binding }, "org-trial"),
    ).rejects.toMatchObject({ code: "insufficient_credits", haltReason: "trial_days" });
  });

  it("treats a billing service without plan fields as unpaid", async () => {
    const binding = service({
      allowed: false,
      isHalted: true,
      haltedAt: 1_789_707_077,
      reason: "insufficient_credits",
    });
    await expect(
      managedModelBilling({ OPENCOMPUTER_BILLING: binding }, "org-legacy"),
    ).resolves.toEqual({ paid: false, fallback: false, stopped: true });
  });

  it("fails open to the selected model when billing is unavailable", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      managedModelBilling(
        {
          OPENCOMPUTER_BILLING: {
            checkAdmission: vi.fn(async () => {
              throw new Error("service unavailable");
            }),
          },
        },
        "org-unknown",
      ),
    ).resolves.toEqual({ paid: false, fallback: false, stopped: false });
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
