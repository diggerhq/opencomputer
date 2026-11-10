import { describe, expect, it } from "vitest";

import { failedTurnData } from "../src/runtime/failure.js";

describe("runtime failure normalization", () => {
  it("marks an OpenRouter credit preflight refusal as model credit exhaustion", () => {
    expect(
      failedTurnData(
        new Error(
          "This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 63873.",
        ),
      ),
    ).toEqual({
      message:
        "This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 63873.",
      code: "model_credit_exhausted",
    });
  });

  it("does not classify unrelated provider failures", () => {
    expect(failedTurnData(new Error("Provider blocked the response"))).toEqual({
      message: "Provider blocked the response",
    });
  });
});
