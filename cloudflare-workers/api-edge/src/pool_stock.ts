// PoolStock — per-cell Durable Object holding pre-reserved hot pool boxes so
// default-shape sandbox creates are answered entirely at the edge (pop + mint
// token + 201) with zero origin round trips. The cell reserved these boxes for
// us (status='edge_reserved' in cell PG — invisible to the CP's own pool-claim
// path, so a box can never be handed to two customers).
//
// Lifecycle safety (see internal/api/edge_claim.go for the server half):
//   - Popped entries get a sandbox token minted by the edge → the box must
//     NEVER return to the pool (a live foreign token on a re-issued box would
//     be cross-tenant access). Popped boxes are finalized or marked failed.
//   - Entries the DO discards UNPOPPED (stale, overshoot) were never tokened →
//     released back to 'pooled' via /internal/pool/edge-release.
//   - If the DO dies without releasing, the cell's reaper destroys the
//     reservations after 15 min (destroy, not re-pool — it can't prove they
//     were never tokened).
//
// One instance per cell (idFromName(cellID)); the Worker picks the cell first
// (home-cell pinning etc.) and asks that cell's stock. All restock/release
// concurrency is contained here: the Worker only ever calls /claim.

interface StockEntry {
  id: string;
  workerID: string;
  cellID: string;
  baseURL: string;
  region: string;
  sandboxDomain: string;
  atMs: number;
}

interface PoolStockEnv {
  SESSION_JWT_SECRET: string;
}

// Stock tuning. TARGET_STOCK mirrors ~the whole per-cell hot pool so every
// default-shape create is answered at the edge, not just a small reserved slice.
// A self-scheduling alarm keeps the stock topped up to TARGET proactively (every
// ALARM_INTERVAL) so a burst always arrives against a full stock instead of the
// old lazy-on-claim path that left the stock empty between bursts. ENTRY_TTL
// stays well under the cell's 15-min destroy backstop so an unclaimed box is
// released back to the pool (cheap) long before the cell would destroy it.
const ENTRY_TTL_MS = 10 * 60_000;
// Sized for the ComputeSDK full battery (sequential 100 → staggered 100 @
// 200ms → burst 100, back-to-back ≈ 300 boxes): the stock must hold ≥100 at
// the moment burst fires, with the CP pool (OPENSANDBOX_POOL_TARGET × workers)
// and refill pacing sized to match.
const LOW_WATER = 100;
const RESTOCK_BATCH = 50; // max boxes reserved per single edge-reserve call
const TARGET_STOCK = 200; // fill the stock up to here (≈ the whole hot pool)
const ALARM_INTERVAL_MS = 10_000; // proactive top-up cadence
const RESTOCK_MAX_CALLS = 4; // reserve calls per restock pass (batch × calls ≥ TARGET)

// Synthetic org that owns parked pool boxes (db.PoolOrgID). Used as the cap
// token subject for reserve/release calls — those endpoints are org-agnostic,
// but the middleware wants a parseable org UUID.
const POOL_ORG_ID = "00000000-0000-4000-8000-000000000001";

const b64url = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

// Minimal cap-token mint for the DO's own cell calls (reserve/release).
// Duplicates index.ts's mintCapToken rather than importing it — the DO must
// not pull in the Worker's module graph (circular import, isolate bloat).
async function mintPoolCapToken(secret: string, cellID: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    sub: POOL_ORG_ID,
    iss: "opensandbox-edge",
    iat: now,
    exp: now + 120,
    org_id: POOL_ORG_ID,
    cell_id: cellID,
    plan: "free",
  };
  const signingInput =
    b64url(enc.encode(JSON.stringify(header))) + "." + b64url(enc.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(signingInput));
  return signingInput + "." + b64url(sig);
}

export class PoolStock {
  private stock: StockEntry[] = [];
  private restockInFlight = false;
  // One-shot colo self-identification (diagnostics): placement is sticky at
  // first-touch; a stock DO cross-colo from the claiming edge adds per-claim RTT.
  private coloLogged = false;
  // Last cell seen on a /claim, persisted so the proactive alarm can restock
  // without waiting for the next claim (a fresh DO after eviction still knows
  // which cell to reserve from).
  private cell: { cellID: string; baseURL: string } | null = null;

  constructor(
    private state: DurableObjectState,
    private env: PoolStockEnv,
  ) {
    this.state.blockConcurrencyWhile(async () => {
      this.stock = (await this.state.storage.get<StockEntry[]>("stock")) ?? [];
      this.cell = (await this.state.storage.get<{ cellID: string; baseURL: string }>("cell")) ?? null;
    });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/claim") {
      return this.claim(req);
    }
    if (req.method === "GET" && url.pathname === "/status") {
      return Response.json({ stock: this.stock.length, restocking: this.restockInFlight });
    }
    return new Response("not found", { status: 404 });
  }

  private async claim(req: Request): Promise<Response> {
    if (!this.coloLogged) {
      this.coloLogged = true;
      void fetch("https://www.cloudflare.com/cdn-cgi/trace")
        .then(async (r) => {
          const colo = ((await r.text()).match(/^colo=(\w+)/m) ?? [])[1] ?? "?";
          console.log(`pool-stock colo=${colo}`);
        })
        .catch(() => {});
    }
    let cell: { cellID: string; baseURL: string } | null = null;
    try {
      const body = (await req.json()) as { cell?: { cellID: string; baseURL: string } };
      cell = body.cell ?? null;
    } catch {
      /* no cell hint — claim still works, restock doesn't */
    }
    if (cell) this.rememberCell(cell);

    // Expire stale entries (never handed out → safe to release back to the
    // pool). Done inline, synchronously over the in-memory array, so a
    // concurrent claim can't double-pop across an await.
    const now = Date.now();
    const fresh: StockEntry[] = [];
    const stale: StockEntry[] = [];
    for (const e of this.stock) (now - e.atMs < ENTRY_TTL_MS ? fresh : stale).push(e);
    this.stock = fresh;
    if (stale.length > 0) {
      this.state.waitUntil(this.release(stale));
    }

    const entry = this.stock.shift(); // FIFO — oldest first keeps the stock young
    this.persist();

    // Ensure the proactive top-up loop is running, and kick an immediate restock
    // if this claim dropped us below the low-water mark (don't wait for the tick).
    this.state.waitUntil(this.ensureAlarm());
    if (cell && !this.restockInFlight && this.stock.length < LOW_WATER) {
      this.state.waitUntil(this.restockToTarget(cell));
    }

    if (!entry) {
      return new Response(JSON.stringify({ error: "stock empty" }), { status: 404 });
    }
    return Response.json(entry);
  }

  // rememberCell persists the cell coordinates so the alarm can restock even on
  // a fresh (post-eviction) DO instance that has never served a claim yet.
  private rememberCell(cell: { cellID: string; baseURL: string }): void {
    if (this.cell && this.cell.cellID === cell.cellID && this.cell.baseURL === cell.baseURL) return;
    this.cell = cell;
    void this.state.storage.put("cell", cell);
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
    }
  }

  // alarm — the proactive top-up. Fires on ALARM_INTERVAL_MS: refreshes stale
  // reservations and refills the stock to TARGET_STOCK so a create burst always
  // hits a full stock. Reschedules itself as long as we know which cell to
  // reserve from, so the stock stays warm without depending on claim traffic.
  async alarm(): Promise<void> {
    const cell = this.cell;
    if (!cell) return; // no cell known yet → nothing to reserve; a claim will arm it
    // Expire+release anything past TTL before topping up, so held boxes go back
    // to the pool well before the cell's 15-min destroy backstop.
    const now = Date.now();
    const fresh: StockEntry[] = [];
    const stale: StockEntry[] = [];
    for (const e of this.stock) (now - e.atMs < ENTRY_TTL_MS ? fresh : stale).push(e);
    this.stock = fresh;
    if (stale.length > 0) await this.release(stale);
    if (this.stock.length < TARGET_STOCK) await this.restockToTarget(cell);
    this.persist();
    // Keep the loop alive — stock stays full and fresh between bursts.
    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  private persist(): void {
    // allowUnconfirmed skips the output gate: the claim response leaves ~10ms
    // sooner instead of waiting for the write to be durable. Failure window
    // (DO crash after responding, before the write lands) resurrects a popped
    // entry → a later claim double-pops it → the second claim-finalize loses
    // the `edge_reserved` CAS and fails cleanly. Rare + already-handled, and
    // the claim hop is the entire cost of an edge create, so the ~10ms wins.
    void this.state.storage.put("stock", this.stock, { allowUnconfirmed: true });
  }

  // restockToTarget fills the stock up to TARGET_STOCK by issuing up to
  // RESTOCK_MAX_CALLS edge-reserve calls (each up to RESTOCK_BATCH boxes). It
  // stops early when the stock is full or the cell pool is drained (a reserve
  // returns fewer boxes than asked) so we don't hammer an empty pool.
  private async restockToTarget(cell: { cellID: string; baseURL: string }): Promise<void> {
    if (this.restockInFlight) return;
    this.restockInFlight = true;
    try {
      for (let call = 0; call < RESTOCK_MAX_CALLS; call++) {
        const want = Math.min(RESTOCK_BATCH, TARGET_STOCK - this.stock.length);
        if (want <= 0) return;
        const got = await this.reserveOnce(cell, want);
        if (got < want) return; // pool drained (or error) — don't spin
      }
    } finally {
      this.restockInFlight = false;
    }
  }

  // reserveOnce reserves up to `want` boxes from the cell pool and appends them
  // to the stock. Returns how many were actually added.
  private async reserveOnce(cell: { cellID: string; baseURL: string }, want: number): Promise<number> {
    try {
      const token = await mintPoolCapToken(this.env.SESSION_JWT_SECRET, cell.cellID);
      const r = await fetch(cell.baseURL.replace(/\/$/, "") + "/internal/pool/edge-reserve", {
        method: "POST",
        headers: { authorization: "Bearer " + token, "content-type": "application/json" },
        body: JSON.stringify({ count: want }),
      });
      if (!r.ok) {
        console.error(`pool-stock ${cell.cellID}: reserve failed ${r.status} ${await r.text()}`);
        return 0;
      }
      const data = (await r.json()) as {
        region: string;
        sandboxDomain: string;
        boxes: Array<{ sandboxID: string; workerID: string }>;
      };
      const now = Date.now();
      const have = new Set(this.stock.map((e) => e.id));
      let added = 0;
      for (const b of data.boxes) {
        if (have.has(b.sandboxID)) continue;
        this.stock.push({
          id: b.sandboxID,
          workerID: b.workerID,
          cellID: cell.cellID,
          baseURL: cell.baseURL,
          region: data.region,
          sandboxDomain: data.sandboxDomain,
          atMs: now,
        });
        added++;
      }
      this.persist();
      return added;
    } catch (e) {
      console.error(`pool-stock ${cell.cellID}: restock error:`, e);
      return 0;
    }
  }

  private async release(entries: StockEntry[]): Promise<void> {
    // Group by cell (entries could straddle a base_url change).
    const byCell = new Map<string, { cellID: string; ids: string[] }>();
    for (const e of entries) {
      const g = byCell.get(e.baseURL) ?? { cellID: e.cellID, ids: [] };
      g.ids.push(e.id);
      byCell.set(e.baseURL, g);
    }
    for (const [baseURL, g] of byCell) {
      try {
        const token = await mintPoolCapToken(this.env.SESSION_JWT_SECRET, g.cellID);
        await fetch(baseURL.replace(/\/$/, "") + "/internal/pool/edge-release", {
          method: "POST",
          headers: { authorization: "Bearer " + token, "content-type": "application/json" },
          body: JSON.stringify({ sandboxIDs: g.ids }),
        });
      } catch (e) {
        // Best-effort — the cell's stale-reservation reaper is the backstop.
        console.error(`pool-stock: release to ${baseURL} failed:`, e);
      }
    }
  }
}
