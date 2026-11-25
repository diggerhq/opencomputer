import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { migrate, owed, sqlOf, type Principal, type Sql } from "../src/actor/index.js";
import { runMutation } from "../src/org/mutations/index.js";
import { STEPS } from "../src/org/schema.js";
import { changesAt, emptySummary, sessionRow, readSession, transact } from "../src/org/tx.js";

/** Org's transaction helpers and one mutation, on a real Durable Object's storage (spec 35.1, 37.3). */

const ORGS = (env as unknown as { ORGS: DurableObjectNamespace }).ORGS;

export async function withOrg<T>(name: string, fn: (sql: Sql) => Promise<T> | T): Promise<T> {
  return runInDurableObject(ORGS.getByName(name), async (_instance, state) => {
    const sql = sqlOf(state.storage);
    migrate(sql, STEPS);
    return fn(sql);
  });
}

export const member = (subject: string, org = "org_t"): Principal => ({
  org,
  subject,
  kind: "member",
  via: "app",
  scopes: ["sessions:read", "sessions:write", "work:read", "work:write"] as Principal["scopes"],
  audiences: ["org", `member:${subject}`],
  admin: false,
  credential: { id: "c", expiresAt: null },
});

/** A thread owned by `owner`, with its place. */
export function seedThread(sql: Sql, id: string, owner: string): void {
  transact(sql, Date.now(), (tx) => {
    const s = tx.addSession({ id, owner, origin: { type: "api", client: null, slack: null }, machine: "org_t", createdBy: `user:${owner}`, summary: emptySummary({}, "First words") });
    tx.addPlace({ sessionId: id, placedBy: `user:${owner}`, audience: s.audience });
  });
}

describe("Org's transaction", () => {
  it("stamps one version, writes the op row and owes the publish", async () => {
    await withOrg("tx-rename", (sql) => {
      seedThread(sql, "cs_0000000000000001", "usr_a");
      expect(changesAt(sql, 1).rows.map((r) => r.kind).sort()).toEqual(["place", "session"]);
      expect(owed.has(sql, "live:feed")).toBe(true);

      const out = transact(sql, Date.now(), (tx) => runMutation(tx, member("usr_a"), "thread.rename", { sid: "cs_0000000000000001", title: "Fix the login redirect" }));
      expect(out.ok).toBe(true);
      const changed = changesAt(sql, 2);
      expect(changed.rows.map((r) => r.kind).sort()).toEqual(["op", "session"]);
      const row = sessionRow(sql, readSession(sql, "cs_0000000000000001")!);
      expect(row).toMatchObject({ kind: "session", title: "Fix the login redirect", titleBy: "user:usr_a", agentTitle: "First words", status: "starting", version: 2, audience: "org" });
      expect(changed.rows.find((r) => r.kind === "op")).toMatchObject({ name: "thread.rename", sessionId: "cs_0000000000000001", inverse: { title: null, titleBy: null } });
    });
  });

  it("answers not_found to another member and leaves no write", async () => {
    await withOrg("tx-refuse", (sql) => {
      seedThread(sql, "cs_0000000000000002", "usr_a");
      const out = transact(sql, Date.now(), (tx) => runMutation(tx, member("usr_b"), "thread.rename", { sid: "cs_0000000000000002", title: "Mine" }));
      expect(out).toMatchObject({ ok: false, code: "not_found" });
      expect(sql.exec("SELECT version FROM meta")).toEqual([{ version: 1 }]);
    });
  });

  it("undoes the writes of an attempt that refuses, and its version", async () => {
    await withOrg("tx-attempt", (sql) => {
      seedThread(sql, "cs_0000000000000003", "usr_a");
      transact(sql, Date.now(), (tx) => {
        const out = tx.attempt(() => {
          tx.sql.exec("UPDATE session SET title = 'x' WHERE id = 'cs_0000000000000003'");
          tx.stamp("session", "cs_0000000000000003");
          tx.occurFor("thread.done", readSession(tx.sql, "cs_0000000000000003")!, "platform");
          return { ok: false as const };
        });
        expect(out.ok).toBe(false);
        expect(tx.changed).toBe(false);
      });
      expect(sql.exec("SELECT title, version FROM session")).toEqual([{ title: null, version: 1 }]);
      expect(sql.exec("SELECT version, occ FROM meta")).toEqual([{ version: 1, occ: 0 }]);
      expect(owed.has(sql, "poke:wake")).toBe(false);
    });
  });
});
