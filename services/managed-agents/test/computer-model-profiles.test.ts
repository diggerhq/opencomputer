import { describe, expect, it } from "vitest";

import { harnessOnProfile, helloProfiles, profileHarnesses } from "../src/computer/harnesses.js";
import { NO_MODEL_CREDENTIAL, listsProfile, managedModelRoute, modelKey } from "../src/computer/model-key.js";
import type { ModelProfile } from "../src/computer/protocol.js";

/**
 * Work 097, protocol 5 (design C2 and C8): a model route names a profile of
 * the host's model proxy and carries its variables. The pure parts: the
 * `key` hash, the managed route, and what a hello's profiles say.
 */

const profile = (name: string, ...harnesses: string[]): ModelProfile => ({ name, vars: ["token"], harness: Object.fromEntries(harnesses.map((h) => [h, {}])) });
const LISTED = [profile("anthropic-key", "claude"), profile("openrouter", "claude"), profile("openai-key", "codex")];

describe("modelKey", () => {
  it("is the first 16 hex digits of sha256 over the profile and its variables in name order, joined by NUL", async () => {
    // printf 'openrouter\0token=sk-or-test' | sha256sum
    expect(await modelKey("openrouter", { token: "sk-or-test" })).toBe("427939d396f90454");
    // printf 'p\0a=1\0b=2' | sha256sum
    expect(await modelKey("p", { b: "2", a: "1" })).toBe("c79bd378f5b5e1f1");
  });

  it("differs by profile and by value", async () => {
    const key = await modelKey("openrouter", { token: "sk-or-test" });
    expect(await modelKey("anthropic-key", { token: "sk-or-test" })).not.toBe(key);
    expect(await modelKey("openrouter", { token: "sk-or-other" })).not.toBe(key);
  });
});

describe("managedModelRoute", () => {
  const env = { COMPUTER_ANTHROPIC_API_KEY: "sk-ant-shared" };

  it("routes the organization's key on `openrouter`", async () => {
    expect(await managedModelRoute("sk-or-org", env, LISTED)).toEqual({
      route: { mode: "profile", profile: "openrouter", vars: { token: "sk-or-org" }, key: await modelKey("openrouter", { token: "sk-or-org" }) },
      fallback: false,
    });
  });

  it("falls back to the shared key on `anthropic-key`", async () => {
    expect(await managedModelRoute(null, env, LISTED)).toEqual({
      route: { mode: "profile", profile: "anthropic-key", vars: { token: "sk-ant-shared" }, key: await modelKey("anthropic-key", { token: "sk-ant-shared" }) },
      fallback: true,
    });
  });

  it("refuses, in the backend's words, a profile the host's hello does not list", async () => {
    expect(await managedModelRoute("sk-or-org", env, [profile("anthropic-key", "claude")])).toEqual({
      route: { mode: "refuse", reason: "This computer has no model profile `openrouter`." },
      fallback: false,
    });
    expect((await managedModelRoute(null, env, [])).route).toEqual({ mode: "refuse", reason: "This computer has no model profile `anthropic-key`." });
  });

  it("leaves the answer to a host whose hello never listed any profile", async () => {
    expect((await managedModelRoute("sk-or-org", env, undefined)).route).toMatchObject({ mode: "profile", profile: "openrouter" });
    expect(listsProfile(undefined, "openrouter")).toBe(true);
    expect(listsProfile([], "openrouter")).toBe(false);
  });

  it("refuses when there is no managed credential at all", async () => {
    expect(await managedModelRoute(null, {}, LISTED)).toEqual({ route: { mode: "refuse", reason: NO_MODEL_CREDENTIAL }, fallback: true });
  });
});

describe("a hello's profiles", () => {
  it("keeps the well-formed ones, and only their protocol fields", () => {
    expect(helloProfiles(undefined)).toBeUndefined();
    expect(helloProfiles("openrouter")).toBeUndefined();
    expect(helloProfiles([])).toEqual([]);
    expect(
      helloProfiles([
        { name: "openrouter", vars: ["token"], harness: { claude: { baseUrl: "http://proxy" } }, extra: 1 },
        { name: "no-vars", harness: {} },
        { name: 7, vars: [], harness: {} },
        { name: "vars-not-strings", vars: [1], harness: {} },
        { name: "harness-not-an-object", vars: [], harness: [] },
        null,
      ]),
    ).toEqual([{ name: "openrouter", vars: ["token"], harness: { claude: { baseUrl: "http://proxy" } } }]);
    expect(helloProfiles(Array.from({ length: 40 }, (_, i) => profile(`p${i}`, "claude")))).toHaveLength(32);
  });

  it("say which harnesses the computer can run: the default one, and those a profile serves", () => {
    expect(profileHarnesses([])).toEqual(["claude"]);
    expect(profileHarnesses([profile("openrouter", "claude")])).toEqual(["claude"]);
    expect(profileHarnesses(LISTED)).toEqual(["claude", "codex"]);
  });

  it("say which harness a session on a profile runs", () => {
    expect(harnessOnProfile(LISTED, "openrouter", "claude")).toBe("claude");
    expect(harnessOnProfile(LISTED, "openai-key", "codex")).toBe("codex");
    // A profile that does not serve the wanted harness: the one it serves.
    expect(harnessOnProfile(LISTED, "openrouter", "codex")).toBe("claude");
    expect(harnessOnProfile(LISTED, "openai-key", "claude")).toBe("codex");
    // A profile the host did not list, or a host that listed none: the wanted one.
    expect(harnessOnProfile(LISTED, "unknown", "codex")).toBe("codex");
    expect(harnessOnProfile(undefined, "openrouter", "codex")).toBe("codex");
  });
});
