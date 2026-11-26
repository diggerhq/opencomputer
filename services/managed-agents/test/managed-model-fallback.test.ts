import { describe, expect, it } from "vitest";

import {
  DEFAULT_MANAGED_FALLBACK_MODEL,
  managedFallbackTarget,
  shouldRetryOnFallback,
} from "../src/edge/managed-model-fallback.js";

const paid = { paid: true, fallback: true, stopped: false };
const base = { paid: false, fallback: false, stopped: false };

describe("managed model fallback", () => {
  it("targets the default open-weight model with the platform key", () => {
    expect(
      managedFallbackTarget({ OPENROUTER_API_KEY: "platform-key" }, paid),
    ).toEqual({ apiKey: "platform-key", model: DEFAULT_MANAGED_FALLBACK_MODEL });
  });

  it("prefers the dedicated fallback key and configured model", () => {
    expect(
      managedFallbackTarget(
        {
          OPENROUTER_API_KEY: "platform-key",
          MANAGED_FALLBACK_OPENROUTER_API_KEY: "fallback-key",
          MANAGED_FALLBACK_MODEL: "moonshotai/kimi-k3",
        },
        paid,
      ),
    ).toEqual({ apiKey: "fallback-key", model: "moonshotai/kimi-k3" });
  });

  it("offers no fallback to base organizations", () => {
    expect(
      managedFallbackTarget({ OPENROUTER_API_KEY: "platform-key" }, base),
    ).toBeUndefined();
  });

  it("offers no fallback without a platform key", () => {
    expect(managedFallbackTarget({}, paid)).toBeUndefined();
  });

  it("retries only a paid organization's credit-cap 402", () => {
    const paidWithCredits = { paid: true, fallback: false, stopped: false };
    expect(shouldRetryOnFallback(402, paidWithCredits)).toBe(true);
    expect(shouldRetryOnFallback(429, paidWithCredits)).toBe(false);
    expect(shouldRetryOnFallback(402, base)).toBe(false);
    expect(shouldRetryOnFallback(402, paid)).toBe(false);
  });
});
