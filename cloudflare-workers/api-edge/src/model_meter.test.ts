import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the OR + Autumn clients so we test the meter's debit/cap/halt logic in isolation.
vi.mock("./openrouter", () => ({ getOrKey: vi.fn(), patchOrKey: vi.fn() }));
vi.mock("./autumn_webhook", () => ({
  getAutumnCustomer: vi.fn(),
  trackAutumnUsage: vi.fn(async () => 1),
  projectOrg: vi.fn(async () => {}),
}));

import { getOrKey, patchOrKey } from "./openrouter";
import { getAutumnCustomer, trackAutumnUsage, projectOrg } from "./autumn_webhook";
import { runModelMeter, type ModelMeterEnv } from "./model_meter";
import type { ManagedModelKeyRow } from "./model_billing";

const gOrKey = getOrKey as unknown as ReturnType<typeof vi.fn>;
const gPatch = patchOrKey as unknown as ReturnType<typeof vi.fn>;
const gCust = getAutumnCustomer as unknown as ReturnType<typeof vi.fn>;
const gTrack = trackAutumnUsage as unknown as ReturnType<typeof vi.fn>;
const gProject = projectOrg as unknown as ReturnType<typeof vi.fn>;

// ── in-memory D1 for orgs + managed_model_keys ──────────────────────────────
class FakeDb {
  orgs = new Map<string, { id: string; model_markup_bps: number }>();
  keys: ManagedModelKeyRow[] = [];
  prepare(sql: string) {
    return new Stmt(this, sql);
  }
}
class Stmt {
  private args: unknown[] = [];
  constructor(private db: FakeDb, private sql: string) {}
  bind(...a: unknown[]) {
    this.args = a;
    return this;
  }
  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM orgs")) return (this.db.orgs.get(this.args[0] as string) ?? null) as T | null;
    return null;
  }
  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM managed_model_keys")) {
      return { results: this.db.keys.filter((k) => ["active", "superseded", "deleting"].includes(k.status) && k.or_key_hash) as T[] };
    }
    return { results: [] };
  }
  async run(): Promise<void> {
    const s = this.sql;
    if (s.includes("SET pending_from_micro")) {
      const [from, to, idem, id] = this.args as [number, number, string, string];
      const r = this.db.keys.find((k) => k.id === id);
      if (r) { r.pending_from_micro = from; r.pending_to_micro = to; r.pending_idem = idem; }
      return;
    }
    if (s.includes("SET committed_micro")) {
      const [committed, id] = this.args as [number, string];
      const r = this.db.keys.find((k) => k.id === id);
      if (r) { r.committed_micro = committed; r.pending_from_micro = null; r.pending_to_micro = null; r.pending_idem = null; }
      return;
    }
    throw new Error("unhandled run: " + s);
  }
}

function key(over: Partial<ManagedModelKeyRow> = {}): ManagedModelKeyRow {
  return {
    id: "mmk_1", org_id: "org1", or_key_hash: "hash1", managed_credential_id: "cred1", operation_id: "op1",
    status: "active", committed_micro: 0, pending_from_micro: null, pending_to_micro: null, pending_idem: null,
    attempts: 0, last_error: null, created_at: 1, superseded_at: null, ...over,
  };
}
function env(db: FakeDb): ModelMeterEnv {
  return { OPENCOMPUTER_DB: db as unknown as D1Database, OPENROUTER_PROVISIONING_KEY: "k", AUTUMN_SECRET_KEY: "a", CF_ADMIN_SECRET: "c", EVENT_SECRET: "e", AUTUMN_WEBHOOK_SECRET: "w" } as ModelMeterEnv;
}
function orKey(usage: number, limit: number | null = 1000) {
  return { hash: "hash1", name: "n", disabled: false, limit, limit_remaining: null, limit_reset: null, usage };
}

beforeEach(() => {
  gOrKey.mockReset();
  gPatch.mockReset().mockResolvedValue(undefined); // returns a promise so `.catch` is safe
  gCust.mockReset();
  gTrack.mockReset().mockResolvedValue(1);
  gProject.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.clearAllMocks());

describe("model_meter debit (persist-before-track, §7)", () => {
  it("debits new spend: persists interval, tracks micro-credits, advances watermark", async () => {
    const db = new FakeDb();
    db.orgs.set("org1", { id: "org1", model_markup_bps: 0 });
    db.keys.push(key({ committed_micro: 0 }));
    gOrKey.mockResolvedValue(orKey(0.5)); // $0.50 cumulative
    gCust.mockResolvedValue({ id: "org1", balances: { credits: { remaining: 10 } } });

    await runModelMeter(env(db), 0);

    expect(gTrack).toHaveBeenCalledTimes(1);
    expect(gTrack.mock.calls[0][1]).toMatchObject({ customerID: "org1", featureID: "model_spend", value: 500000, idempotencyKey: "model_spend:org1:0:500000" });
    expect(db.keys[0].committed_micro).toBe(500000);
    expect(db.keys[0].pending_idem).toBeNull(); // cleared after success
  });

  it("applies markup to the debit value", async () => {
    const db = new FakeDb();
    db.orgs.set("org1", { id: "org1", model_markup_bps: 2000 }); // +20%
    db.keys.push(key({ committed_micro: 0 }));
    gOrKey.mockResolvedValue(orKey(0.5));
    gCust.mockResolvedValue({ id: "org1", balances: { credits: { remaining: 10 } } });

    await runModelMeter(env(db), 0);
    expect(gTrack.mock.calls[0][1].value).toBe(600000); // round(500000 * 1.2)
  });

  it("retries a pending interval VERBATIM after a crash (never recompute against newer usage)", async () => {
    const db = new FakeDb();
    db.orgs.set("org1", { id: "org1", model_markup_bps: 0 });
    // crashed mid-debit: pending [0,500000] persisted; OR usage has since grown to $1.
    db.keys.push(key({ committed_micro: 0, pending_from_micro: 0, pending_to_micro: 500000, pending_idem: "model_spend:org1:0:500000" }));
    gOrKey.mockResolvedValue(orKey(1.0)); // now $1.00
    gCust.mockResolvedValue({ id: "org1", balances: { credits: { remaining: 10 } } });

    await runModelMeter(env(db), 0);
    // MUST re-send the original interval/key (500000), NOT the widened 1000000.
    expect(gTrack.mock.calls[0][1]).toMatchObject({ value: 500000, idempotencyKey: "model_spend:org1:0:500000" });
    expect(db.keys[0].committed_micro).toBe(500000); // advances to the pending `to`, not 1000000
  });

  it("no track when usage hasn't advanced past the watermark", async () => {
    const db = new FakeDb();
    db.orgs.set("org1", { id: "org1", model_markup_bps: 0 });
    db.keys.push(key({ committed_micro: 500000 }));
    gOrKey.mockResolvedValue(orKey(0.5)); // == committed
    gCust.mockResolvedValue({ id: "org1", balances: { credits: { remaining: 10 } } });

    await runModelMeter(env(db), 0);
    expect(gTrack).not.toHaveBeenCalled();
  });
});

describe("model_meter cap + halt (§5.4/§7)", () => {
  it("active-key cap = usage + remaining/(1+markup)", async () => {
    const db = new FakeDb();
    db.orgs.set("org1", { id: "org1", model_markup_bps: 0 });
    db.keys.push(key({ committed_micro: 500000 }));
    gOrKey.mockResolvedValue(orKey(0.5, 1)); // usage 0.5, limit 1
    gCust.mockResolvedValue({ id: "org1", balances: { credits: { remaining: 10 } } });

    await runModelMeter(env(db), 0);
    const patch = gPatch.mock.calls.find((c) => c[1] === "hash1") ?? gPatch.mock.calls[0];
    expect(patch[2].limitUsd).toBeCloseTo(10.5, 5); // 0.5 + 10/1
  });

  it("rotation: superseded key frozen at usage+ε, active gets the rest", async () => {
    const db = new FakeDb();
    db.orgs.set("org1", { id: "org1", model_markup_bps: 0 });
    db.keys.push(key({ id: "mmk_old", or_key_hash: "old", status: "superseded", committed_micro: 2000000 }));
    db.keys.push(key({ id: "mmk_new", or_key_hash: "new", status: "active", committed_micro: 1000000 }));
    gOrKey.mockImplementation(async (_e: unknown, h: string) => (h === "old" ? orKey(2.0, 5) : orKey(1.0, 5)));
    gCust.mockResolvedValue({ id: "org1", balances: { credits: { remaining: 10 } } });

    await runModelMeter(env(db), 0);
    const caps = Object.fromEntries(gPatch.mock.calls.map((c) => [c[1], c[2].limitUsd]));
    expect(caps["old"]).toBeCloseTo(2.01, 5); // usage + ε
    expect(caps["new"]).toBeCloseTo(1 + 10 - 0.01, 5); // active_usage + remaining - Σε
  });

  it("halts the org when balance ≤ 0", async () => {
    const db = new FakeDb();
    db.orgs.set("org1", { id: "org1", model_markup_bps: 0 });
    db.keys.push(key({ committed_micro: 500000 }));
    gOrKey.mockResolvedValue(orKey(0.5));
    gCust.mockResolvedValue({ id: "org1", balances: { credits: { remaining: 0 } } });

    await runModelMeter(env(db), 0);
    expect(gProject).toHaveBeenCalledWith(expect.anything(), "org1");
  });
});
