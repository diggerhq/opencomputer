import { describe, expect, it } from "vitest";

import { CONTEXT_MAX_AGE_MS, CONTEXT_MAX_CHARS, CONTEXT_MAX_ROWS } from "../src/computer/access.js";
import { AccessStore } from "../src/computer/access-store.js";
import { sqlStorage } from "./fixtures/computer-sql.js";

function store() {
  const sql = sqlStorage();
  sql.exec(`
    CREATE TABLE sessions (runner_key TEXT PRIMARY KEY, owner_id TEXT);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  // A session from before work 112.
  sql.exec("INSERT INTO sessions (runner_key, owner_id) VALUES ('k', 'U1')");
  return { sql, store: new AccessStore(sql) };
}

describe("session roles: the store (work 112)", () => {
  it("adds the column once: older sessions read '*', a second instance changes nothing", () => {
    const { sql, store: s } = store();
    expect(s.drivers("k")).toBe("*");
    expect(s.drivers("missing")).toBeUndefined();
    s.writeDrivers("k", ["U2"]);
    new AccessStore(sql);
    expect(s.drivers("k")).toEqual(["U2"]);
  });

  it("the default is open until set", () => {
    const { store: s } = store();
    expect(s.accessDefault()).toBe("open");
    s.setAccessDefault("owner");
    expect(s.accessDefault()).toBe("owner");
  });

  it("context: text cut, the newest rows oldest first with how many were skipped, old rows deleted", () => {
    const { store: s } = store();
    const now = 10 * CONTEXT_MAX_AGE_MS;
    s.hold("k", { userId: "U2", ts: "old", text: "stale", files: [] }, now - CONTEXT_MAX_AGE_MS - 1);
    s.hold("k", { userId: "U2", ts: "big", text: "x".repeat(CONTEXT_MAX_CHARS + 10), files: ["a.png"] }, now);
    for (let i = 0; i < CONTEXT_MAX_ROWS + 1; i++) s.hold("k", { userId: "U3", ts: `t${i}`, text: `m${i}`, files: [] }, now);
    const held = s.held("k", now);
    expect(held).toHaveLength(CONTEXT_MAX_ROWS);
    expect(held[0]).toMatchObject({ ts: "t1", skipped: 2 });
    expect(held.at(-1)).toMatchObject({ ts: `t${CONTEXT_MAX_ROWS}` });
    expect(held.filter((m) => m.skipped)).toHaveLength(1);
    s.forget(held.map((m) => m.seq));
    expect(s.held("k", now)).toMatchObject([{ ts: "big", files: ["a.png"], text: "x".repeat(CONTEXT_MAX_CHARS) }, { ts: "t0", files: [] }]);
    s.forgetMessage("k", "big");
    expect(s.held("k", now).map((m) => m.ts)).toEqual(["t0"]);
  });

  it("requests: one per person, closed once", () => {
    const { store: s } = store();
    s.addRequest("k", "U2", "1.1", "{}", 1);
    s.addRequest("k", "U2", "2.2", "{}", 2);
    s.addRequest("k", "U3", "3.3", "{}", 3);
    expect(s.openRequests("k").map((r) => [r.userId, r.messageTs])).toEqual([["U2", "1.1"], ["U3", "3.3"]]);
    expect(s.closeRequest("k", "U2")).toBe(true);
    expect(s.closeRequest("k", "U2")).toBe(false);
    expect(s.request("k", "U2")?.state).toBe("closed");
    expect(s.openRequests("k").map((r) => r.userId)).toEqual(["U3"]);
  });
});
