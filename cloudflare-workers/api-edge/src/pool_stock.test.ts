import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PoolStock } from "./pool_stock";

// ── fakes ───────────────────────────────────────────────────────────────────
class FakeStorage {
  map = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(k: string): Promise<T | undefined> {
    return this.map.get(k) as T | undefined;
  }
  async put(k: string, v: unknown): Promise<void> {
    this.map.set(k, v);
  }
  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }
  async setAlarm(t: number): Promise<void> {
    this.alarm = t;
  }
}

class FakeState {
  storage = new FakeStorage();
  pending: Promise<unknown>[] = [];
  async blockConcurrencyWhile<T>(cb: () => Promise<T>): Promise<T> {
    return cb();
  }
  waitUntil(p: Promise<unknown>): void {
    this.pending.push(p.catch(() => {}));
  }
  async settle(): Promise<void> {
    // Drain repeatedly: waitUntil work can itself schedule more waitUntil work.
    for (let i = 0; i < 5 && this.pending.length > 0; i++) {
      const batch = this.pending;
      this.pending = [];
      await Promise.all(batch);
    }
  }
}

const CELL = { cellID: "cell-a", baseURL: "https://cell-a.example" };
const ORG_A = "11111111-1111-4111-8111-111111111111";

interface ReserveBox {
  sandboxID: string;
  workerID: string;
}

/** Records every origin call the DO makes, and controls what edge-reserve returns. */
class FakeOrigin {
  reserved: ReserveBox[][] = [];
  releasedIDs: string[] = [];
  supply: ReserveBox[] = [];
  /** Control-plane process identity; changing it simulates a CP restart. */
  epoch = "epoch-1";
  handler = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.includes("/internal/pool/edge-reserve")) {
      const give = this.supply.splice(0, Number(body.count) || 0);
      this.reserved.push(give);
      return Response.json({
        region: "westus2",
        sandboxDomain: "sb.example",
        epoch: this.epoch,
        boxes: give,
      });
    }
    if (url.includes("/internal/pool/edge-release")) {
      this.releasedIDs.push(...(body.sandboxIDs as string[]));
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected origin call: ${url}`);
  };
}

function makeDO(origin: FakeOrigin, target = "4", lowWater = "1") {
  const state = new FakeState();
  const env = {
    SESSION_JWT_SECRET: "test-secret",
    POOL_STOCK_TARGET: target,
    POOL_STOCK_LOW_WATER: lowWater,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doInstance = new PoolStock(state as any, env as any);
  vi.stubGlobal("fetch", ((input: RequestInfo | URL, init?: RequestInit) =>
    origin.handler(String(input), init)) as typeof fetch);
  return { doInstance, state };
}

const post = (doInstance: PoolStock, path: string, body: unknown): Promise<Response> =>
  doInstance.fetch(new Request(`https://pool-stock${path}`, { method: "POST", body: JSON.stringify(body) }));

interface ClaimedBox {
  id: string;
  workerID: string;
  region: string;
  sandboxDomain: string;
  token: string;
}

async function claimBatch(
  doInstance: PoolStock,
  state: FakeState,
  orgID: string,
  count: number,
): Promise<{ boxes: ClaimedBox[]; stock: number }> {
  const r = await post(doInstance, "/claim-batch", { cell: CELL, orgID, count });
  const data = (await r.json()) as { boxes?: ClaimedBox[]; stock: number };
  await state.settle();
  return { boxes: data.boxes ?? [], stock: data.stock };
}

// ── tests ───────────────────────────────────────────────────────────────────
describe("PoolStock", () => {
  let origin: FakeOrigin;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T00:00:00Z"));
    origin = new FakeOrigin();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("hands a box out exactly once", async () => {
    origin.supply = [{ sandboxID: "sb-1", workerID: "w-1" }];
    const { doInstance, state } = makeDO(origin);

    await claimBatch(doInstance, state, ORG_A, 1); // primes the stock
    const first = await claimBatch(doInstance, state, ORG_A, 1);
    expect(first.boxes.map((b) => b.id)).toEqual(["sb-1"]);

    // A popped box is TOKENED. It must never reappear in stock — the header's
    // lifecycle invariant, and the reason the magazine's /return route is gone.
    const again = await claimBatch(doInstance, state, ORG_A, 1);
    expect(again.boxes).toEqual([]);
  });

  it("serves FIFO so the stock stays young", async () => {
    origin.supply = [
      { sandboxID: "sb-1", workerID: "w-1" },
      { sandboxID: "sb-2", workerID: "w-2" },
    ];
    const { doInstance, state } = makeDO(origin);
    await claimBatch(doInstance, state, ORG_A, 0); // prime

    // Oldest first: sb-1 was reserved before sb-2, so it is closer to the
    // cell's 15-min destroy backstop and has to go out first.
    expect((await claimBatch(doInstance, state, ORG_A, 1)).boxes.map((b) => b.id)).toEqual(["sb-1"]);
    expect((await claimBatch(doInstance, state, ORG_A, 1)).boxes.map((b) => b.id)).toEqual(["sb-2"]);
  });

  it("releases an unclaimed (never-tokened) box back to the pool", async () => {
    // Stock that expires without ever being popped was never tokened, so it is
    // cheap and safe to re-pool rather than leave to the cell's reaper.
    origin.supply = [{ sandboxID: "sb-1", workerID: "w-1" }];
    const { doInstance, state } = makeDO(origin);
    await claimBatch(doInstance, state, ORG_A, 0);

    vi.setSystemTime(Date.now() + 11 * 60_000);
    await doInstance.alarm();
    await state.settle();

    expect(origin.releasedIDs).toEqual(["sb-1"]);
  });

  it("drops stock minted by a control plane that has since restarted", async () => {
    // The MicroVM backend binds a sandbox id to a box IN MEMORY at reserve, so a
    // CP restart invalidates every id this DO is holding. Without the fence the
    // shard keeps serving them for the full ENTRY_TTL: each one 201s a create
    // for a box with no manager binding, and the customer's first exec 500s.
    origin.supply = [{ sandboxID: "sb-old", workerID: "w-1" }];
    const { doInstance, state } = makeDO(origin);
    await claimBatch(doInstance, state, ORG_A, 0); // stock sb-old under epoch-1

    origin.epoch = "epoch-2"; // control plane restarted
    origin.supply = [{ sandboxID: "sb-new", workerID: "w-2" }];
    await doInstance.alarm(); // proactive top-up notices the new epoch
    await state.settle();

    const served = await claimBatch(doInstance, state, ORG_A, 5);
    expect(served.boxes.map((b) => b.id)).toEqual(["sb-new"]);
  });

  it("keeps stock when the cell sends no epoch at all", async () => {
    // A Postgres-backed cell reserves by flipping a row, so its reservations
    // survive a restart and it sends no epoch. The fence must not fire there.
    origin.supply = [{ sandboxID: "sb-1", workerID: "w-1" }];
    const { doInstance, state } = makeDO(origin);
    origin.handler = async (url: string, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (url.includes("/internal/pool/edge-reserve")) {
        const give = origin.supply.splice(0, Number(body.count) || 0);
        return Response.json({ region: "westus2", sandboxDomain: "sb.example", boxes: give });
      }
      origin.releasedIDs.push(...(body.sandboxIDs as string[]));
      return Response.json({ ok: true });
    };
    await claimBatch(doInstance, state, ORG_A, 0);
    await doInstance.alarm();
    await state.settle();

    expect((await claimBatch(doInstance, state, ORG_A, 1)).boxes.map((b) => b.id)).toEqual(["sb-1"]);
  });

  it("exposes no route that can re-stock an already-tokened box", async () => {
    // Regression guard. /return existed to un-strand the isolate-local
    // magazine's surplus; with the magazine deleted there is no surplus, and a
    // route that puts a tokened box back in stock is a cross-tenant hazard with
    // no remaining caller. Deleting the magazine is what retires the hazard.
    const { doInstance, state } = makeDO(origin);
    await claimBatch(doInstance, state, ORG_A, 0);

    const r = await post(doInstance, "/return", {
      orgID: ORG_A,
      boxes: [{ id: "sb-1", workerID: "w-1", region: "westus2", sandboxDomain: "sb.example" }],
    });
    expect(r.status).not.toBe(200);
  });
});
