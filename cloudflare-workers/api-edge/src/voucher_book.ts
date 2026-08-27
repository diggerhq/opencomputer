// The voucher book: how a create answers without calling anyone.
//
// MEASURED PROBLEM. At burst-100 a create spent 310ms in the edge→control-plane
// call while the CP's own handler took 75 MICROSECONDS and swallowed the whole
// burst inside 30ms. The time is not work — it is this isolate waiting to be
// scheduled. A Worker invocation may hold only six open connections, and every
// subrequest and every waitUntil consumes one. Sequentially the same call is
// 67ms; the extra ~243ms is a uniform toll paid per request under concurrency
// (flat across arrival deciles, so contention, not a queue draining).
//
// So the goal is not a faster call. It is ZERO calls. A create reads this book
// out of the colo-shared Cache API — which is not a subrequest — picks a
// voucher, and returns.
//
// WHY THIS SUCCEEDS WHERE TWO PREDECESSORS FAILED.
//
//   PoolStock (Durable Object). The pop was a subrequest on the hot path — the
//   exact 310ms term. Everything else about it (sticky placement, now on shard
//   generation g5; the SHARDS x TARGET_STOCK sizing invariant; epoch fencing)
//   was work spent making a coordination point behave, when the coordination
//   point was itself the cost.
//
//   Per-isolate hint maps. Module state is per-ISOLATE, and a burst fragments
//   across isolates that cannot see each other, so hints missed almost always.
//   This book lives in caches.default, shared by every isolate in the colo.
//
// THE INVARIANT THAT MAKES IT SAFE: the edge holds hints, never ownership. A
// voucher confers nothing. Two isolates may draw the same one; the box settles
// it with an idempotent compare-and-swap (cmd/microvm-hooks/claim.go) and the
// loser retries against the next voucher. Staleness, eviction and duplication
// all degrade to a retry — never to a double-owned box.

import { coloAvailable, coloDelete, coloGet, coloPut } from "./colo_cache";

export interface Voucher {
  // A voucher names a BOX. It deliberately does not carry a sandbox ID.
  //
  // It used to, and that was the defect that made burst unusable. A book of N
  // served a burst of B>N, so by pigeonhole several creates drew the SAME
  // voucher — and with the sandbox ID inside it, that meant handing the same
  // sandbox ID to different customers. Nothing downstream could catch it: the
  // guest CAS saw one ID claiming its box twice and correctly reported an
  // idempotent replay.
  //
  // With the ID minted per create at the edge, a duplicate draw becomes two
  // DIFFERENT sandboxes racing for one box, which is exactly the case the CAS
  // exists to settle: one wins, the loser gets 409 and takes the next voucher.
  // That is the difference between a hint and a promise.
  microvmID: string;
  endpoint: string;
  token: string;
  port: number;
  expiresAtUnix: number;
}

interface Book {
  vouchers: Voucher[];
  // Stamped by us on write, so an isolate can tell one book from the next
  // without comparing contents.
  fetchedAtMs: number;
}

// How long a book may serve.
//
// Sized so the book SURVIVES IDLE. At 45s it did not: a burst arriving ten
// minutes after the last create found nothing, so all 100 creates missed at
// once, fell through to the control plane together, and produced 5.1s of D1
// contention and 35 rate-limit 503s — TTI p50 8.7s, worse than not having this
// path at all (measured 2026-08-26). The failure mode of an empty book is not
// "slightly slower", it is a stampede, so the book must effectively always be
// warm.
//
// Stays well under the CP's voucherTTL (60 min) so a voucher cannot be handed
// out after it has been reclaimed.
const BOOK_TTL_SEC = 1800;

// Books are kept in a two-deep rotation, current and previous.
//
// Not for redundancy — for RESOLUTION. A create draws from `cur`, but the first
// exec usually lands on a different isolate and possibly after a refill, and it
// must still be able to turn its sandbox ID back into a box. Keeping the
// outgoing book resolvable is what lets create write no route entry at all,
// which is one fewer waitUntil connection on the hot path.
// Bumped to abandon every book in every colo at once.
//
// Needed because a book OUTLIVES THE CELL THAT WROTE IT. A control-plane restart
// terminates its warm set and comes back with entirely new boxes, but the edge's
// book is a 30-minute colo-cache entry that knows nothing about that — so every
// create for the next half hour draws a voucher naming a box that no longer
// exists. Measured: 100/100 creates answered from a pre-restart book, 100
// finalizes lost, 11/100 execs. purgeBooks below makes this self-heal; this
// constant is the manual escape hatch when it has not yet.
const BOOK_GEN = "g4";
const CUR = "vbookcur" + BOOK_GEN;
const PREV = "vbookprev" + BOOK_GEN;

// THE BINDING — sandbox id -> box, written by the create that minted the id.
//
// This cannot be built at refill time any more: the sandbox ID does not exist
// until a create invents it, so only the create knows the pairing. That costs
// one colo-cache write on the create path — not a subrequest, and it rides the
// waitUntil budget the route seed already spends.
//
// It replaces a sharded index keyed by a control-plane-minted sandbox ID. That
// index worked, but only because the ID was pre-paired — the same pre-pairing
// that made duplicate draws unsafe. Writing the binding here is what lets the
// voucher be a hint rather than a promise.
//
// Lives as long as a voucher can (~ the cell's voucherTTL): a sandbox must stay
// resolvable for as long as it can plausibly run a command, which has nothing to
// do with how fast the book turns over.
// ── free list ────────────────────────────────────────────────────────────────
//
// The book says which boxes exist. The FREE LIST says which are still unclaimed,
// and it is what actually makes a draw safe.
//
// One entry per voucher, keyed by box. Drawing a box means DELETING its entry,
// and Cache API delete reports whether this caller was the one that removed it.
// That boolean is a single-winner primitive across every isolate in the colo:
// measured 2026-08-26 at 100 concurrent deletes per armed key, 30 rounds, 1640
// requests — exactly one `true` every time, with a 20ms settle after the put.
//
// This is the piece the design was missing. Without it, ~50 isolates read one
// shared book and pick independently, so a burst of B into a book of n collides
// at about B^2/2n — 42 expected at B=100, n=120, and 37 observed. No hashing or
// cursor discipline can fix that: it is the pigeonhole principle, and the only
// escapes are partitioning supply (which STARVES at a 150-box pool, since total
// outstanding vouchers can never exceed the pool — the same invariant that broke
// PoolStock) or coordinating. The free list coordinates, and costs no subrequest.
//
// A lost claim is now discovered in ~1ms here instead of by an ~80ms round trip
// to the box, which is what makes contention affordable at a load factor of 0.8.
// The guest CAS remains the authority; this only stops us racing toward it.
// ── refill lease ─────────────────────────────────────────────────────────────
//
// Exactly one isolate in a colo may pull a book per window.
//
// `refilling` below is single-flight PER ISOLATE, which is no protection at all
// when the book is missing: a burst arrives on ~100 cold isolates, each finds no
// book, and each issues its own pull. The cell serves them in order, so the first
// takes ~95% of the pool and every other pull returns ZERO — leaving 99 creates
// with no book to draw from, all falling through to the control plane at once.
// Measured 2026-08-27 against a purged book: create p50 2874.9ms, 75/100,
// `vstock=0` on every create and `cell=2437ms`. The bounded cold-wait cannot
// help, because the supply is already gone by the time the waiters look.
//
// So the pull is gated on winning a lease, using the same delete-wins primitive
// the free list uses (see FREE). The winner pulls and re-arms; the losers wait
// for the book it writes, which is what they wanted anyway.
const LEASE = "vlease";

// One pull per colo per window. Short enough that a genuinely needed refresh is
// not held off for long, long enough to cover a slow pull.
const REFILL_WINDOW_SEC = 5;

// How long a loser waits for the winner's book.
//
// Sized against what giving up COSTS, which is the thing the first version got
// wrong. A loser that falls through takes the control-plane path, and under a
// cold-book burst that path measured ~2600ms — so quitting after 400ms to go do
// something six times slower is never right. Worse, the quitters are what makes
// the control plane slow, which delays the very pull they were waiting on.
//
// The flat timeout is only the ceiling. The loop below also watches for the pull
// DYING: `releaseLease` deletes the lease on a failed pull, so no lease and no
// book means nobody is coming and the loser should leave immediately rather than
// serve out its budget.
const LEASE_WAIT_MS = 1800;
const LEASE_POLL_MS = 25;

// claimLease returns true for an isolate that may pull.
//
// A cooldown entry, not a token handed back and forth: the entry's PRESENCE
// means "someone pulled recently, don't". Handing a token back after each pull
// does not work — the next isolate takes it immediately and the stampede is
// unchanged, which is what the first version of this did.
//
// The check and the write are not atomic, so a few isolates arriving inside the
// write's own latency can both win. That is a bounded race — a handful rather
// than the hundred this exists to prevent — and the cost of losing it is one
// extra pull, not a broken book.
async function claimLease(): Promise<boolean> {
  if (!coloAvailable()) return true;
  if (await coloGet<unknown>(LEASE, BOOK_GEN)) return false;
  await coloPut(LEASE, BOOK_GEN, { at: Date.now() }, REFILL_WINDOW_SEC);
  return true;
}

// releaseLease reopens the window immediately, for a pull that produced nothing.
// Holding the colo off for the full window after a dud would leave every create
// on the control-plane path for no reason.
async function releaseLease(): Promise<void> {
  // DELETE, not a short-TTL write. The check is `coloGet(...)` truthy, and any
  // object written here — even {at:0} — reads as "held", so re-putting would
  // keep the colo blocked rather than reopening it.
  await coloDelete(LEASE, BOOK_GEN).catch(() => {});
}

const FREE = "vfree";

// Entries live as long as the promise behind them, so a box is drawable for its
// whole voucher TTL. An entry that evicts early only makes its box undrawable —
// the cell re-pools it via ReconcileVouchers. Safe direction.
const FREE_TTL_MIN_SEC = 60;
const FREE_TTL_MAX_SEC = 3600;

function freeTTL(v: Voucher, nowSec: number): number {
  const left = v.expiresAtUnix - nowSec;
  return Math.max(FREE_TTL_MIN_SEC, Math.min(FREE_TTL_MAX_SEC, left));
}

// publishFree lists boxes as claimable. Only ever called for vouchers the cell
// just handed us: re-publishing one that was already drawn would resurrect a box
// a customer is using.
async function publishFree(vouchers: Voucher[]): Promise<void> {
  const nowSec = Math.floor(Date.now() / 1000);
  const CHUNK = 32;
  for (let i = 0; i < vouchers.length; i += CHUNK) {
    await Promise.all(
      vouchers.slice(i, i + CHUNK).map((v) => coloPut(FREE, v.microvmID, { m: v.microvmID }, freeTTL(v, nowSec))),
    );
  }
}

// claimFree returns true when THIS caller took the box.
//
// With no colo cache (vitest, local tooling) there is no free list to arbitrate,
// so claiming always succeeds and the cursor discipline below is what bounds a
// draw — exactly the behaviour these tests were written against.
// Boxes this isolate has already seen taken. A lost claim is PERMANENT — the
// box now belongs to whoever won it — so re-probing one is a ~13ms colo round
// trip that can only fail again.
//
// Without this an isolate walks the same claimed entries on every subsequent
// draw: measured at burst-100, `vclaim` p95 was 11 probes and `vcas` p95 144ms,
// i.e. the tail of a draw was almost entirely re-discovering losses it had
// already discovered.
const takenLocal = new Set<string>();
const TAKEN_MAX_LOCAL = 20_000;

async function claimFree(microvmID: string): Promise<boolean> {
  if (!coloAvailable()) return true;
  if (takenLocal.has(microvmID)) return false;
  const won = await coloDelete(FREE, microvmID);
  // Either way this box is spent: lost to another isolate, or claimed by us.
  // Both make it unclaimable, so both are worth remembering — a box we won
  // ourselves would otherwise cost a wasted probe on our very next draw.
  if (takenLocal.size >= TAKEN_MAX_LOCAL) takenLocal.clear();
  takenLocal.add(microvmID);
  return won;
}

const BIND = "vbind";
const BIND_TTL_SEC = 3600;

// Refill when this fraction of a book has been drawn by THIS isolate.
//
// Raised from 0.25: at a quarter, a 50-voucher book refilled every ~12 draws, so
// a burst-100 rotated it several times mid-flight. Rotation is no longer fatal
// (the index survives it) but it is still churn, and each rotation costs a pull
// against the cell.
const REFILL_AT_FRACTION = 0.5;

// How many vouchers to ask for. Sized against the burst, not the pool: at N>=4x
// the concurrent draw count, same-colo collisions stay to a few percent. The CP
// clamps this to available stock minus the reserve it holds back for its own
// create path.
const BOOK_SIZE = 512;

// A voucher this close to expiry is skipped rather than handed out — it would
// likely lose its race with the CP's reconciler. Scaled with the TTLs above.
const EXPIRY_GUARD_SEC = 300;

// How many free-list claims one draw may attempt before giving up on the book.
// Sized against the load factor a 150-box pool produces: a burst of 100 into a
// book of ~120-142 needs about 2 probes on average and ~6 for the last arrival,
// so this leaves headroom without letting a draw walk the whole book.
const PROBE_BUDGET = 24;

// How long an isolate may serve the book out of local memory.
//
// Was 5s, which produced a 32% memo hit rate at burst-100 — two draws in three
// re-read and re-parsed a ~30KB book that had not changed. The book carries its
// own 30-minute TTL and every refill overwrites this, so a short window here
// bought no freshness; it only bought work. A stale entry is also harmless: the
// free-list claim, not the book, decides whether a box is actually available.
const MEMO_TTL_MS = 60_000;

// Refresh once a book is older than this, on ANY request, in waitUntil.
//
// This is what keeps the book warm without depending on a miss to notice it is
// cold. A miss is far too late: under burst, a hundred of them arrive together
// and every one falls through. Refreshing at half life means steady traffic
// keeps the book permanently fresh, and the miss path becomes the rare case it
// was designed to be.
const REFRESH_AGE_MS = (BOOK_TTL_SEC * 1000) / 2;

// How long a create will wait for a cold book to fill before giving up and
// taking the control-plane path.
//
// Generous relative to the refill (one origin GET, ~70ms in-region) because the
// alternative is not "wait less", it is a hundred simultaneous control-plane
// creates. Bounded so a sick cell cannot hold creates hostage.
const COLD_REFILL_WAIT_MS = 2000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Per-isolate draw state.
//
// `base` is randomised ONCE per isolate. Two isolates in a colo therefore start
// at different offsets into the same book, and `cursor` guarantees an isolate
// never draws the same index twice. That is the whole collision-avoidance
// scheme, and it is deliberately local — any shared counter would be a
// coordination point, which is the thing this design exists to remove.
let base = Math.floor(Math.random() * 1_000_003);
let cursor = 0;
let drawnFromBookAt = 0;
let drawnCount = 0;

// Parsed-book memo, so repeated draws in one isolate do not re-parse JSON.
let memo: { book: Book; at: number } | null = null;

// Bindings this isolate made or has already looked up. Not a cache tier that
// can be wrong: a binding is immutable once written, so a local hit is exactly
// what the colo cache holds.
/**
 * What a create recorded about the sandbox it just answered: the box it claimed,
 * plus the finalize it sent for that box.
 *
 * The finalize rides along because a rebind has to CORRECT it. Finalize is
 * enqueued at create naming the box the create drew, so if the exec ladder ends
 * up on a different box — the first one is dead, or was claimed out from under
 * us — the control plane is left pointing at a box this sandbox does not own,
 * and a later destroy would terminate someone else's. The exec has no cell
 * handle to rebuild that message from, so the create leaves it here.
 */
export interface Binding {
  voucher: Voucher;
  /** The FinalizeMsg the create enqueued, opaque to this module. */
  fin?: unknown;
}

const bindings = new Map<string, Binding>();
const BIND_MAX_LOCAL = 5000;

// One refill in flight per isolate. Not a correctness device — a duplicate
// refill is harmless because the CP hands out disjoint sets — purely to avoid
// spending several connections on the same work.
let refilling: Promise<void> | null = null;

function usable(v: Voucher, nowSec: number): boolean {
  return !!v && !!v.endpoint && !!v.microvmID && v.expiresAtUnix - nowSec > EXPIRY_GUARD_SEC;
}

async function readBook(key: string): Promise<Book | null> {
  const b = await coloGet<Book>(key, "book");
  if (!b || !Array.isArray(b.vouchers) || b.vouchers.length === 0) return null;
  return b;
}

/**
 * refillBook pulls a fresh book from the cell and rotates the current one into
 * the previous slot.
 *
 * ALWAYS called from waitUntil, never awaited on a create. This is the only
 * place the voucher path talks to the control plane, and it happens once per
 * colo per refill window rather than once per create — which is the entire
 * point.
 */
export async function refillBook(
  cellBaseURL: string,
  colo: string,
  mintToken: () => Promise<string>,
): Promise<void> {
  if (refilling) return refilling;
  refilling = (async () => {
    try {
      if (!(await claimLease())) {
        // Another isolate is pulling for this colo. Wait for its book rather
        // than issuing a competing pull that would return zero vouchers.
        for (let waited = 0; waited < LEASE_WAIT_MS; waited += LEASE_POLL_MS) {
          await sleep(LEASE_POLL_MS);
          const b = await readBook(CUR);
          if (!b && !(await coloGet<unknown>(LEASE, BOOK_GEN))) {
            // The pull failed and released the lease. Waiting longer cannot
            // help, and the next create through here will start a new one.
            return;
          }
          if (b && b.vouchers.length > 0) {
            memo = { book: b, at: Date.now() };
            if (b.fetchedAtMs !== drawnFromBookAt) {
              drawnFromBookAt = b.fetchedAtMs;
              drawnCount = 0;
              cursor = 0;
            }
            return;
          }
        }
        return;
      }
      const url = `${cellBaseURL.replace(/\/$/, "")}/internal/pool/vouchers?colo=${encodeURIComponent(colo)}&n=${BOOK_SIZE}`;
      // The HMAC mint lives HERE, inside the refill, and never on a create.
      // Signing was measured as one of the larger CPU items driving isolate
      // queueing at burst-100, and a create must not pay it.
      const resp = await fetch(url, { headers: { authorization: "Bearer " + (await mintToken()) } });
      if (!resp.ok) { await releaseLease(); return; }
      const body = (await resp.json()) as { vouchers?: Voucher[] };
      const vouchers = body?.vouchers ?? [];
      if (vouchers.length === 0) { await releaseLease(); return; }

      // Rotate before overwriting: vouchers already handed out of the outgoing
      // book must stay resolvable for the execs that will arrive against them.
      const outgoing = await readBook(CUR);
      if (outgoing) await coloPut(PREV, "book", outgoing, BOOK_TTL_SEC * 2);

      // List the NEW boxes as claimable. Never the carried-forward ones: they
      // already have entries, and the drawn ones among them have had those
      // entries deleted on purpose.
      await publishFree(vouchers);

      // Carry undrawn stock forward instead of dropping it.
      //
      // The cell vouchers out of `warm` and a promised box does not go back, so
      // each refill returns a DIFFERENT set — replacing the book outright
      // stranded everything the previous one had not handed out, and at a
      // 150-box pool the second refill then returns almost nothing. Merging is
      // safe now that the free list exists: a carried-forward box that was
      // already drawn simply loses its claim.
      const nowSec2 = Math.floor(Date.now() / 1000);
      const seen = new Set(vouchers.map((v) => v.microvmID));
      const carried = (outgoing?.vouchers ?? []).filter((v) => usable(v, nowSec2) && !seen.has(v.microvmID));
      const merged = [...vouchers, ...carried].slice(0, BOOK_SIZE);

      const next: Book = { vouchers: merged, fetchedAtMs: Date.now() };
      await coloPut(CUR, "book", next, BOOK_TTL_SEC);
      memo = { book: next, at: Date.now() };
      // New book, new draw window. `cursor` resets WITH it — a fresh book is a
      // disjoint set of boxes from the cell, so starting over at the base is
      // drawing new stock, not re-drawing spent stock. Without this reset an
      // isolate that once hit the end of a book could never draw again, since
      // the hard stop below compares cursor against the new book's length.
      drawnFromBookAt = next.fetchedAtMs;
      drawnCount = 0;
      cursor = 0;
      takenLocal.clear();
    } catch {
      await releaseLease();
      // Best-effort by construction: a failed refill just means the next create
      // misses the book and takes the control-plane path, which is correct and
      // is what every create did before this existed.
    } finally {
      refilling = null;
    }
  })();
  return refilling;
}

export interface Draw {
  voucher: Voucher;
  /** Colo-cache read + parse of the book, ms. 0 when the isolate memo served it. */
  readMs: number;
  /** Free-list claim deletes, ms. */
  casMs: number;
  /** 1 when this isolate's memo served the book, 0 when it had to read. */
  memoHit: number;
  /** Vouchers left in the book after this draw, for telemetry only. */
  remaining: number;
  /** Free-list claims attempted for this draw. 1 means uncontended. */
  probes: number;
}

/**
 * takeVoucher draws one voucher for a create. Returns null when the book cannot
 * serve, and the caller must fall through to the control-plane create path.
 *
 * Never throws and never blocks on I/O beyond a single colo cache read.
 */
export async function takeVoucher(
  cellBaseURL: string,
  colo: string,
  mintToken: () => Promise<string>,
  waitUntil: (p: Promise<unknown>) => void,
): Promise<Draw | null> {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);

  let book = memo && nowMs - memo.at < MEMO_TTL_MS ? memo.book : null;
  const memoHit = book ? 1 : 0;
  let readMs = 0;
  let casMs = 0;
  const tRead = Date.now();
  if (!book) {
    book = await readBook(CUR);
    if (book) memo = { book, at: nowMs };
  }
  readMs = Date.now() - tRead;
  if (!book) {
    // COLD BOOK. Do not simply fall through — under burst that is the stampede:
    // 100 creates miss together, all fall through to the control plane at once,
    // and drive it to 5.1s of D1 and 34 rate-limit 503s (measured 2026-08-26,
    // TTI p50 8.7s, worse than having no voucher path at all). Raising TTLs does
    // not help here, because the very first traffic after a deploy IS the burst.
    //
    // So wait for the refill instead, bounded. refillBook is single-flight per
    // isolate, so the hundred creates sharing this isolate issue ONE fetch and
    // then all draw from the result. That is intra-isolate coalescing — the same
    // shape loadCreateContext already uses — and is NOT the cross-request
    // dependency that cost 18% of a burst to error 1101: every request still
    // owns its own response, and a slow refill degrades to the old path rather
    // than hanging.
    const refill = refillBook(cellBaseURL, colo, mintToken);
    waitUntil(refill);
    await Promise.race([refill, sleep(COLD_REFILL_WAIT_MS)]);
    book = await readBook(CUR);
    if (!book) return null;
    memo = { book, at: Date.now() };
    // Deliberately does NOT reset `cursor`: refillBook already did, once, and
    // the concurrent creates that shared this cold path all arrive here after
    // it. Resetting per request would hand every one of them the same index.
    drawnFromBookAt = book.fetchedAtMs;
    drawnCount = 0;
  }

  // A new book resets this isolate's draw window.
  if (book.fetchedAtMs !== drawnFromBookAt) {
    drawnFromBookAt = book.fetchedAtMs;
    drawnCount = 0;
    cursor = 0;
  }

  const n = book.vouchers.length;
  // HARD STOP AT THE END OF THE BOOK — the modulo must never wrap.
  //
  // `cursor` is monotonic within a book window, so this isolate's draw sequence
  // is base, base+1, ... base+n-1: exactly n DISTINCT indices. Wrapping past
  // that re-issues a voucher this isolate has already handed out, and a voucher
  // carries its sandbox ID — so two customers receive the SAME sandbox. Nothing
  // downstream can catch it: the guest CAS sees the same sandbox ID and reports
  // idempotent success, which is indistinguishable from a legitimate replay.
  //
  // This is not the tolerable duplicate the header describes. That argument
  // holds only for two isolates drawing DIFFERENT sandbox IDs for one box,
  // where the CAS picks a winner. A wrap produces a duplicate the CAS is blind
  // to, and it is guaranteed rather than unlikely the moment the burst exceeds
  // the book (measured: a 100-burst against an 80-voucher book).
  //
  // Past the end we return null and the caller takes the control-plane path,
  // which is slower and correct.
  //
  // Each candidate must be CLAIMED, not just picked — see the free-list note
  // above. A lost claim means another isolate already took that box, so we
  // advance. The budget is generous because a probe is a ~1ms colo op, not the
  // ~80ms box round trip a lost race used to cost: even a worst-case walk here
  // is cheaper than one wasted CAS against a box.
  let picked: Voucher | null = null;
  let probes = 0;
  for (let i = 0; i < PROBE_BUDGET && !picked && cursor < n; i++) {
    const v = book.vouchers[(base + cursor++) % n];
    if (!usable(v, nowSec)) continue;
    // Skipping a known-taken box is free and is NOT a probe. Deciding that by
    // elapsed time would be wrong — a fast colo delete also takes ~0ms — so ask
    // the set directly.
    if (takenLocal.has(v.microvmID)) continue;
    probes++;
    const tCas = Date.now();
    const won = await claimFree(v.microvmID);
    casMs += Date.now() - tCas;
    if (won) picked = v;
  }
  const exhausted = cursor >= n;
  drawnCount++;

  // Refill on ANY of: this isolate has drawn its share, the book is past half
  // its life, or we could not find a usable voucher. The age trigger is the one
  // that prevents the stampede — it refreshes while the book is still serving,
  // rather than waiting for it to be empty.
  if (
    drawnCount >= n * REFILL_AT_FRACTION ||
    nowMs - book.fetchedAtMs > REFRESH_AGE_MS ||
    !picked ||
    exhausted
  ) {
    waitUntil(refillBook(cellBaseURL, colo, mintToken));
  }
  if (!picked) return null;
  return { voucher: picked, remaining: Math.max(0, n - drawnCount), probes, readMs, casMs, memoHit };
}

/**
 * drawReplacement claims another box for a sandbox whose first one did not work
 * out — the box CAS said someone else owns it, or the proxy says it is gone.
 *
 * Deliberately cannot refill: an exec has no cell handle and must not acquire
 * one, since a subrequest here is the very cost this whole path exists to avoid.
 * If the colo's book is dry it returns null and the caller falls back to the
 * control plane, which is slower and correct.
 */
export async function drawReplacement(): Promise<Voucher | null> {
  const nowMs = Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const book = memo && nowMs - memo.at < MEMO_TTL_MS ? memo.book : await readBook(CUR);
  if (!book) return null;
  const n = book.vouchers.length;
  if (n === 0) return null;
  if (book.fetchedAtMs !== drawnFromBookAt) {
    drawnFromBookAt = book.fetchedAtMs;
    drawnCount = 0;
    cursor = 0;
  }
  for (let i = 0; i < PROBE_BUDGET && cursor < n; i++) {
    const v = book.vouchers[(base + cursor++) % n];
    if (!usable(v, nowSec)) continue;
    if (await claimFree(v.microvmID)) {
      drawnCount++;
      return v;
    }
  }
  return null;
}

/**
 * bindVoucher records which box a create handed to which sandbox.
 *
 * The create path calls this; nothing else establishes the pairing, because
 * nothing else knows it. Cheap on purpose: one colo-cache write, no subrequest,
 * and the in-isolate map means the common case (create and exec landing on the
 * same isolate) resolves without touching the cache at all.
 */
export function bindVoucher(
  sandboxID: string,
  v: Voucher,
  waitUntil: (p: Promise<unknown>) => void,
  fin?: unknown,
): void {
  if (bindings.size >= BIND_MAX_LOCAL) bindings.clear();
  const b: Binding = { voucher: v, fin };
  bindings.set(sandboxID, b);
  waitUntil(coloPut(BIND, sandboxID, b, BIND_TTL_SEC).catch(() => {}));
}

// Why a resolution went the way it did. Emitted on the exec path so a miss is
// diagnosable from the outside — inferring it from latency alone is how two
// separate wrong theories survived a full day.
export type ResolveTier = "local" | "bind" | "miss";
export let lastResolveTier: ResolveTier = "miss";

/**
 * resolveVoucher turns a sandbox ID back into the box its create drew.
 *
 * Null means "not ours", and the caller falls back to normal routing — which is
 * the control-plane path that has always worked.
 */
export async function resolveBinding(sandboxID: string): Promise<Binding | null> {
  const local = bindings.get(sandboxID);
  if (local) {
    lastResolveTier = "local";
    return local;
  }
  const hit = await coloGet<Binding>(BIND, sandboxID);
  if (hit && hit.voucher?.endpoint) {
    bindings.set(sandboxID, hit);
    lastResolveTier = "bind";
    return hit;
  }
  lastResolveTier = "miss";
  return null;
}

export async function resolveVoucher(sandboxID: string): Promise<Voucher | null> {
  return (await resolveBinding(sandboxID))?.voucher ?? null;
}

/**
 * evictVoucher drops a binding whose box is gone (AWS 502).
 *
 * A binding outlives the sandbox it names: the customer destroys the sandbox,
 * the cell terminates the box, and this entry still points at it for the rest of
 * its TTL. Dialling it then yields a 502, so the exec ladder evicts and retries
 * rather than reporting a dead box as the customer's answer.
 */
export async function evictVoucher(sandboxID: string): Promise<void> {
  bindings.delete(sandboxID);
  await coloPut(BIND, sandboxID, { voucher: { microvmID: "", endpoint: "", token: "", port: 0, expiresAtUnix: 0 } }, 1).catch(
    () => {},
  );
}

/**
 * purgeBooks abandons this colo's book after the cell disowned a voucher from it.
 *
 * A lost finalize is the cell saying "that box was never mine to give" — which,
 * for a whole book at once, means the cell restarted underneath it. Nothing else
 * detects that: the book is a cache entry with its own TTL and no knowledge of
 * the process that filled it, so without this a single restart poisons every
 * create in the colo until the entry ages out.
 *
 * Runs off the response path (the finalize is already async), and the next
 * create takes the cold path, refills, and is served correctly.
 */
export async function purgeBooks(): Promise<void> {
  memo = null;
  bindings.clear();
  cursor = 0;
  drawnFromBookAt = 0;
  drawnCount = 0;
  const dead = { vouchers: [] as Voucher[], fetchedAtMs: 0 };
  await Promise.all([
    coloPut(CUR, "book", dead, 1).catch(() => {}),
    coloPut(PREV, "book", dead, 1).catch(() => {}),
  ]);
}

// peekVoucher returns a live voucher WITHOUT claiming it. Measurement only —
// the RTT probe needs a real box it can address through the AWS proxy, and
// drawing one properly would consume stock and skew the very pool the probe is
// run against. Never call this on a create path: two callers get the same box.
export async function peekVoucher(): Promise<Voucher | null> {
  const book = memo?.book ?? (await readBook(CUR));
  if (!book) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  return book.vouchers.find((v) => usable(v, nowSec)) ?? null;
}

/** Test seam: drop per-isolate state so cases do not bleed into each other. */
// Test seam: rewind the draw cursor without forgetting which boxes this isolate
// has already lost. Distinguishes "same isolate draws again" from "a different
// isolate draws", which _resetVoucherIsolateState models.
export function _rewindCursorForTest(): void {
  cursor = 0;
}

export function _resetVoucherIsolateState(newBase = 0): void {
  base = newBase;
  cursor = 0;
  drawnFromBookAt = 0;
  drawnCount = 0;
  memo = null;
  refilling = null;
  bindings.clear();
  // Part of this isolate's identity: a different isolate has not seen these
  // losses, and tests rely on that to stand in for separate isolates.
  takenLocal.clear();
  lastResolveTier = "miss";
}
