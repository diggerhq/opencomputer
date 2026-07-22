import { describe, expect, it } from "vitest";
import type { CreateSessionParams } from "./sessions.js";

type HasRevisionOverride = "revision" extends keyof CreateSessionParams ? true : false;
const hasRevisionOverride: HasRevisionOverride = false;

describe("session create contract", () => {
  it("does not expose unsupported revision selection", () => {
    expect(hasRevisionOverride).toBe(false);
  });
});
