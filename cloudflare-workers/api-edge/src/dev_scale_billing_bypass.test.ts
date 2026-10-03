import { describe, expect, it } from "vitest";

import {
  DEV_SCALE_ADMISSION_HEADER,
  DEV_SCALE_ADMISSION_VALUE,
  isMarkedDevScaleAdmission,
  shouldBypassDevScaleBilling,
} from "./dev_scale_billing_bypass";

const env = {
  WORKER_ENV: "mo-dev",
  DEV_SCALE_BILLING_BYPASS_ORG_ID: "org_scale",
  DEV_SCALE_BILLING_BYPASS_AGENT_ID: "scale-demo@development",
};

function request(agentId = "scale-demo@development", marked = true): Request {
  return new Request("https://mo-oc-dev.com/api/managed-agents/sessions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(marked ? { [DEV_SCALE_ADMISSION_HEADER]: DEV_SCALE_ADMISSION_VALUE } : {}),
    },
    body: JSON.stringify({ agentId }),
  });
}

describe("development scale billing bypass", () => {
  it("requires the exact mo-dev environment, org, agent, and marker", async () => {
    await expect(shouldBypassDevScaleBilling(request(), env, "org_scale")).resolves.toBe(true);
    await expect(shouldBypassDevScaleBilling(request(), env, "org_other")).resolves.toBe(false);
    await expect(shouldBypassDevScaleBilling(request("other@development"), env, "org_scale")).resolves.toBe(false);
    await expect(shouldBypassDevScaleBilling(request(undefined, false), env, "org_scale")).resolves.toBe(false);
  });

  it("is hard-disabled outside mo-dev", async () => {
    await expect(
      shouldBypassDevScaleBilling(request(), { ...env, WORKER_ENV: "prod" }, "org_scale"),
    ).resolves.toBe(false);
  });

  it("recognizes the marked request before caller authentication", async () => {
    await expect(isMarkedDevScaleAdmission(request(), env)).resolves.toBe(true);
    await expect(isMarkedDevScaleAdmission(request(undefined, false), env)).resolves.toBe(false);
  });
});
