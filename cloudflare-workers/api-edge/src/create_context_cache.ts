// The create hot path's three D1 reads — org policy, running-sandbox count,
// active-cells list — and the colo-cache entries that keep them off D1.
//
// This module exists so those entries have exactly ONE definition. They are
// written from two places now: the create path itself (index.ts, on a miss) and
// the PoolStock alarm (pool_stock.ts, proactively). A second copy of the shapes
// or the TTLs in the DO would drift silently — the reader would just stop
// finding hits and quietly go back to paying D1, which is invisible in every
// signal except latency.
//
// Why anything writes them proactively: the colo tier only helps if something
// touched that colo recently. A burst-100 arrives on ~100 isolates at once,
// they all miss together, and single-flight cannot collapse across isolates —
// so a cold burst pays the full read on every request (measured: `ctx` 376ms
// median across all 100 on prod, where the D1 primary is in WNAM and creates
// run in IAD).
//
// Two writers, and the difference between them is which colo they can reach:
//
//   - keepCreateContextWarm, from the request path. Runs in the colo that will
//     serve the next request, so it is always the right one. Needs traffic.
//   - warmCreateContextColo, from the PoolStock alarm. Needs no traffic, but a
//     DO can only write the cache of the colo IT runs in — which is not
//     reliably the request's colo (measured on dev: shards in IAD/MIA, requests
//     served in SJC). Useful where a shard and the traffic do share a colo;
//     never something to rely on alone.
//
// Neither covers a genuinely cold colo — the first request after a long silence
// still pays the read. Only moving the data closer (D1 read replication in
// ENAM) removes that floor.

import { coloGet, coloPut } from "./colo_cache";

export interface CellRow {
  cell_id: string;
  cloud: string;
  region: string;
  base_url: string;
  status: string;
  available_workers: number;
  capacity_updated_at: number | null;
}

export interface OrgPolicy {
  home_cell: string;
  plan: string;
  is_halted: number;
  max_concurrent_sandboxes: number;
  max_disk_mb: number;
  billing_provider: string;
  // Which sandbox runtime this org's creates belong on. NULL/"" is the QEMU
  // fleet — so every org that predates this column keeps its current runtime
  // and opting one in is a single-row change.
  runtime: string | null;
}

// Freshness windows. The TTL is how long a value is used outright; the STALE
// window is how long it may still gate a create while a refresh runs behind it.
// 60s, not 5s. These three TTLs expire together, and D1.batch() is ONE round
// trip — so the moment the shortest of them lapses, the create pays the full
// read no matter how fresh the other two are. Measured under a burst-100 on
// dev: ctxd1 245ms for a 3-statement batch against ctxcolo 14ms, i.e. the tier
// that was supposed to absorb this was fast and EMPTY.
//
// Bounding is_halted staleness is still the job, and the stale-while-revalidate
// window below (60s) has always been the real bound on that — this only changes
// how long a value is used before a refresh is kicked off behind the response.
//
// WHY 60s AND NOT 15s. The three reads are single-flighted per isolate, so when
// the context has expired ONE request runs the D1 batch and every other request
// in the burst waits on it. That turns a single slow read into a fixed tax on
// the whole burst: measured on dev at `ctx` 496ms on 18 of 20 requests with
// `ctxn` = 3 on exactly one of them. It is what made burst-20 bimodal — 527ms
// when the context was cached, 1.28s when it had just expired, with a spread of
// only ~110ms INSIDE each run either way.
//
// The stale windows below (5 min) are what actually bound freshness; these
// values only decide when a background refresh starts.
export const ORG_POLICY_TTL_MS = 60_000;
// 5 min, a DELIBERATE trade made 2026-08-26. This window is the bound on halt
// latency: a stale-but-not-halted policy keeps gating creates while the refresh
// runs behind it, so an org halted mid-window can keep creating for up to this
// long. That was raised from 60s knowingly, in exchange for bursts never
// blocking on the org read. Shorten it if halt enforcement ever needs to be
// prompt again — it costs latency, not correctness.
export const ORG_STALE_MAX_MS = 300_000;
// 1.5s was deliberately shorter than a create→exec→destroy cycle, which meant
// it expired BETWEEN benchmark-shaped creates by construction — every sequential
// create dropped to the colo tier (or D1) for a number that had barely moved.
// 5s matches ORG_POLICY_TTL_MS, is still a small fraction of the 30s stale
// window the optimistic gate already relies on, and does not change the gate's
// semantics: this is how long a count is used OUTRIGHT, and the cap has always
// been approximate to ±CONCURRENCY_STALE_HEADROOM regardless.
export const CONCURRENCY_COUNT_TTL_MS = 60_000;
// Also 5 min, same trade. The cap has always been approximate to
// ±CONCURRENCY_STALE_HEADROOM; this widens the window in which a fast creator
// can overshoot it before the background refresh catches up.
export const CONCURRENCY_STALE_MAX_MS = 300_000;
export const CELL_TTL_MS = 60_000;
// See the isHealthy() interaction noted at the cells stale-serve branch in
// index.ts: reading capacity_updated_at from a ≤30s-stale snapshot stretches
// the effective 120s freshness window to ~150s, still ~5× the CP's ~30s
// capacity cadence.
export const CELL_STALE_MAX_MS = 300_000;

export const ORG_POLICY_SQL =
  "SELECT home_cell, plan, is_halted, max_concurrent_sandboxes, max_disk_mb, billing_provider, runtime FROM orgs WHERE id = ?1";
export const RUNNING_COUNT_SQL =
  "SELECT COUNT(*) AS n FROM sandboxes_index WHERE org_id = ?1 AND status = 'running'";
export const ACTIVE_CELLS_SQL =
  "SELECT cell_id, cloud, region, base_url, status, available_workers, capacity_updated_at FROM cells WHERE status = 'active'";

// How many recently-serving orgs one warm pass refreshes. The point is to cover
// whoever is actually creating through this shard, not the whole customer base:
// each org costs two statements in the batch, and an unbounded list would turn a
// 10s alarm into a scan of every org that ever touched this shard.
export const WARM_ORG_LIMIT = 4;

// Refresh threshold for the request-driven keep-warm below: act once an entry
// is past half its stale window, so it is replaced well before it can lapse
// rather than exactly as it does.
const REFRESH_AT_MS = CELL_STALE_MAX_MS / 2;

// One in-flight refresh per org per isolate. The whole point is to fire on
// ordinary traffic, and ordinary traffic is concurrent — without this a burst
// would kick one background batch per request.
const keepWarmInflight = new Map<string, Promise<void>>();

// keepCreateContextWarm refreshes this COLO's create-context entries off the
// back of any authenticated request for that org.
//
// This is the colo-correct half of the warming story, and it is why it does not
// live in the PoolStock alarm. A Durable Object can only write the Cache API of
// the colo IT runs in, which is not reliably the colo serving the request — dev
// shards sit in IAD/MIA while requests land in SJC, so a shard-driven warm is
// invisible to them. A request handler, by construction, runs in exactly the
// colo whose cache the next request will read.
//
// Every authenticated call counts, not just creates: exec, delete, and list all
// keep the create path warm for the same org, which is what carries an org
// through the gap between its last request and its next burst.
export function keepCreateContextWarm(
  db: D1Database | undefined,
  ctx: ExecutionContext | undefined,
  orgID: string,
): void {
  if (!db || !ctx || !orgID) return;
  if (keepWarmInflight.has(orgID)) return;
  const p = (async () => {
    try {
      const [org, count, cells] = await Promise.all([
        coloGet<{ cachedAtMs: number }>("org", orgID),
        coloGet<{ cachedAtMs: number }>("count", orgID),
        coloGet<{ cachedAtMs: number }>("cells", "active"),
      ]);
      const now = Date.now();
      const aging = (e: { cachedAtMs: number } | null) => e === null || now - e.cachedAtMs > REFRESH_AT_MS;
      if (!aging(org) && !aging(count) && !aging(cells)) return;
      await warmCreateContextColo(db, [orgID]);
    } catch {
      /* best-effort */
    } finally {
      keepWarmInflight.delete(orgID);
    }
  })();
  keepWarmInflight.set(orgID, p);
  ctx.waitUntil(p);
}

// warmCreateContextColo refreshes the colo entries the create path reads.
//
// Best-effort by construction: it runs off every hot path, and a failure just
// means the next create pays the read it would have paid anyway. It must never
// throw into the alarm, or a D1 blip would stop the stock top-up as collateral.
export async function warmCreateContextColo(db: D1Database, orgIDs: string[]): Promise<void> {
  try {
    const orgs = orgIDs.slice(0, WARM_ORG_LIMIT);
    const stmts: D1PreparedStatement[] = [db.prepare(ACTIVE_CELLS_SQL)];
    for (const id of orgs) {
      stmts.push(db.prepare(ORG_POLICY_SQL).bind(id));
      stmts.push(db.prepare(RUNNING_COUNT_SQL).bind(id));
    }
    // One round trip for everything: the whole reason this is worth doing from
    // a 10s alarm rather than N separate reads.
    const res = await db.batch(stmts);
    const at = Date.now();
    const puts: Promise<void>[] = [];

    const cells = (res[0]?.results as CellRow[] | undefined) ?? [];
    // Never publish an empty cells list. A blip that cached one would 503 every
    // create in this colo until it aged out — strictly worse than the stale
    // read this is meant to replace.
    if (cells.length > 0) {
      puts.push(coloPut("cells", "active", { cells, cachedAtMs: at }, CELL_STALE_MAX_MS / 1000));
    }

    for (let i = 0; i < orgs.length; i++) {
      const policy = (res[1 + i * 2]?.results?.[0] as OrgPolicy | undefined) ?? null;
      const n = (res[2 + i * 2]?.results?.[0] as { n: number } | undefined)?.n ?? 0;
      // A null policy is a real answer (org deleted), but publishing it from a
      // background pass would hand the create path a "no such org" it did not
      // ask for. Let the create path establish that itself.
      if (policy) {
        puts.push(coloPut("org", orgs[i], { policy, cachedAtMs: at }, ORG_STALE_MAX_MS / 1000));
      }
      puts.push(coloPut("count", orgs[i], { count: n, cachedAtMs: at }, CONCURRENCY_STALE_MAX_MS / 1000));
    }
    await Promise.all(puts);
  } catch {
    /* best-effort: the next create pays the read, exactly as it does today */
  }
}
