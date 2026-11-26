import { afterEach, describe, expect, it, vi } from "vitest";
import { makeId } from "./ids.js";

const CROCKFORD = /^[0-9a-hjkmnp-tv-z]+$/;

describe("makeId", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is the prefix and lowercase Crockford base32: 12 for a turn, 16 otherwise", () => {
    for (const prefix of ["cs", "trk", "res", "prp", "op", "cl", "tr", "ib"] as const) {
      const id = makeId(prefix);
      expect(id.startsWith(`${prefix}_`)).toBe(true);
      expect(id.slice(prefix.length + 1)).toMatch(CROCKFORD);
      expect(id.length).toBe(prefix.length + 17);
    }
    expect(makeId("tn")).toMatch(/^tn_[0-9a-hjkmnp-tv-z]{12}$/);
  });

  it("draws from the platform's crypto, not Math.random", () => {
    const random = vi.spyOn(Math, "random");
    const ids = new Set(Array.from({ length: 500 }, () => makeId("cs")));
    expect(ids.size).toBe(500);
    expect(random).not.toHaveBeenCalled();
    const seen = new Set([...ids].flatMap((id) => [...id.slice(3)]));
    expect(seen.size).toBe(32);
  });

  it("takes an injected source", () => {
    expect(makeId("op", () => 0)).toBe("op_0000000000000000");
    expect(makeId("tn", () => 0.999999)).toBe("tn_zzzzzzzzzzzz");
  });
});
