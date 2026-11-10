import { describe, expect, it } from "vitest";
import { COMPUTER_SESSION_KEY_SCOPES, KEY_SCOPES, createAPIKey, type APIKeyEnv } from "./api_keys";

function fakeEnv(): { env: APIKeyEnv; runs: unknown[][] } {
  const runs: unknown[][] = [];
  const db = {
    prepare: () => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          runs.push(args);
          return {};
        },
      }),
    }),
  };
  return { env: { OPENCOMPUTER_DB: db } as unknown as APIKeyEnv, runs };
}

const base = { orgID: "org-x", userID: "user-x", name: "k" };

describe("createAPIKey scopes (work 095)", () => {
  it("stores and returns the scopes the minter names", async () => {
    const { env, runs } = fakeEnv();
    const created = await createAPIKey(env, { ...base, scopes: ["sessions:read", "sessions:read", "terminals"] });
    expect(created.scopes).toEqual(["sessions:read", "terminals"]);
    expect(runs[0][9]).toBe("sessions:read,terminals");
  });

  it("refuses an empty list or a wildcard, which would read as everything", async () => {
    const { env, runs } = fakeEnv();
    for (const scopes of [[], ["*"], ["sandbox:*"], ["sessions:read", "*"], ["a,b"], [""]]) {
      await expect(createAPIKey(env, { ...base, scopes })).rejects.toThrow("explicit list");
    }
    expect(runs).toHaveLength(0);
  });

  it("mints no key that can write secrets", () => {
    expect(KEY_SCOPES).not.toContain("secrets:write");
    expect(COMPUTER_SESSION_KEY_SCOPES).not.toContain("secrets:write");
  });
});
