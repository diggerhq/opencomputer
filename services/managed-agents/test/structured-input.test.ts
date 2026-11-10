import { describe, expect, it } from "vitest";

import {
  TURN_PAYLOAD_LIMIT,
  canonicalTurnRequest,
  payloadLength,
  turnFingerprint,
} from "../src/edge/structured-input.js";

describe("turn request fingerprint", () => {
  it("applies the mode default and sorts keys at every depth", () => {
    expect(canonicalTurnRequest({ input: "Fix it" })).toBe(
      '{"input":"Fix it","mode":"queue"}',
    );
    expect(
      canonicalTurnRequest({
        input: "Fix it",
        payload: { repo: "acme/widgets", actor: { login: "octocat", id: 1 }, tags: [{ b: 1, a: 2 }] },
      }),
    ).toBe(
      '{"input":"Fix it","mode":"queue","payload":{"actor":{"id":1,"login":"octocat"},"repo":"acme/widgets","tags":[{"a":2,"b":1}]}}',
    );
  });

  it("keeps whitespace, array order, and the null-versus-absent distinction", () => {
    expect(canonicalTurnRequest({ input: " Fix it " })).not.toBe(
      canonicalTurnRequest({ input: "Fix it" }),
    );
    expect(canonicalTurnRequest({ input: "x", payload: [1, 2] })).not.toBe(
      canonicalTurnRequest({ input: "x", payload: [2, 1] }),
    );
    expect(canonicalTurnRequest({ input: "x", payload: null })).not.toBe(
      canonicalTurnRequest({ input: "x" }),
    );
    expect(canonicalTurnRequest({ input: "x", mode: "steer" })).not.toBe(
      canonicalTurnRequest({ input: "x", mode: "queue" }),
    );
  });

  it("item 3: includes the question reference, and leaves requests without one unchanged", async () => {
    expect(canonicalTurnRequest({ input: "go", answers: "question_a" })).toBe(
      '{"answers":"question_a","input":"go","mode":"queue"}',
    );
    expect(await turnFingerprint({ input: "go", answers: "question_a" })).not.toBe(
      await turnFingerprint({ input: "go", answers: "question_b" }),
    );
    expect(await turnFingerprint({ input: "go", answers: "question_a" })).not.toBe(
      await turnFingerprint({ input: "go" }),
    );
    expect(canonicalTurnRequest({ input: "go" })).toBe('{"input":"go","mode":"queue"}');
  });

  it("hashes the canonical form, so key order never changes the fingerprint", async () => {
    const one = await turnFingerprint({
      input: "Fix it",
      mode: "queue",
      payload: { ref: "main", repo: "acme/widgets" },
    });
    const two = await turnFingerprint({
      input: "Fix it",
      payload: { repo: "acme/widgets", ref: "main" },
    });
    expect(one).toBe(two);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      turnFingerprint({ input: "Fix it", payload: { repo: "acme/widgets", ref: "dev" } }),
    ).resolves.not.toBe(one);
  });

  it("measures the payload as encoded bytes against the route limit", () => {
    expect(payloadLength("é")).toBe(4);
    expect(payloadLength({ a: [1, null, true] })).toBe('{"a":[1,null,true]}'.length);
    expect(payloadLength("x".repeat(TURN_PAYLOAD_LIMIT - 2))).toBe(TURN_PAYLOAD_LIMIT);
  });
});
