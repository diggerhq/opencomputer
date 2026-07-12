import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ registerProvider: vi.fn() }));

vi.mock("@flue/runtime", () => ({ registerProvider: mocks.registerProvider }));
vi.mock("./cf-env.js", () => ({
  ocResolveEnv: () => ({ OC_GATEWAY: "https://gateway.test" }),
}));

import { route } from "./gateway.js";

describe("Flue gateway binding", () => {
  it("binds the deploy token once and a tokenless request cannot overwrite it", async () => {
    const next = vi.fn(async () => undefined);
    await route({ env: { OC_SESSION_TOKEN: "deploy-token" } } as never, next);
    await route({ env: {} } as never, next);

    expect(mocks.registerProvider).toHaveBeenCalledTimes(1);
    expect(mocks.registerProvider).toHaveBeenCalledWith("anthropic", {
      baseUrl: "https://gateway.test/anthropic",
      apiKey: "deploy-token",
    });
    expect(next).toHaveBeenCalledTimes(2);
  });
});
