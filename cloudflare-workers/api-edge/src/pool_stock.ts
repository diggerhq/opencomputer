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
  // MicroVM reach-info, when the cell supplies it. Present means exec can go
  // straight from the edge to the box's agent; absent means this cell routes
  // through a worker and exec uses the control-plane path.
  endpoint?: string;
  token?: string;
  port?: number;
}

interface PoolStockEnv {
  SESSION_JWT_SECRET: string;
  // Per-shard stock sizing, overridable per environment (wrangler.toml [vars]).
  // Defaults below are the prod values; dev sets these DOWN because its cell
  // holds ~30 boxes total, an order of magnitude under the 8×38 fleet target —
  // see the sizing invariant in the block comment below.
  POOL_STOCK_TARGET?: string;
  POOL_STOCK_LOW_WATER?: string;
  // VmSession DOs are pre-woken here at stock-prep (see reserveOnce) instead of
  // on the create hot path — a burst-100 otherwise fires ~100 prewake
  // subrequests from the create isolate, saturating its subrequest budget.
  // Optional so the binding can be absent mid-cutover (prewake just skips).
  VM_SESSIONS?: DurableObjectNamespace;
  // MicroVM exec data plane. Warmed here at stock-prep for the same reason
  // VM_SESSIONS is: doing it on the create path would fan out a subrequest per
  // box from the create isolate, and — more importantly — would lose the race
  // against the customer's first exec.
  MICROVM_SESSIONS?: DurableObjectNamespace;
}

// Stock tuning. TARGET_STOCK mirrors ~the whole per-cell hot pool so every
// default-shape create is answered at the edge, not just a small reserved slice.
// A self-scheduling alarm keeps the stock topped up to TARGET proactively (every
// ALARM_INTERVAL) so a burst always arrives against a full stock instead of the
// old lazy-on-claim path that left the stock empty between bursts. ENTRY_TTL
// stays well under the cell's 15-min destroy backstop so an unclaimed box is
// released back to the pool (cheap) long before the cell would destroy it.
const ENTRY_TTL_MS = 10 * 60_000;
// SHARDED: a Durable Object processes requests ~serially (~2ms/claim), so one
// stock DO serializes a burst — measured claim;dur 12ms solo → 47ms at 50-way,
// ~90ms projected at 100-way. The edge spreads claims across POOL_STOCK_SHARDS
// (index.ts) DO instances; 8 shards cuts the 100-way queue tail to ~25ms, and
// past ~8 the alarm/restock machinery and shard-empty retries outgrow the gain.
// Sizing below is PER SHARD; fleet stock = SHARDS × TARGET_STOCK = 304 — deep
// enough that a sustained ~300-create drain (sequential or 100-way burst) is
// served entirely from seasoned stock, never from mid-drain refill manufacture
// (freshly-restored boxes are the p99 tail).
//
// SIZING INVARIANT: SHARDS × TARGET_STOCK must be ≤ the cell's actual pool
// (OPENSANDBOX_POOL_TARGET × workers). If it exceeds the pool, every shard
// permanently believes it is below LOW_WATER, restocks on every claim, and the
// shards compete for a supply that can never satisfy them — boxes concentrate
// in whichever shards win, creates that hash to an empty shard fall through to
// the ~10× slower CP path, and the measured burst latency becomes a function of
// shard luck rather than of the system under test. Dev hit exactly this (30-box
// cell against a 304 target), which is why these are env-overridable.
const DEFAULT_LOW_WATER = 18;
const DEFAULT_TARGET_STOCK = 38; // per-shard fill level (× 8 shards = 304 fleet)
const ALARM_INTERVAL_MS = 10_000; // proactive top-up cadence
const RESTOCK_MAX_CALLS = 2; // reserve calls per restock pass (batch × calls ≥ TARGET)
// Self-decommission: a shard that hasn't served a claim in this long releases
// its whole stock and stops its alarm (a later claim re-arms it). This is what
// lets a retired shard GENERATION (index.ts POOL_STOCK_SHARD_GEN bump — e.g.
// after a placement mistake) drain instead of hoarding reservations forever,
// and returns idle cells' boxes to the pool for non-default-shape creates.
const IDLE_DECOMMISSION_MS = 30 * 60_000;

// Synthetic org that owns parked pool boxes (db.PoolOrgID). Used as the cap
// token subject for reserve/release calls — those endpoints are org-agnostic,
// but the middleware wants a parseable org UUID.
const POOL_ORG_ID = "00000000-0000-4000-8000-000000000001";

// Parse a positive integer from a wrangler [vars] string, falling back to the
// prod default when unset/blank/garbage — a bad var must never zero the stock.
function intFromEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const b64url = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

// Minimal cap-token mint for the DO's own cell calls (reserve/release).
// Duplicates index.ts's mintCapToken rather than importing it — the DO must
// not pull in the Worker's module graph (circular import, isolate bloat).
// Cached HMAC key for sandbox-token minting (see mintSandboxTokenDO).
let doSignKey: Promise<CryptoKey> | null = null;
function doHmacKey(secret: string): Promise<CryptoKey> {
  if (!doSignKey) {
    doSignKey = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  }
  return doSignKey;
}

// The JWT header is constant — encode it once per isolate instead of
// JSON.stringify + base64 on every mint.
const JWT_HEADER_B64 = b64url(new TextEncoder().encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));

// mintSandboxTokenDO mints the customer-facing sandbox token INSIDE this DO, so
// a batch claim returns ready-to-serve tokens and the create isolate performs no
// HMAC at all. Byte-identical to index.ts's mintSandboxToken (same secret, same
// claims) — the create path just hands this through. Duplicated rather than
// imported: the DO must not pull in the Worker's module graph.
async function mintSandboxTokenDO(
  secret: string,
  orgID: string,
  sandboxID: string,
  workerID: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const payload = {
    sub: orgID,
    iat: now,
    exp: now + 24 * 3600,
    iss: "opensandbox",
    org_id: orgID,
    sandbox_id: sandboxID,
    worker_id: workerID,
  };
  const signingInput = JWT_HEADER_B64 + "." + b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await doHmacKey(secret), enc.encode(signingInput));
  return signingInput + "." + b64url(sig);
}

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
  private lastClaimMs = 0;
  // One-shot colo self-identification (diagnostics): placement is sticky at
  // first-touch; a stock DO cross-colo from the claiming edge adds per-claim RTT.
  private coloLogged = false;
  // Resolved once per isolate alongside coloLogged; reported on every claim so
  // the create path can see whether its stock DO is even in the same colo.
  private colo = "?";
  // Last cell seen on a /claim, persisted so the proactive alarm can restock
  // without waiting for the next claim (a fresh DO after eviction still knows
  // which cell to reserve from).
  private cell: { cellID: string; baseURL: string } | null = null;
  // The control-plane process that issued the stock we are holding, when that
  // cell's reservations are process-local (see edge_claim.go processEpoch).
  // Persisted alongside the stock because it is only meaningful paired with it.
  private epoch: string | null = null;
  // Resolved once per isolate from env (see the sizing invariant above).
  private readonly targetStock: number;
  private readonly lowWater: number;
  private readonly restockBatch: number;

  constructor(
    private state: DurableObjectState,
    private env: PoolStockEnv,
  ) {
    this.targetStock = intFromEnv(env.POOL_STOCK_TARGET, DEFAULT_TARGET_STOCK);
    // Low-water must stay under target or a restock is triggered on every claim.
    this.lowWater = Math.min(
      this.targetStock - 1,
      intFromEnv(env.POOL_STOCK_LOW_WATER, DEFAULT_LOW_WATER),
    );
    // One reserve call per restock pass was sized to cover the whole target
    // (batch × RESTOCK_MAX_CALLS ≥ target); keep that relationship as target moves.
    this.restockBatch = this.targetStock;
    this.state.blockConcurrencyWhile(async () => {
      this.stock = (await this.state.storage.get<StockEntry[]>("stock")) ?? [];
      this.cell = (await this.state.storage.get<{ cellID: string; baseURL: string }>("cell")) ?? null;
      this.epoch = (await this.state.storage.get<string>("epoch")) ?? null;
    });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "POST" && url.pathname === "/claim") {
      return this.claim(req);
    }
    if (req.method === "POST" && url.pathname === "/claim-batch") {
      return this.claimBatch(req);
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

    // FIFO — oldest first keeps the stock young.
    const entry = this.stock.shift();
    this.lastClaimMs = Date.now();
    void this.state.storage.put("lastClaim", this.lastClaimMs, { allowUnconfirmed: true });
    this.persist();

    // Ensure the proactive top-up loop is running, and kick an immediate restock
    // if this claim dropped us below the low-water mark (don't wait for the tick).
    this.state.waitUntil(this.ensureAlarm());
    if (cell && !this.restockInFlight && this.stock.length < this.lowWater) {
      this.state.waitUntil(this.restockToTarget(cell));
    }

    if (!entry) {
      return new Response(JSON.stringify({ error: "stock empty" }), { status: 404 });
    }
    // `stock` = entries left in this shard after the pop (telemetry #7): lets the
    // create path surface shard depletion via Server-Timing.
    return Response.json({ ...entry, stock: this.stock.length });
  }

  // claimBatch pops up to `count` entries in ONE call and returns them with
  // their sandbox tokens already minted. This is the magazine refill (see
  // index.ts): instead of a burst doing one DO subrequest + one HMAC per create
  // on the saturated create isolate, one call serves ~N creates from isolate
  // memory with zero further subrequests and zero edge crypto. Popped entries
  // are TOKENED, so — exactly like /claim — they must never return to the pool;
  // an isolate that dies holding them leaves them to the cell's reaper.
  private async claimBatch(req: Request): Promise<Response> {
    // Split the create path's `claim;dur` into DO work vs the network to get
    // here. Both halves have completely different fixes — token minting and
    // stock bookkeeping are ours to cut, cross-colo RTT is a placement problem —
    // and from the edge they are indistinguishable.
    const tDo = Date.now();
    if (!this.coloLogged) {
      this.coloLogged = true;
      void fetch("https://www.cloudflare.com/cdn-cgi/trace")
        .then(async (r) => {
          this.colo = ((await r.text()).match(/^colo=(\w+)/m) ?? [])[1] ?? "?";
          console.log(`pool-stock colo=${this.colo}`);
        })
        .catch(() => {});
    }
    let cell: { cellID: string; baseURL: string } | null = null;
    let orgID = "";
    let count = 1;
    try {
      const body = (await req.json()) as {
        cell?: { cellID: string; baseURL: string };
        orgID?: string;
        count?: number;
      };
      cell = body.cell ?? null;
      orgID = typeof body.orgID === "string" ? body.orgID : "";
      count = Math.max(1, Math.min(Number(body.count) || 1, this.targetStock));
    } catch {
      /* fall through with defaults */
    }
    if (!orgID) return new Response(JSON.stringify({ error: "orgID required" }), { status: 400 });
    if (cell) this.rememberCell(cell);

    // Same inline stale-expiry as claim(), synchronous over the in-memory array
    // so a concurrent claim can't double-pop across an await.
    const now = Date.now();
    const fresh: StockEntry[] = [];
    const stale: StockEntry[] = [];
    for (const e of this.stock) (now - e.atMs < ENTRY_TTL_MS ? fresh : stale).push(e);
    this.stock = fresh;
    if (stale.length > 0) this.state.waitUntil(this.release(stale));

    // FIFO — oldest first keeps the stock young.
    const entries = this.stock.splice(0, count);
    this.lastClaimMs = Date.now();
    void this.state.storage.put("lastClaim", this.lastClaimMs, { allowUnconfirmed: true });
    this.persist();

    this.state.waitUntil(this.ensureAlarm());
    if (cell && !this.restockInFlight && this.stock.length < this.lowWater) {
      this.state.waitUntil(this.restockToTarget(cell));
    }

    // Mint every token here (one isolate, N signs) rather than N times on the
    // create isolate. Parallel — crypto.subtle.sign is async.
    const boxes = await Promise.all(
      entries.map(async (e) => ({
        id: e.id,
        workerID: e.workerID,
        region: e.region,
        sandboxDomain: e.sandboxDomain,
        token: await mintSandboxTokenDO(this.env.SESSION_JWT_SECRET, orgID, e.id, e.workerID),
        // How to reach the box's agent directly. Named apart from `token` above,
        // which is the CUSTOMER's sandbox token — these are the AWS proxy's
        // port-scoped credential and are never handed to a customer.
        //
        // Carried out with the box so the create isolate can cache them
        // colo-locally: that is what lets a later exec dial the agent itself
        // instead of asking the control plane in westus2 for reach-info it has
        // already been told once. Absent for backends with no in-memory stock.
        agentEndpoint: e.endpoint,
        agentToken: e.token,
        agentPort: e.port,
      })),
    );
    return Response.json({ boxes, stock: this.stock.length, t: Date.now() - tDo, colo: this.colo });
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
    // Idle self-decommission (see IDLE_DECOMMISSION_MS): release everything and
    // let the alarm lapse. A future claim re-arms and restocks.
    const lastClaim = this.lastClaimMs || ((await this.state.storage.get<number>("lastClaim")) ?? 0);
    if (Date.now() - lastClaim > IDLE_DECOMMISSION_MS) {
      if (this.stock.length > 0) {
        const all = this.stock.splice(0);
        await this.release(all);
        this.persist();
      }
      return; // no reschedule — decommissioned until the next claim
    }
    // Expire+release anything past TTL before topping up, so held boxes go back
    // to the pool well before the cell's 15-min destroy backstop.
    const now = Date.now();
    const fresh: StockEntry[] = [];
    const stale: StockEntry[] = [];
    for (const e of this.stock) (now - e.atMs < ENTRY_TTL_MS ? fresh : stale).push(e);
    this.stock = fresh;
    if (stale.length > 0) await this.release(stale);
    // Surplus trim: release anything above the per-shard target back to the
    // pool. This is how the pre-sharding legacy DO (which becomes shard 0 and
    // held the whole fleet's stock) sheds down to TARGET_STOCK so the other
    // shards can reserve those boxes; it also self-heals any future oversizing.
    if (this.stock.length > this.targetStock) {
      const surplus = this.stock.splice(this.targetStock);
      await this.release(surplus);
    }
    if (this.stock.length < this.targetStock) await this.restockToTarget(cell);
    this.persist();
    // NOTE: deliberately NO periodic re-prewake of sitting stock here. Warming
    // every entry each tick costs 8 shards × TARGET_STOCK DO pokes every
    // ALARM_INTERVAL — sustained background load on the vm-do worker plus
    // waitUntil work competing with this DO's own claim serving — and prod
    // measurement showed the burst gate is edge-isolate admission, not DO
    // coldness (exec held ~48ms with 100% VM-DO). Fresh boxes are warmed once in
    // reserveOnce; a box that re-hibernates while it sits wakes on the host dial
    // or first exec, as it always did.
    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL_MS);
  }

  // prewakeBox wakes one box's VmSession DO isolate (best-effort, off any hot
  // path). Called from reserveOnce when a box enters the stock.
  private prewakeBox(sandboxID: string): void {
    const vs = this.env.VM_SESSIONS;
    if (!vs) return;
    this.state.waitUntil(
      vs.get(vs.idFromName(sandboxID)).fetch("https://do/status").then(() => {}).catch(() => {}),
    );
  }

  // warmMicrovmBox hands a box's reach-info to its MicrovmSession DO and has it
  // open the agent tunnel, best-effort and off every hot path.
  //
  // Doing this at stock-prep rather than at create is the whole point. The
  // WebSocket 101 comes from the AWS proxy, which only connects to the guest
  // port when payload first arrives — so the ~1.1s cost of actually reaching the
  // agent lands on whoever sends first. Warming at create loses that race (the
  // customer's exec arrives one RTT after the 201), and warming lazily on first
  // exec IS the race. Here there is no race: the box sits in stock for minutes.
  private warmMicrovmBox(b: { sandboxID: string; endpoint?: string; token?: string; port?: number }): void {
    const ns = this.env.MICROVM_SESSIONS;
    if (!ns || !b.endpoint || !b.token || !b.port) return;
    this.state.waitUntil(
      ns
        .get(ns.idFromName(b.sandboxID), { locationHint: "enam" })
        .fetch("https://do/attach", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: b.endpoint, token: b.token, port: b.port, dial: true }),
        })
        .then(() => {})
        .catch(() => {}),
    );
  }

  // coolMicrovmBox drops a DO's channel when its box leaves this stock without
  // ever reaching a customer.
  //
  // Not just tidiness: the box goes back to anonymous pool stock and will be
  // reissued under a DIFFERENT sandbox id, so a DO still holding a live tunnel
  // under the OLD id is a channel into a box that now belongs to someone else.
  // The id stops resolving in D1, which is the real guard, but leaving an armed
  // channel behind it is not a thing to rely on.
  private coolMicrovmBox(sandboxID: string): void {
    const ns = this.env.MICROVM_SESSIONS;
    if (!ns) return;
    this.state.waitUntil(
      ns
        .get(ns.idFromName(sandboxID), { locationHint: "enam" })
        .fetch("https://do/detach", { method: "POST" })
        .then(() => {})
        .catch(() => {}),
    );
  }

  private persist(): void {
    // allowUnconfirmed skips the output gate: the claim response leaves ~10ms
    // sooner instead of waiting for the write to be durable. Failure window
    // (DO crash after responding, before the write lands) resurrects a popped
    // entry → a later claim double-pops it → the second claim-finalize loses
    // the `edge_reserved` CAS and fails cleanly. Rare + already-handled, and
    // the claim hop is the entire cost of an edge create, so the ~10ms wins.
    void this.state.storage.put("stock", this.stock, { allowUnconfirmed: true });
    void this.state.storage.put("epoch", this.epoch, { allowUnconfirmed: true });
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
        const want = Math.min(this.restockBatch, this.targetStock - this.stock.length);
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
        epoch?: string;
        // endpoint/token/port are present only for cells whose backend can be
        // reached directly (MicroVM); worker-backed cells omit them.
        boxes: Array<{ sandboxID: string; workerID: string; endpoint?: string; token?: string; port?: number }>;
      };
      // Epoch fence. A cell that stamps an epoch is telling us its edge
      // reservations live in that process's memory, not in Postgres — so when
      // the value changes, every id we are holding was minted by a control
      // plane that no longer exists. Those boxes have no manager binding: a
      // create served from them 201s and the customer's first exec 500s,
      // because routing goes through a sandbox→box map that died with the
      // process. Drop the lot rather than serve one.
      //
      // Not released back to the pool — the new process has no record of these
      // ids, so an edge-release would be a no-op round trip. The cell's own
      // reaper owns the boxes now.
      //
      // Absent epoch = a Postgres-backed cell, whose reservations are rows and
      // survive a restart. No fence, and no behaviour change for those cells.
      if (data.epoch && this.epoch && data.epoch !== this.epoch && this.stock.length > 0) {
        console.log(
          `pool-stock ${cell.cellID}: control-plane epoch changed (${this.epoch} → ${data.epoch}) — dropping ${this.stock.length} stale entr(ies)`,
        );
        this.stock = [];
      }
      if (data.epoch) this.epoch = data.epoch;
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
          endpoint: b.endpoint,
          token: b.token,
          port: b.port,
        });
        added++;
        // Open and guest-attach this box's agent tunnel NOW, while it is still
        // stock and nobody is waiting on it.
        this.warmMicrovmBox(b);
        // Pre-wake the box's VmSession DO now (stock-prep), off any hot path, so
        // the create burst doesn't fan out ~100 prewake subrequests from the
        // create isolate. The alarm (prewakeStock) keeps it warm while it sits.
        this.prewakeBox(b.sandboxID);
      }
      this.persist();
      return added;
    } catch (e) {
      console.error(`pool-stock ${cell.cellID}: restock error:`, e);
      return 0;
    }
  }

  private async release(entries: StockEntry[]): Promise<void> {
    // Tear down any agent tunnel first — this box is about to be reissued under
    // a different sandbox id. See coolMicrovmBox.
    for (const e of entries) if (e.endpoint) this.coolMicrovmBox(e.id);
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
