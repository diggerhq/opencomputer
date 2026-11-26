import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { matchMutation, mutationRequest } from "./mutation-table.js";

describe("the mutation table", () => {
  it("is the server's, copied (npm run mutations)", () => {
    const server = path.resolve(import.meta.dirname, "../../../../services/managed-agents/src/org/mutations/table.ts");
    expect(readFileSync(path.resolve(import.meta.dirname, "mutation-table.ts"), "utf8")).toBe(readFileSync(server, "utf8"));
  });

  it("puts path arguments in the path and the rest in the body, and reads them back", () => {
    const r = mutationRequest("thread.place", { sid: "cs_0123456789abcdef", trackId: null });
    expect(r).toEqual({ method: "PUT", path: "/work/threads/cs_0123456789abcdef/track", body: { trackId: null } });
    expect(matchMutation(r.method, r.path)).toEqual({ name: "thread.place", args: { sid: "cs_0123456789abcdef" } });
    expect(matchMutation("GET", r.path)).toBeNull();
  });
});
