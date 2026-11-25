import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { alarms, canonicalJson, cursor, hashOf, idem, migrate, owed, sqlOf, type Sql } from "../src/actor/index.js";

/** The shared actor module (spec 36.7), on a real Durable Object's storage. */

const ORGS = (env as unknown as { ORGS: DurableObjectNamespace }).ORGS;

async function withSql<T>(name: string, fn: (sql: Sql, state: DurableObjectState) => Promise<T> | T): Promise<T> {
  return runInDurableObject(ORGS.getByName(name), async (_instance, state) => {
    const sql = sqlOf(state.storage);
    migrate(sql, []);
    return fn(sql, state);
  });
}

describe("migrate", () => {
  it("applies each step once, in order", async () => {
    await withSql("migrate", (sql) => {
      const steps = [(s: Sql) => void s.exec("CREATE TABLE a (x INTEGER)"), (s: Sql) => void s.exec("INSERT INTO a VALUES (1)")];
      migrate(sql, steps);
      migrate(sql, steps);
      migrate(sql, [...steps, (s: Sql) => void s.exec("INSERT INTO a VALUES (2)")]);
      expect(sql.exec("SELECT x FROM a ORDER BY x")).toEqual([{ x: 1 }, { x: 2 }]);
    });
  });
  it("rolls a failed step back and leaves it to apply", async () => {
    await withSql("migrate-fail", (sql) => {
      const bad = (s: Sql) => {
        s.exec("CREATE TABLE b (x INTEGER)");
        throw new Error("no");
      };
      expect(() => migrate(sql, [bad])).toThrow("no");
      migrate(sql, [(s: Sql) => void s.exec("CREATE TABLE b (x INTEGER)")]);
      expect(sql.exec("SELECT COUNT(*) AS c FROM b")).toEqual([{ c: 0 }]);
    });
  });
});

describe("alarms", () => {
  it("keeps the earlier time, arms the one alarm, and a purpose stays due until done", async () => {
    await withSql("alarms", async (sql, state) => {
      const t = Date.now() + 3_600_000;
      alarms.set(sql, "a", t + 5_000);
      alarms.set(sql, "a", t + 9_000);
      alarms.set(sql, "b", t + 7_000);
      expect(await state.storage.getAlarm()).toBe(t + 5_000);
      expect(alarms.due(sql, t + 6_000)).toEqual(["a"]);
      expect(await state.storage.getAlarm()).toBe(t + 7_000);
      expect(alarms.due(sql, t + 6_000)).toEqual(["a"]);
      alarms.done(sql, "a", true, t + 6_000);
      expect(alarms.due(sql, t + 6_000)).toEqual([]);
      alarms.clear(sql, "b");
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });
  it("runs each handler on its own; one that throws is due again", async () => {
    await withSql("alarms-run", async (sql) => {
      const far = Date.now() + 3_600_000;
      alarms.set(sql, "ok", 1);
      alarms.set(sql, "bad", 1);
      const ran: string[] = [];
      await alarms.run(sql, 10, {
        ok: () => {
          ran.push("ok");
          alarms.set(sql, "ok", far);
        },
        bad: () => {
          throw new Error("x");
        },
      });
      expect(ran).toEqual(["ok"]);
      expect(sql.exec<{ purpose: string; at: number }>("SELECT purpose, at FROM _alarm ORDER BY purpose").map((r) => [r.purpose, r.at === far])).toEqual([
        ["bad", false],
        ["ok", true],
      ]);
    });
  });
});

describe("owed", () => {
  it("sends a group in order, stops it at a failure, and lets other groups through", async () => {
    await withSql("owed", async (sql) => {
      sql.transaction(() => {
        owed.add(sql, { group: "s1", call: "a", body: 1, at: 0 });
        owed.add(sql, { group: "s1", call: "b", body: 2, at: 0 });
        owed.add(sql, { group: "s2", call: "c", at: 0 });
      });
      const sent: string[] = [];
      let fail = true;
      const send = async (call: string) => {
        if (call === "a" && fail) throw new Error("down");
        sent.push(call);
      };
      await owed.run(sql, send, Date.now());
      expect(sent).toEqual(["c"]);
      fail = false;
      await owed.run(sql, send, Date.now());
      expect(sent).toEqual(["c"]); // backing off: 1 s
      await owed.run(sql, send, Date.now() + 1_500);
      expect(sent).toEqual(["c", "a", "b"]);
      expect(sql.exec("SELECT n FROM _owed")).toEqual([]);
    });
  });
  it("a key is a slot: replaced unsent, and sent again when replaced in flight", async () => {
    await withSql("owed-slot", async (sql) => {
      owed.add(sql, { group: "g", key: "summary", call: "s", body: 1, at: 0 });
      owed.add(sql, { group: "g", key: "summary", call: "s", body: 2, at: 0 });
      const sent: unknown[] = [];
      await owed.run(
        sql,
        async (_call, body) => {
          sent.push(body);
          if (body === 2) owed.add(sql, { group: "g", key: "summary", call: "s", body: 3, at: 0 });
        },
        Date.now(),
      );
      expect(sent).toEqual([2, 3]);
      expect(owed.has(sql, "summary")).toBe(false);
    });
  });
  it("a caller's schedule ends in the dead list", async () => {
    await withSql("owed-dead", async (sql) => {
      owed.add(sql, { group: "g", call: "hook", at: 0, schedule: [0] });
      const send = async () => {
        throw new Error("410");
      };
      await owed.run(sql, send, Date.now());
      await owed.run(sql, send, Date.now() + 10);
      expect(owed.dead(sql)).toMatchObject([{ group: "g", call: "hook", tries: 2, lastError: "410" }]);
      expect(sql.exec("SELECT n FROM _owed")).toEqual([]);
    });
  });
});

describe("idem", () => {
  it("answers the stored result, a conflict on another hash, and nothing once expired", async () => {
    await withSql("idem", async (sql) => {
      const hash = await hashOf({ b: 1, a: [2] });
      expect(hash).toBe(await hashOf({ a: [2], b: 1 }));
      expect(idem.get(sql, "k", hash)).toBeNull();
      idem.put(sql, "k", hash, { ok: true }, 60_000);
      expect(idem.get(sql, "k", hash)).toEqual({ result: { ok: true } });
      expect(idem.get(sql, "k", "other")).toEqual({ conflict: true });
      idem.put(sql, "old", hash, 1, -1);
      expect(idem.get(sql, "old", hash)).toBeNull();
    });
  });
});

describe("cursor", () => {
  it("round-trips each kind and refuses what it did not make", () => {
    expect(cursor.encode("e", [3, 41])).toBe("e1.3.41");
    expect(cursor.encode("f", [7])).toBe("f1.7");
    expect(cursor.encode("o", [0])).toBe("o1.0");
    expect(cursor.decode("e1.3.41")).toEqual({ kind: "e", parts: [3, 41] });
    const page = cursor.encode("p", ["threads", 12, "a.b"]);
    expect(cursor.decode(page)).toEqual({ kind: "p", parts: ["threads", 12, "a.b"] });
    expect(cursor.read("f", "e1.3.41")).toBeNull();
    for (const bad of ["", "e1.3", "e2.3.4", "f1.-1", "f1.01", "x1.1", "p1.!!", "41"]) expect(cursor.decode(bad)).toBeNull();
  });
  it("canonical JSON sorts keys and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [1, { z: 1, y: 2 }] } })).toBe('{"a":{"c":[1,{"y":2,"z":1}]},"b":1}');
  });
});
