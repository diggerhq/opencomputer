import { describe, it, expect } from "vitest";
import { normalize, serialize } from "./normalize.js";

describe("normalize (API response → idiomatic TS)", () => {
  it("camelCases nested keys — last_turn → lastTurn, and the field is `id`", () => {
    const out = normalize<{ lastTurn?: { id?: string; yieldReason?: string; resultEventId?: string } }>({
      last_turn: { id: "trn_1", yield_reason: "completed", result_event_id: "evt_9" },
    });
    expect(out.lastTurn?.id).toBe("trn_1");
    expect(out.lastTurn?.yieldReason).toBe("completed");
    expect(out.lastTurn?.resultEventId).toBe("evt_9");
  });

  it("coerces known stringified-bigint numerics", () => {
    const out = normalize<{ seq?: number; head?: number }>({ seq: "12", head: "3" });
    expect(out.seq).toBe(12);
    expect(out.head).toBe(3);
  });

  it("passes `metadata` through verbatim — opaque, inner keys untouched", () => {
    const out = normalize<{ metadata?: Record<string, unknown> }>({
      metadata: { pull_number: 42, owner_repo: "acme/widgets", nested: { keep_me: true } },
    });
    // Caller's routing JSON must round-trip exactly as set (no snake→camel mangling).
    expect(out.metadata).toEqual({ pull_number: 42, owner_repo: "acme/widgets", nested: { keep_me: true } });
  });
});

describe("serialize (request body → snake_case)", () => {
  it("snake_cases keys but leaves metadata opaque", () => {
    const out = serialize({ idempotencyKey: "k1", metadata: { pullNumber: 42 } }) as Record<string, unknown>;
    expect(out.idempotency_key).toBe("k1");
    expect(out.metadata).toEqual({ pullNumber: 42 }); // verbatim
  });
});
