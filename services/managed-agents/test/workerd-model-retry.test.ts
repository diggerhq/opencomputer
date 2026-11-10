import { describe, expect, it } from "vitest";

import {
  MODEL_RETRY_OVERRIDE_DELAY_MS,
  modelRetryDecision,
} from "../src/workerd-runtime/model-retry.js";

describe("model retry policy", () => {
  it("keeps OpenCode's proposed retry and its wait, however long the provider asked for", () => {
    for (const [type, delay] of [
      ["provider.rate-limit", 15 * 60_000],
      ["provider.internal", 2_000],
      ["provider.unknown", 4_000],
      ["provider.invalid-output", 8_000],
      ["provider.transport", 16_000],
    ] as const) {
      expect(
        modelRetryDecision({ error: { type }, decision: { retry: true, delay }, hostRetried: false }),
      ).toEqual({ decision: { retry: true, delay }, overridden: false });
    }
  });

  it("grants one retry for a transport failure OpenCode declined", () => {
    expect(
      modelRetryDecision({
        error: { type: "provider.transport", message: "socket hang up" },
        decision: { retry: false },
        hostRetried: false,
      }),
    ).toEqual({ decision: { retry: true, delay: MODEL_RETRY_OVERRIDE_DELAY_MS }, overridden: true });
  });

  it("grants one retry for a response stream OpenCode declined to continue", () => {
    expect(
      modelRetryDecision({
        error: { type: "provider.invalid-output" },
        decision: { retry: false },
        hostRetried: false,
      }),
    ).toEqual({ decision: { retry: true, delay: MODEL_RETRY_OVERRIDE_DELAY_MS }, overridden: true });
  });

  it("grants the retry once per model call", () => {
    for (const type of ["provider.transport", "provider.invalid-output"]) {
      expect(
        modelRetryDecision({ error: { type }, decision: { retry: false }, hostRetried: true }),
      ).toEqual({ decision: { retry: false }, overridden: false });
    }
  });

  it("leaves every other decline in place", () => {
    for (const type of [
      "provider.rate-limit",
      "provider.internal",
      "provider.unknown",
      "provider.auth",
      "provider.quota",
      "provider.content-filter",
      "provider.invalid-request",
      "provider.no-route",
      "permission.rejected",
      "tool.execution",
      "unknown",
    ]) {
      expect(
        modelRetryDecision({ error: { type }, decision: { retry: false }, hostRetried: false }),
      ).toEqual({ decision: { retry: false }, overridden: false });
    }
  });
});
