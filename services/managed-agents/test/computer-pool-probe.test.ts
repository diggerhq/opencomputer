import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type ProbeOutcome, tokenFingerprint } from "../src/computer/model-access.js";
import { ComputerPool } from "../src/computer/pool.js";
import { PROBE_WINDOW_MS, PROBES_PER_TOKEN, PROBES_PER_USER } from "../src/computer/pool-probe-limits.js";
import { sqlStorage } from "./fixtures/computer-sql.js";

/**
 * Work 081: checking a Claude setup token through a warm pool computer. The
 * slots are fakes (no VM): each answers a probe with whatever the test says.
 */

const TOKEN = `sk-ant-oat01-${"a".repeat(40)}`;
const token = (n: number) => `sk-ant-oat01-${String(n).padStart(40, "x")}`;

let sql: SqlStorage;
let now: number;
let answer: (poolId: string, token: string) => Promise<ProbeOutcome>;
let probed: string[];
let status: Record<string, { proxy: boolean } | Error>;
let pool: ComputerPool;
let logs: string[];
let target: number;

function makePool(probeTimeoutMs?: number) {
  return new ComputerPool({
    sql,
    target: () => target,
    now: () => now,
    setAlarm: async () => {},
    ...(probeTimeoutMs ? { probeTimeoutMs } : {}),
    slot: (poolId) => ({
      start: async () => ({ status: 202 }),
      status: async () => {
        const s = status[poolId];
        if (s instanceof Error) throw s;
        return { state: "ready", connected: true, proxy: s?.proxy ?? false };
      },
      release: async () => null,
      retire: async () => {},
      probe: (t) => {
        probed.push(poolId);
        return answer(poolId, t);
      },
    }),
  });
}

function addSlot(poolId: string, state: string) {
  sql.exec("INSERT INTO pool_slots (pool_id, prefix, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?)", poolId, `oc-${poolId}`, state, 1, 1);
}

const dump = () => JSON.stringify([...sql.exec("SELECT * FROM pool_slots ORDER BY pool_id")]);
const countOf = (key: string) => [...sql.exec<{ n: number }>("SELECT n FROM probe_counts WHERE key = ?", key)][0]?.n ?? 0;

beforeEach(() => {
  sql = sqlStorage();
  now = 50 * PROBE_WINDOW_MS + 1_000;
  probed = [];
  status = {};
  answer = async () => ({ status: 200, usage: { fiveHourPct: 12 } });
  logs = [];
  target = 0;
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
  }
  pool = makePool();
});

afterEach(() => vi.restoreAllMocks());

describe("pool probe", () => {
  it("answers no_warm with no warm slot, and asks nobody", async () => {
    addSlot("pool-provisioning", "provisioning");
    addSlot("pool-claiming", "claiming");
    const result = await pool.probe(TOKEN, "user-1");
    expect(result).toEqual({ outcome: { error: "no_warm" }, asked: false, warmSlots: 0, slotsWithProxy: null });
    expect(probed).toEqual([]);
    // Nothing left our egress: nobody is charged for it.
    expect(countOf("user:user-1")).toBe(0);
    expect(countOf(`fp:${await tokenFingerprint(TOKEN)}`)).toBe(0);
  });

  it("asks the one warm slot once and leaves pool_slots byte-identical", async () => {
    addSlot("pool-a", "provisioning");
    addSlot("pool-b", "warm");
    addSlot("pool-c", "claimed");
    const before = dump();
    const result = await pool.probe(TOKEN, "user-1");
    expect(result).toMatchObject({ outcome: { status: 200, usage: { fiveHourPct: 12 } }, asked: true, warmSlots: 1 });
    expect(probed).toEqual(["pool-b"]);
    expect(dump()).toBe(before);

    // A failing slot too: one try, nothing written.
    answer = async () => {
      throw new Error(`boom ${TOKEN}`);
    };
    expect((await pool.probe(token(2), "user-2")).outcome).toEqual({ error: "error" });
    expect(probed).toEqual(["pool-b", "pool-b"]);
    expect(dump()).toBe(before);
    expect(logs.join("\n")).not.toContain(TOKEN);
  });

  it("spreads probes over the warm slots at random, never claiming", async () => {
    for (const id of ["pool-1", "pool-2", "pool-3"]) addSlot(id, "warm");
    const before = dump();
    for (let i = 0; i < 30; i += 1) await pool.probe(token(i), `user-${i}`);
    expect(new Set(probed).size).toBeGreaterThan(1);
    expect(dump()).toBe(before);
  });

  it("times out a slot that never answers", async () => {
    pool = makePool(20);
    addSlot("pool-a", "warm");
    answer = () => new Promise(() => {});
    expect(await pool.probe(TOKEN, "user-1")).toMatchObject({ outcome: { error: "timeout" }, asked: true });
  });

  it("limits each dashboard user to 5 probes per fixed 10-minute window, overwriting the window in place", async () => {
    addSlot("pool-a", "warm");
    for (let i = 0; i < PROBES_PER_USER; i += 1) expect((await pool.probe(token(i), "user-1")).outcome).toHaveProperty("status", 200);
    expect((await pool.probe(token(99), "user-1")).outcome).toEqual({ error: "rate_limited" });
    expect(probed).toHaveLength(PROBES_PER_USER);
    // A refused attempt is not charged: the count stays at the limit, and the refused token's fingerprint has no row.
    expect(countOf("user:user-1")).toBe(PROBES_PER_USER);
    expect(countOf(`fp:${await tokenFingerprint(token(99))}`)).toBe(0);
    // Another person is not limited by it.
    expect((await pool.probe(token(100), "user-2")).outcome).toHaveProperty("status", 200);
    const rows = () => [...sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM probe_counts")][0]!.n;
    const counted = rows();
    // The next window: allowed again, and the user's row overwritten, not added.
    now += PROBE_WINDOW_MS;
    expect((await pool.probe(token(101), "user-1")).outcome).toHaveProperty("status", 200);
    expect([...sql.exec("SELECT n FROM probe_counts WHERE key = 'user:user-1'")]).toEqual([{ n: 1 }]);
    expect(rows()).toBe(counted + 1); // only the new token's fingerprint row
  });

  it("limits each token to 3 probes per window, whoever sends it", async () => {
    addSlot("pool-a", "warm");
    for (let i = 0; i < PROBES_PER_TOKEN; i += 1) expect((await pool.probe(TOKEN, `user-${i}`)).outcome).toHaveProperty("status", 200);
    expect((await pool.probe(TOKEN, "user-9")).outcome).toEqual({ error: "rate_limited" });
    // Keyed by fingerprint, never the token.
    const keys = [...sql.exec<{ key: string }>("SELECT key FROM probe_counts")].map((row) => row.key);
    expect(keys).toContain(`fp:${await tokenFingerprint(TOKEN)}`);
    expect(keys.join(" ")).not.toContain(TOKEN);
    now += PROBE_WINDOW_MS;
    expect((await pool.probe(TOKEN, "user-9")).outcome).toHaveProperty("status", 200);
  });

  it("opens the breaker above 20 rejections and half the window's probes, and clears with the window", async () => {
    addSlot("pool-a", "warm");
    answer = async () => ({ status: 401 });
    // 20 rejections out of 20: not yet open (more than 20 are needed).
    for (let i = 0; i < 20; i += 1) await pool.probe(token(i), `user-${i}`);
    answer = async () => ({ status: 200 });
    for (let i = 20; i < 40; i += 1) await pool.probe(token(i), `user-${i}`);
    answer = async () => ({ status: 401 });
    // 21 of 41 rejected: above 20 and above half.
    expect((await pool.probe(token(40), "user-40")).outcome).toEqual({ status: 401 });
    const asked = probed.length;
    expect(await pool.probe(token(41), "user-41")).toMatchObject({ outcome: { error: "breaker" }, asked: false });
    expect(probed).toHaveLength(asked);
    expect(countOf("user:user-41")).toBe(0);
    now += PROBE_WINDOW_MS;
    answer = async () => ({ status: 200 });
    expect((await pool.probe(token(42), "user-42")).outcome).toHaveProperty("status", 200);
  });

  it("keeps the breaker shut while rejections are under half the probes", async () => {
    addSlot("pool-a", "warm");
    answer = async () => ({ status: 200 });
    for (let i = 0; i < 30; i += 1) await pool.probe(token(i), `user-${i}`);
    answer = async () => ({ status: 403 });
    for (let i = 30; i < 55; i += 1) await pool.probe(token(i), `user-${i}`);
    // 25 rejected of 55.
    expect((await pool.probe(token(60), "user-60")).outcome).toEqual({ status: 403 });
  });

  it("logs a gauge of warm slots whose host runs the model proxy on each alarm, and reports it with probes", async () => {
    addSlot("pool-a", "warm");
    addSlot("pool-b", "warm");
    addSlot("pool-c", "warm");
    status = { "pool-a": { proxy: true }, "pool-b": { proxy: false }, "pool-c": new Error("gone") };
    target = 3;
    const before = dump();
    await pool.refill();
    expect(dump()).toBe(before);
    expect(logs.map((line) => JSON.parse(line)).find((entry) => entry.event === "computer.pool_gauge")).toEqual({
      level: "info",
      event: "computer.pool_gauge",
      warm: 3,
      withProxy: 1,
      unknown: 1,
    });
    expect(await pool.probe(TOKEN, "user-1")).toMatchObject({ warmSlots: 3, slotsWithProxy: 1 });
  });
});
