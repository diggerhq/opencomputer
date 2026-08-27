// Client for the in-region voucher cache (cmd/voucher-cache).
//
// This is tier 0 of the create fast path. It replaces the colo voucher book for
// the case the book was worst at: a cold or evicted book cost 1498ms at
// burst-100, because the create that discovered the loss had to rebuild it from
// the control plane in westus2. The cache cannot go cold in that sense — it is a
// process in us-east-1 holding stock in RAM, refilled on a timer by the control
// plane, and it answers a pop in ~13ms p50 measured from the IAD colo.
//
// Three things this module must never do, each learned the expensive way:
//
//   NEVER BLOCK A CREATE ON DISCOVERY. Peer discovery rides on pop responses,
//   so the steady state costs zero extra requests. Only an isolate that has
//   never popped asks the control plane, and it asks once.
//
//   NEVER TREAT A POP AS OWNERSHIP. A voucher is a hint that a box is probably
//   free; the guest CAS decides. That is what lets a pop be a single
//   unreplicated in-memory operation.
//
//   NEVER THROW. Every failure here is a fall-through to the colo book and then
//   to the control-plane create, both of which are slower and correct.

import { coloGet, coloPut } from "./colo_cache";

export interface CachePeer {
  endpoint: string;
  token: string;
  // The guest AGENT port. The AWS proxy forwards only to the port declared in
  // the image hook config, so the cache shares the agent's listener rather than
  // opening its own — a second port answers "403 Access to port denied".
  port: number;
  retireAtUnix?: number;
}

export interface CachedVoucher {
  microvmID: string;
  endpoint: string;
  token: string;
  port: number;
  expiresAtUnix: number;
}

// Isolate-local view of the instance set. Survives as long as the isolate does,
// which under load is many creates.
let peers: CachePeer[] = [];
// Single-flight for the cold discovery fetch, so 100 concurrent creates on a
// fresh isolate make one control-plane call rather than 100 — the same stampede
// that made a cold colo book cost 1498ms.
let discovering: Promise<void> | null = null;
let discoveredAt = 0;

// How long a failed discovery is remembered, so a cell with no cache configured
// does not pay a control-plane round trip on every create.
const DISCOVERY_BACKOFF_MS = 30_000;

// Colo-cache key for the peer list, and how long it lives there.
//
// Isolate memory alone is not enough. Measured on dev: a create landing on a
// cold isolate spent ~400ms in popVoucher, essentially all of it asking the
// control plane in westus2 where the cache instances are. With ~15-21 isolates
// serving a burst of 100, that is the cold-start cost the whole design exists
// to remove, reintroduced one layer up.
//
// The peer list is the RIGHT shape for the colo cache, unlike the voucher book
// that used to live there: it is a handful of bytes, it is read-only, it is
// identical for every isolate, and it changes once per rotation rather than
// once per create. Eviction costs one control-plane call, not a book rebuild.
// TTL is short relative to MaxLifetime so a retired instance ages out well
// before it is terminated.
const PEERS_KEY = "vcpeers";
// Peers change only when the fleet rotates (~8h), so a short TTL buys nothing
// and costs a lot: when this entry expires, EVERY isolate in the colo goes cold
// at once, and a burst arriving in that window misses the cache entirely —
// measured vpop=0 across all 100 creates of a burst that ran 7 minutes after
// the entry was written. Stale peers are cheap (a dead one is dropped on its
// first bad pop); an expired entry is not.
const PEERS_TTL_SEC = 3600;
// A same-colo read; if it is slower than this something is wrong and the book
// is the better answer.
const COLO_PEERS_TIMEOUT_MS = 50;

// How many instances one create may try. Two: enough to ride out a single
// instance that is retiring or momentarily empty, without turning a miss into a
// long serial walk on a customer's create.
const MAX_TRIES = 2;

// A pop is a local operation on a warm in-region process. If it has not
// answered in this long, something is wrong with the box, not the request, and
// waiting longer only makes the create worse than the fallback it could have
// taken.
const POP_TIMEOUT_MS = 400;

/** Test seam: forget the isolate's view of the fleet. */
export function _resetCacheClientState(): void {
  peers = [];
  discovering = null;
  discoveredAt = 0;
}

/** Test seam: seed the peer list without a discovery round trip. */
export function _setPeersForTest(p: CachePeer[]): void {
  peers = p;
}

function orderPeers(list: CachePeer[]): CachePeer[] {
  // Prefer the instance that lives longest. During a rotation both are healthy
  // but one is minutes from termination, and sending creates to it means a
  // steady trickle of pops that fail exactly when it goes away.
  return [...list].sort((a, b) => (b.retireAtUnix ?? 0) - (a.retireAtUnix ?? 0));
}

// The cheap half of discovery: what this colo already knows. Bounded so a slow
// cache read can never become the thing that delays a create.
async function peersFromColo(): Promise<boolean> {
  try {
    const cached = await withTimeout(
      coloGet<CachePeer[]>(PEERS_KEY, "list"),
      COLO_PEERS_TIMEOUT_MS,
    );
    if (Array.isArray(cached) && cached.length > 0) {
      peers = orderPeers(cached);
      return true;
    }
  } catch {
    /* fall through to the colo book */
  }
  return false;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((res) => setTimeout(() => res(null), ms)),
  ]);
}

// The expensive half: ask the control plane. Never awaited on a create — this
// runs in waitUntil so exactly one cold isolate pays for it and every isolate
// after it reads the colo entry instead.
async function discoverFromCell(cellBaseURL: string, mintToken: () => Promise<string>): Promise<void> {
  if (discovering) return discovering;
  if (peers.length === 0 && Date.now() - discoveredAt < DISCOVERY_BACKOFF_MS) return;
  discovering = (async () => {
    try {
      // Re-check the colo: another isolate may have landed it while we queued.
      if (await peersFromColo()) return;
      const token = await mintToken();
      const r = await fetch(`${cellBaseURL}/internal/pool/cache-peers`, {
        headers: { authorization: "Bearer " + token },
      });
      if (r.ok) {
        const body = (await r.json()) as { peers?: CachePeer[] };
        if (Array.isArray(body.peers) && body.peers.length > 0) {
          peers = orderPeers(body.peers);
          // Pay this once per colo, not once per cold isolate.
          await coloPut(PEERS_KEY, "list", peers, PEERS_TTL_SEC);
        }
      }
    } catch {
      /* fall through to the colo book */
    } finally {
      discoveredAt = Date.now();
      discovering = null;
    }
  })();
  return discovering;
}

export interface Pop {
  voucher: CachedVoucher;
  /** Wall time of the pop that won, ms. */
  ms: number;
  /** How many instances were tried. 1 means uncontended. */
  tries: number;
  /** Peer discovery, ms. 0 once this isolate knows the fleet. */
  discMs: number;
}

/**
 * popVoucher takes one voucher from the in-region cache, or returns null so the
 * caller falls through to the colo book.
 *
 * Null is a completely ordinary answer: no cache configured, every instance
 * empty, or a rotation in progress.
 */
export async function popVoucher(
  cellBaseURL: string,
  secret: string,
  mintToken: () => Promise<string>,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<Pop | null> {
  const t0 = Date.now();
  // An isolate that does not yet know the fleet does NOT wait to find out.
  //
  // Measured on dev at burst-100: awaiting discovery here cost 336ms at p50 and
  // pushed TTI to 1091ms. Single-flight does not help, because the flight is
  // per-isolate: ~15-21 isolates cold-start together, all miss the colo entry
  // before any of them has written it, and all call the control plane in
  // westus2 at once. That is the same stampede shape the colo book needed a
  // refill lease for.
  //
  // So discovery is kicked off in the background and this create falls through
  // to the book, which is exactly what it is for. The cost is bounded and
  // self-correcting: the first creates in a cold colo take the old path, the
  // discovery lands in the colo cache, and every isolate after that pops.
  let discMs = 0;
  if (peers.length === 0) {
    // Two sources, two very different costs, and conflating them is what made
    // this tier dead under burst.
    //
    // The colo entry is a same-colo read (single-digit ms) that some earlier
    // isolate already paid for, so it is worth awaiting. The control plane is a
    // cross-cloud subrequest, and awaiting THAT is what cost 336ms p50 and
    // 1091ms TTI: single-flight is per-isolate, so ~15-21 isolates cold-start
    // together and all call the control plane at once.
    //
    // Measured burst-100 with both folded into the background path: vpop=0 on
    // every create. A burst is almost entirely cold isolates, so "the first few
    // creates take the old path" silently became "every create takes the old
    // path" — the cache never engaged in the one case it exists for.
    const d0 = Date.now();
    const warmed = await peersFromColo();
    discMs = Date.now() - d0;
    if (!warmed) {
      waitUntil(discoverFromCell(cellBaseURL, mintToken));
      return null;
    }
  }

  const candidates = orderPeers(peers).slice(0, MAX_TRIES);
  let tries = 0;
  for (const p of candidates) {
    tries++;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), POP_TIMEOUT_MS);
      let r: Response;
      try {
        r = await fetch(`https://${p.endpoint}/osb/cache/pop`, {
          method: "POST",
          headers: {
            "X-aws-proxy-auth": p.token,
            "X-aws-proxy-port": String(p.port),
            "X-osb-cache-auth": secret,
          },
          signal: ctl.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (r.status === 204) {
        // Stocked out. Said out loud because it is otherwise invisible: the
        // create still succeeds on the fallback, so the only symptom is a
        // latency regression with no error attached to it.
        console.log(`voucher-cache EMPTY ${p.endpoint} — falling through`);
        continue;
      }
      if (!r.ok) {
        // A 502 from the AWS proxy means the box is gone; a 503 means the
        // instance is filling. Either way this peer is not usable right now,
        // and leaving it at the head of the list would make every create pay
        // to rediscover that.
        console.log(`voucher-cache BAD ${p.endpoint} status=${r.status}`);
        peers = peers.filter((x) => x.endpoint !== p.endpoint);
        continue;
      }

      const body = (await r.json()) as { voucher?: CachedVoucher; peers?: CachePeer[] };
      // Rotation rides here. The control plane adds the replacement to the peer
      // list before retiring the incumbent, so ordinary create traffic moves the
      // edge across without anyone asking where to go.
      if (Array.isArray(body.peers) && body.peers.length > 0) {
        const next = orderPeers(body.peers);
        // Only write when the set actually changed. A put per create would be
        // pure overhead on the hot path; a put per rotation is what we want.
        if (JSON.stringify(next) !== JSON.stringify(peers)) {
          peers = next;
          void coloPut(PEERS_KEY, "list", next, PEERS_TTL_SEC).catch(() => {});
        }
      }
      if (!body.voucher || !body.voucher.microvmID || !body.voucher.endpoint) continue;
      return { voucher: body.voucher, ms: Date.now() - t0, tries, discMs };
    } catch {
      // Timeout or transport failure. Drop it and try the next.
      peers = peers.filter((x) => x.endpoint !== p.endpoint);
    }
  }
  return null;
}

/**
 * releaseVoucher hands a voucher back, for the narrow case where the edge drew
 * one and then failed BEFORE any claim was attempted.
 *
 * Deliberately not called when a claim loses its CAS: that box is live under
 * another sandbox, and returning it would hand a running box to a second
 * customer. Only the box knows which case it is, so the edge releases only on
 * its own local failures.
 */
export async function releaseVoucher(v: CachedVoucher, secret: string): Promise<void> {
  const p = orderPeers(peers)[0];
  if (!p) return;
  try {
    await fetch(`https://${p.endpoint}/osb/cache/release`, {
      method: "POST",
      headers: {
        "X-aws-proxy-auth": p.token,
        "X-aws-proxy-port": String(p.port),
        "X-osb-cache-auth": secret,
        "content-type": "application/json",
      },
      body: JSON.stringify(v),
    });
  } catch {
    /* the cell's reconciler settles anything we fail to return */
  }
}
