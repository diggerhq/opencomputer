import { describe, expect, it } from "vitest";
import { sessionRunsOnWorkerd } from "../src/edge/runtime-launch.js";
import { rolloutBucket } from "../src/rollout-bucket.js";

const account = "11111111-2222-4333-8444-555555555555";

describe("sessionRunsOnWorkerd", () => {
  it("keeps every account on Workerd by default", () => {
    expect(sessionRunsOnWorkerd({})).toBe(true);
    expect(sessionRunsOnWorkerd({}, account)).toBe(true);
    expect(sessionRunsOnWorkerd({ SESSION_SANDBOX_ACCOUNTS: "" }, account)).toBe(true);
  });

  it("moves the whole stack with EXTERNAL_SESSION_RUNTIME", () => {
    expect(sessionRunsOnWorkerd({ EXTERNAL_SESSION_RUNTIME: "true" })).toBe(false);
    expect(sessionRunsOnWorkerd({ EXTERNAL_SESSION_RUNTIME: "true" }, account)).toBe(false);
  });

  it("moves only the allowlisted accounts", () => {
    const env = { SESSION_SANDBOX_ACCOUNTS: ` other , ${account}` };
    expect(sessionRunsOnWorkerd(env, account)).toBe(false);
    expect(sessionRunsOnWorkerd(env, "other")).toBe(false);
    expect(sessionRunsOnWorkerd(env, "someone-else")).toBe(true);
    // No account to judge (a call site without one) stays on Workerd.
    expect(sessionRunsOnWorkerd(env)).toBe(true);
  });

  it("moves everyone with '*'", () => {
    expect(sessionRunsOnWorkerd({ SESSION_SANDBOX_ACCOUNTS: "*" }, "anyone")).toBe(false);
  });

  it("buckets accounts by the rollout percent", () => {
    const bucket = rolloutBucket(account);
    expect(
      sessionRunsOnWorkerd({ SESSION_SANDBOX_ROLLOUT_PERCENT: String(bucket + 1) }, account),
    ).toBe(false);
    expect(
      sessionRunsOnWorkerd({ SESSION_SANDBOX_ROLLOUT_PERCENT: String(bucket) }, account),
    ).toBe(true);
    expect(sessionRunsOnWorkerd({ SESSION_SANDBOX_ROLLOUT_PERCENT: "100" }, "anyone")).toBe(false);
    expect(sessionRunsOnWorkerd({ SESSION_SANDBOX_ROLLOUT_PERCENT: "nope" }, "anyone")).toBe(true);
  });
});
