import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { alarms, canonicalJson, cursor, type Emitter, hashOf, idem, migrate, owed, sqlOf, type Sql } from "../src/actor/index.js";

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

const quiet: Emitter = () => undefined;

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
      await owed.run(sql, send, Date.now(), quiet);
      expect(sent).toEqual(["c"]);
      fail = false;
      await owed.run(sql, send, Date.now(), quiet);
      expect(sent).toEqual(["c"]); // backing off: 1 s
      await owed.run(sql, send, Date.now() + 1_500, quiet);
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
        quiet,
      );
      expect(sent).toEqual([2, 3]);
      expect(owed.has(sql, "summary")).toBe(false);
    });
  });
  it("a debounced call folds in what comes before it is due, and not once it is due or tried", async () => {
    await withSql("owed-debounce", async (sql) => {
      const later = Date.now() + 20_000;
      const merge = (to: number) => (pending: unknown) => ({ ...(pending as object), to });
      owed.debounce(sql, { group: "wake:a", call: "wake", body: { from: 1, to: 1 }, at: later }, merge(1));
      owed.debounce(sql, { group: "wake:a", call: "wake", body: { from: 2, to: 2 }, at: later + 5_000 }, merge(2));
      expect(sql.exec("SELECT body, at FROM _owed")).toEqual([{ body: JSON.stringify({ from: 1, to: 2 }), at: later }]);
      sql.exec("UPDATE _owed SET at = 0");
      owed.debounce(sql, { group: "wake:a", call: "wake", body: { from: 3, to: 3 }, at: later }, merge(3));
      expect(sql.exec("SELECT body FROM _owed ORDER BY n")).toEqual([{ body: JSON.stringify({ from: 1, to: 2 }) }, { body: JSON.stringify({ from: 3, to: 3 }) }]);
    });
  });
  it("a caller's schedule ends in the dead list", async () => {
    await withSql("owed-dead", async (sql) => {
      owed.add(sql, { group: "g", call: "hook", at: 0, schedule: [0] });
      const send = async () => {
        throw new Error("410");
      };
      await owed.run(sql, send, Date.now(), quiet);
      await owed.run(sql, send, Date.now() + 10, quiet);
      expect(owed.dead(sql)).toMatchObject([{ group: "g", call: "hook", tries: 2, lastError: "410" }]);
      expect(sql.exec("SELECT n FROM _owed")).toEqual([]);
    });
  });
  it("without a schedule, a day of tries ends in the dead list, reported, and its group moves on", async () => {
    await withSql("owed-default-dead", async (sql) => {
      owed.add(sql, { group: "g", call: "poison", at: 0 });
      owed.add(sql, { group: "g", call: "next", at: 0 });
      const sent: string[] = [];
      const send = async (call: string) => {
        if (call === "poison") throw new Error("never");
        sent.push(call);
      };
      const events: [string, Record<string, unknown> | undefined, string | undefined][] = [];
      const emit: Emitter = (event, fields, level) => void events.push([event, fields, level]);
      await owed.run(sql, send, Date.now(), emit);
      expect(sent).toEqual([]);
      // 1, 2, 5, 15 s, then every 60 s for 24 hours: the try before the last.
      sql.exec("UPDATE _owed SET tries = ?, at = 0 WHERE call = 'poison'", 4 + 24 * 60 - 2);
      await owed.run(sql, send, Date.now(), emit);
      expect(sent).toEqual([]);
      expect(owed.dead(sql)).toEqual([]);
      sql.exec("UPDATE _owed SET at = 0 WHERE call = 'poison'");
      await owed.run(sql, send, Date.now(), emit);
      expect(sent).toEqual(["next"]);
      expect(owed.dead(sql)).toMatchObject([{ group: "g", call: "poison", tries: 4 + 24 * 60, lastError: "never" }]);
      expect(events).toEqual([["owed.dead", { group: "g", call: "poison", tries: 4 + 24 * 60, error: "never" }, "error"]]);
      expect(sql.exec("SELECT n FROM _owed")).toEqual([]);
    });
  });
  it("one run per group: a held group holds no other, and a call during its run waits for the round it asked for", async () => {
    await withSql("owed-groups", async (sql) => {
      owed.add(sql, { group: "slow", key: "slow", call: "slow", at: 0 });
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const sent: string[] = [];
      const send = async (call: string) => {
        sent.push(call);
        if (call === "slow" && sent.filter((c) => c === "slow").length === 1) await held;
      };
      const first = owed.run(sql, send, Date.now(), quiet);
      owed.add(sql, { group: "fast", call: "fast", at: 0 });
      await owed.run(sql, send, Date.now(), quiet, "fast");
      expect(sent).toEqual(["slow", "fast"]);
      owed.add(sql, { group: "slow", key: "slow", call: "slow", at: 0 });
      const again = owed.run(sql, send, Date.now(), quiet, "slow");
      release();
      await Promise.all([first, again]);
      expect(sent).toEqual(["slow", "fast", "slow"]);
      expect(owed.groups(sql)).toEqual([]);
    });
  });
  it("due: a call that waited for an event goes now", async () => {
    await withSql("owed-due", async (sql) => {
      const later = Date.now() + 3_600_000;
      owed.add(sql, { group: "a", call: "a", at: later });
      owed.add(sql, { group: "b", call: "b", at: later });
      const sent: string[] = [];
      const send = async (call: string) => void sent.push(call);
      owed.due(sql, "a");
      await owed.run(sql, send, Date.now(), quiet);
      expect(sent).toEqual(["a"]);
      expect(owed.groups(sql)).toEqual(["b"]);
      owed.due(sql);
      await owed.run(sql, send, Date.now(), quiet);
      expect(sent).toEqual(["a", "b"]);
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
