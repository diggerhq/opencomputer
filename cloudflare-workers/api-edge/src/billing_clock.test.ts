import { afterEach, describe, expect, it, vi } from "vitest";
import * as autumn from "./autumn_webhook";
import { runBillingClock } from "./billing_clock";

describe("billing clock", () => {
  afterEach(() => vi.restoreAllMocks());

  it("re-projects orgs whose trial, payment grace or trial warning is due", async () => {
    const project = vi.spyOn(autumn, "projectOrg").mockResolvedValue();
    let bound: unknown[] = [];
    let sql = "";
    const env = {
      OPENCOMPUTER_DB: {
        prepare: (q: string) => ({
          bind: (...args: unknown[]) => {
            sql = q;
            bound = args;
            return { all: async () => ({ results: [{ id: "org_a" }, { id: "org_b" }] }) };
          },
        }),
      },
    } as unknown as autumn.AutumnEnv;

    expect(await runBillingClock(env, 1_800_000_000_000)).toBe(2);
    // Least recently updated first, so orgs that stay unhalted can't fill every batch.
    expect(sql).toMatch(/ORDER BY updated_at\s+LIMIT/);
    expect(bound).toEqual([1_800_000_000 - 7 * 86_400, 1_800_000_000 - 3 * 86_400, 50, 1_800_000_000 - 5 * 86_400]);
    expect(project.mock.calls.map((c) => c[1])).toEqual(["org_a", "org_b"]);
  });
});
