import { beforeEach, describe, expect, it } from "vitest";

import type { AdoptedComputer, LifecycleReply } from "../src/computer/lifecycle.js";
import { isPoolId, newPoolId, ownerTag } from "../src/computer/names.js";
import { ComputerPool, MAX_PROVISIONING, PROVISION_TIMEOUT_MS, REFILL_INTERVAL_MS, poolSize } from "../src/computer/pool.js";
import { sqlStorage } from "./fixtures/computer-sql.js";

/** A slot's ComputerDurableObject, in memory: started computers become ready when the test says so. */
interface FakeSlot {
  state: string | null;
  connected: boolean;
  retired: boolean;
  releasedTo?: string;
}

let slots: Map<string, FakeSlot>;
let target: number;
let now: number;
let alarms: number[];
let startReply: LifecycleReply;
let pool: ComputerPool;

beforeEach(() => {
  slots = new Map();
  target = 3;
  now = 1_000_000;
  alarms = [];
  startReply = { status: 202 };
  pool = new ComputerPool({
    sql: sqlStorage(),
    target: () => target,
    now: () => now,
    setAlarm: async (at) => void alarms.push(at),
    slot: (poolId) => ({
      async start() {
        if (startReply.status < 400) slots.set(poolId, { state: "provisioning", connected: false, retired: false });
        return startReply;
      },
      async status() {
        const slot = slots.get(poolId);
        return { state: slot?.state ?? null, connected: slot?.connected ?? false };
      },
      async release(organizationId): Promise<AdoptedComputer | null> {
        // Another event may run here: the pool must already have marked the slot.
        await new Promise((resolve) => setTimeout(resolve, 5));
        const slot = slots.get(poolId);
        if (!slot || slot.state !== "ready" || !slot.connected) return null;
        slot.state = "transferred";
        slot.releasedTo = organizationId;
        return { prefix: `oc-${poolId}`, size: "Standard_D2as_v7", diskGiB: 128, zone: "1", sshPublicKey: "k", poolSlot: poolId };
      },
      async retire() {
        const slot = slots.get(poolId);
        if (slot) Object.assign(slot, { retired: true, state: "deleting" });
      },
      async probe() {
        return { error: "not_ready" };
      },
    }),
  });
});

/** Every started computer boots and its host connects. */
async function bootAll() {
  for (const [poolId, slot] of slots) {
    if (slot.state !== "provisioning") continue;
    Object.assign(slot, { state: "ready", connected: true });
    await pool.connected(poolId);
  }
}

const states = () => pool.slots().map((slot) => slot.state).sort();

describe("warm pool", () => {
  it("reads COMPUTER_POOL_SIZE: absent, zero or malformed is no pool", () => {
    expect(poolSize(undefined)).toBe(0);
    expect(poolSize("0")).toBe(0);
    expect(poolSize("-3")).toBe(0);
    expect(poolSize("two")).toBe(0);
    expect(poolSize("2.5")).toBe(0);
    expect(poolSize("25")).toBe(25);
    expect(poolSize("100000")).toBe(200);
  });

  it("names pool slots as computers that belong to no organization", () => {
    const id = newPoolId();
    expect(isPoolId(id)).toBe(true);
    expect(id).toMatch(/^pool-[a-z0-9]{12}$/);
    expect(isPoolId("org_pool-abc123")).toBe(false);
    expect(isPoolId("pool-")).toBe(false);
    expect(ownerTag(id)).toBe("pool");
    expect(ownerTag("org_01HXYZ")).toBe("org_01HXYZ");
  });

  it("refills to the target, a few at a time, and keeps looking", async () => {
    target = 5;
    expect(await pool.refill()).toBe(now + REFILL_INTERVAL_MS);
    expect(states()).toEqual(Array(MAX_PROVISIONING).fill("provisioning"));
    expect(pool.slots().every((slot) => isPoolId(slot.poolId) && slot.prefix === `oc-${slot.poolId}`)).toBe(true);
    // Nothing more while three are still provisioning.
    await pool.refill();
    expect(pool.slots()).toHaveLength(3);
    await bootAll();
    expect(states()).toEqual(["warm", "warm", "warm"]);
    await pool.refill();
    expect(states()).toEqual(["provisioning", "provisioning", "warm", "warm", "warm"]);
    await bootAll();
    await pool.refill();
    expect(states()).toEqual(Array(5).fill("warm"));
    expect(slots.size).toBe(5);
  });

  it("marks a slot warm when the alarm finds its host connected, even if the hello notice was lost", async () => {
    target = 1;
    await pool.refill();
    const [poolId] = [...slots.keys()];
    Object.assign(slots.get(poolId!)!, { state: "ready", connected: true });
    await pool.refill();
    expect(states()).toEqual(["warm"]);
  });

  it("retires slots that failed or never connected, and warm ones above a lowered target", async () => {
    target = 2;
    await pool.refill();
    const [failed, slow] = [...slots.keys()];
    slots.get(failed!)!.state = "failed";
    await pool.refill();
    expect(slots.get(failed!)!.retired).toBe(true);
    expect(pool.slots().map((slot) => slot.poolId)).not.toContain(failed);
    now += PROVISION_TIMEOUT_MS + 1;
    slots.get(slow!)!.state = "ready";
    await pool.refill();
    expect(slots.get(slow!)!.retired).toBe(true);

    await bootAll();
    await pool.refill();
    await bootAll();
    expect(states()).toEqual(["warm", "warm"]);
    target = 0;
    expect(await pool.refill()).toBeNull();
    expect(pool.slots()).toEqual([]);
    expect([...slots.values()].filter((slot) => !slot.retired)).toEqual([]);
  });

  it("starts nothing while computers are not configured", async () => {
    startReply = { status: 503, error: "computers are not configured: missing AZURE_CLIENT_ID" };
    expect(await pool.refill()).toBe(now + REFILL_INTERVAL_MS);
    expect(pool.slots()).toEqual([]);
  });

  it("claims a warm slot atomically: two concurrent claims get different computers", async () => {
    target = 2;
    await pool.refill();
    await bootAll();
    const [a, b] = await Promise.all([pool.claim("org_a"), pool.claim("org_b")]);
    expect(a?.poolId).toBeDefined();
    expect(b?.poolId).toBeDefined();
    expect(a!.poolId).not.toBe(b!.poolId);
    expect(a).toMatchObject({ prefix: `oc-${a!.poolId}`, size: "Standard_D2as_v7", diskGiB: 128, poolSlot: a!.poolId });
    expect(slots.get(a!.poolId)!.releasedTo).toBe("org_a");
    expect(slots.get(b!.poolId)!.releasedTo).toBe("org_b");
    expect(pool.slots().map((slot) => [slot.state, slot.claimedBy]).sort()).toEqual([
      ["claimed", "org_a"],
      ["claimed", "org_b"],
    ]);
    // A claim kicks a refill.
    expect(alarms.at(-1)).toBe(now);
    await pool.refill();
    expect(states()).toEqual(["claimed", "claimed", "provisioning", "provisioning"]);
  });

  it("answers null when no slot is warm, and skips a warm slot whose host went away", async () => {
    expect(await pool.claim("org_a")).toBeNull();
    target = 2;
    await pool.refill();
    expect(await pool.claim("org_a")).toBeNull();
    await bootAll();
    const [first, second] = pool.slots();
    slots.get(first!.poolId)!.connected = false;
    const claim = await pool.claim("org_a");
    expect(claim?.poolId).toBe(second!.poolId);
    expect(pool.slots().find((slot) => slot.poolId === first!.poolId)).toMatchObject({ state: "provisioning", claimedBy: null });
    expect(await pool.claim("org_b")).toBeNull();
  });
});
