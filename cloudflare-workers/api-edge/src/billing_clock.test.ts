import { afterEach, describe, expect, it, vi } from "vitest";
import * as autumn from "./autumn_webhook";
import { runBillingClock } from "./billing_clock";

describe("billing clock", () => {
  afterEach(() => vi.restoreAllMocks());

  it("re-projects orgs whose trial or payment grace has run out", async () => {
    const project = vi.spyOn(autumn, "projectOrg").mockResolvedValue();
    let bound: unknown[] = [];
    const env = {
      OPENCOMPUTER_DB: {
        prepare: () => ({
          bind: (...args: unknown[]) => {
            bound = args;
            return { all: async () => ({ results: [{ id: "org_a" }, { id: "org_b" }] }) };
          },
        }),
      },
    } as unknown as autumn.AutumnEnv;

    expect(await runBillingClock(env, 1_800_000_000_000)).toBe(2);
    expect(bound).toEqual([1_800_000_000 - 7 * 86_400, 1_800_000_000 - 3 * 86_400, 50]);
    expect(project.mock.calls.map((c) => c[1])).toEqual(["org_a", "org_b"]);
  });
});
