import { describe, expect, it, vi } from "vitest";

import {
  deploymentAllowsGatewayModel,
  ModelValidationError,
  openRouterCatalogId,
  openRouterModelCatalog,
  parseManagedModel,
  validateModels,
} from "../src/edge/model-catalog.js";

describe("managed model catalog", () => {
  it("preserves exact OpenRouter model ids", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({ data: [{ id: "anthropic/claude-sonnet-5" }] }),
    );
    const catalog = await openRouterModelCatalog({ fetch: fetcher });
    validateModels(
      [{ provider: "openrouter", model: "anthropic/claude-sonnet-5" }],
      catalog,
    );
    expect(openRouterCatalogId({ provider: "openrouter", model: "anthropic/claude-sonnet-5" }))
      .toBe("anthropic/claude-sonnet-5");
  });

  it("rejects an unavailable exact id without fallback", () => {
    expect(() =>
      validateModels(
        [{ provider: "openrouter", model: "anthropic/claude-sonnet-5" }],
        new Set(["anthropic/claude-sonnet-4.6"]),
      ),
    ).toThrow(ModelValidationError);
  });

  it("treats BLUE_DEFAULT_MODEL as a provider-qualified default", () => {
    expect(parseManagedModel("openrouter/anthropic/claude-sonnet-5")).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-5",
    });
  });

  it("does not let the gateway substitute an earlier model", () => {
    expect(
      deploymentAllowsGatewayModel(
        [{ provider: "openrouter", model: "anthropic/claude-sonnet-5" }],
        { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
      ),
    ).toBe(false);
  });
});
