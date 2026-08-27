import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetVoucherIsolateState, _rewindCursorForTest, bindVoucher, resolveVoucher, takeVoucher, type Voucher } from "./voucher_book";

// A minimal stand-in for caches.default. The real one is colo-shared and
// best-effort; what matters for these cases is that it is SHARED, because that
// is the property the per-isolate hint map lacked.
function installFakeColoCache() {
  // Honours max-age, because that is the ONLY thing enforcing BOOK_TTL_SEC — the
  // module never checks book age on read, it relies on the entry evicting. A
  // fake that stores forever would make the idle-gap test pass at any TTL and
  // pin nothing.
  const store = new Map<string, { body: string; expiresAtMs: number }>();
  (globalThis as unknown as { caches: unknown }).caches = {
    default: {
      async match(url: string) {
        const v = store.get(url);
        if (v === undefined) return undefined;
        if (Date.now() >= v.expiresAtMs) {
          store.delete(url);
          return undefined;
        }
        return new Response(v.body);
      },
      async put(url: string, resp: Response) {
        const cc = resp.headers.get("cache-control") ?? "";
        const m = cc.match(/max-age=(\d+)/);
        const ttlMs = (m ? Number(m[1]) : 0) * 1000;
        store.set(url, { body: await resp.text(), expiresAtMs: Date.now() + ttlMs });
      },
      async delete(url: string) {
        return store.delete(url);
      },
    },
  };
  return store;
}

function mkVouchers(n: number, ttlSec = 3600): Voucher[] {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  return Array.from({ length: n }, (_, i) => ({
    microvmID: `mvm-${i}`,
    endpoint: `ep-${i}`,
    token: "t",
    port: 8080,
    expiresAtUnix: exp,
  }));
}

const noWait = (p: Promise<unknown>) => void p.catch(() => {});

// Rewind this isolate's cursor while KEEPING what it has learned. _reset clears
// the taken-set too, which would stand in for a different isolate entirely.
const cursorBackToStart = () => _rewindCursorForTest();

describe("voucher book", () => {
  // Every test leaves refills in flight — a draw schedules one through waitUntil
  // and the helpers hand it a swallowing stub. Let those settle BEFORE resetting,
  // or a stale single-flight promise is what the next test's cold path awaits,
  // and it resolves against the previous test's cache.
  beforeEach(async () => {
    await new Promise((r) => setTimeout(r, 0));
    installFakeColoCache();
    _resetVoucherIsolateState(0);
    vi.restoreAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
  });

  async function seed(vouchers: Voucher[]) {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ vouchers })));
    vi.stubGlobal("fetch", fetchMock);
    // First draw finds a cold book, waits for the refill it triggered, and is
    // served from it — the whole point of the cold path.
    const first = await takeVoucher("https://cell", "IAD", async () => "k", (p) => void p);
    expect(first).not.toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    return fetchMock;
  }

  it("fills a cold book on demand and serves the create that found it cold", async () => {
    const fetchMock = await seed(mkVouchers(64));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    _resetVoucherIsolateState(0);
    const got = await takeVoucher("https://cell", "IAD", async () => "k", noWait);
    expect(got?.voucher.microvmID).toBeTruthy();
  });

  // The core burst property: one isolate must never hand the same box to two
  // creates. Cross-isolate collisions are tolerable (the box CAS settles them);
  // self-collisions would be gratuitous.
  it("never draws the same voucher twice within an isolate", async () => {
    await seed(mkVouchers(256));
    _resetVoucherIsolateState(0);
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const d = await takeVoucher("https://cell", "IAD", async () => "k", noWait);
      expect(d).not.toBeNull();
      expect(seen.has(d!.voucher.microvmID)).toBe(false);
      seen.add(d!.voucher.microvmID);
    }
    expect(seen.size).toBe(100);
  });

  // Different isolates start at different offsets, so a burst spread across
  // isolates does not have every one of them draw index 0.
  it("spreads draws across isolates via the random base", async () => {
    await seed(mkVouchers(256));
    const firstOf = (b: number) => {
      _resetVoucherIsolateState(b);
      return takeVoucher("https://cell", "IAD", async () => "k", noWait);
    };
    const a = await firstOf(0);
    const b = await firstOf(97);
    expect(a!.voucher.microvmID).not.toBe(b!.voucher.microvmID);
  });

  // THE burst property, and the reason the free list exists. Two isolates
  // reading one shared book pick independently, so at a load factor near 1 the
  // pigeonhole guarantees overlap — 37 of 100 measured. The claim is what makes
  // the draw disjoint: a box is taken by DELETING its free-list entry, and
  // Cache API delete reports a single winner.
  it("never hands the same box to two isolates drawing the same book", async () => {
    await seed(mkVouchers(64));
    const drawnBy = async (b: number) => {
      _resetVoucherIsolateState(b);
      return takeVoucher("https://cell", "IAD", async () => "k", noWait);
    };
    const seen = new Set<string>();
    // Every isolate starts at index 0 — the worst case the old code had no
    // answer for, since base is what used to spread them. Each one therefore
    // walks past everything already taken, so 20 draws is also the deepest walk
    // PROBE_BUDGET has to absorb here.
    for (let i = 0; i < 20; i++) {
      const d = await drawnBy(0);
      expect(d).not.toBeNull();
      expect(seen.has(d!.voucher.microvmID)).toBe(false);
      seen.add(d!.voucher.microvmID);
    }
    expect(seen.size).toBe(20);
  });

  // A lost claim costs a ~1ms colo op, not an ~80ms round trip to a box, so the
  // draw walks past taken boxes rather than handing one out and losing at the CAS.
  it("walks past boxes another isolate already claimed", async () => {
    await seed(mkVouchers(8));
    // Isolate A takes the first three from index 0.
    _resetVoucherIsolateState(0);
    const taken = new Set<string>();
    for (let i = 0; i < 3; i++) {
      taken.add((await takeVoucher("https://cell", "IAD", async () => "k", noWait))!.voucher.microvmID);
    }
    // Isolate B starts at the same base and must skip all three.
    _resetVoucherIsolateState(0);
    const d = await takeVoucher("https://cell", "IAD", async () => "k", noWait);
    expect(d).not.toBeNull();
    expect(taken.has(d!.voucher.microvmID)).toBe(false);
    // seed() itself drew one, so four boxes are gone: four losses, then the win.
    expect(d!.probes).toBe(5);
  });

  // A lost claim is permanent, so an isolate must never pay for the same loss
  // twice. Before the local set existed, `vclaim` p95 was 11 probes and `vcas`
  // p95 144ms at burst-100 — the tail of a draw was re-discovering losses it had
  // already discovered, at ~13ms of colo round trip each.
  it("never re-probes a box it has already lost", async () => {
    await seed(mkVouchers(16));
    // Another isolate takes the first four.
    _resetVoucherIsolateState(0);
    for (let i = 0; i < 4; i++) await takeVoucher("https://cell", "IAD", async () => "k", noWait);

    _resetVoucherIsolateState(0);
    const first = await takeVoucher("https://cell", "IAD", async () => "k", noWait);
    // seed() took one and the loop took four, so five losses precede the win.
    expect(first!.probes).toBe(6);

    // The next draw starts at the same base and must walk the same dead entries
    // WITHOUT paying for them again.
    cursorBackToStart();
    const second = await takeVoucher("https://cell", "IAD", async () => "k", noWait);
    expect(second).not.toBeNull();
    expect(second!.probes).toBe(1);
  });

  // Refills used to REPLACE the book, stranding every box the previous one had
  // not handed out — and since the cell vouchers out of `warm` and never takes a
  // promise back, the next refill then returns almost nothing at a 150-box pool.
  it("carries undrawn stock forward across a refill", async () => {
    await seed(mkVouchers(8));
    _resetVoucherIsolateState(0);
    const first = await takeVoucher("https://cell", "IAD", async () => "k", noWait);

    const fresh = mkVouchers(4).map((v) => ({ ...v, microvmID: "new-" + v.microvmID }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ vouchers: fresh }))));
    const { refillBook } = await import("./voucher_book");
    // Past the colo's refill window, so this counts as a NEW pull rather than
    // one racing the pull that just happened.
    vi.setSystemTime(Date.now() + 6_000);
    await refillBook("https://cell", "IAD", async () => "k");

    // 4 new + 6 still-unclaimed carried = 10 drawable (seed() took one too), and
    // neither box already handed out is among them.
    _resetVoucherIsolateState(0);
    const seen = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const d = await takeVoucher("https://cell", "IAD", async () => "k", noWait);
      expect(d).not.toBeNull();
      seen.add(d!.voucher.microvmID);
    }
    expect(seen.size).toBe(10);
    expect(seen.has(first!.voucher.microvmID)).toBe(false);
  });

  // The cold-book stampede. A burst arriving on many cold isolates must produce
  // ONE pull for the colo, not one per isolate: the cell serves them in order, so
  // the first takes almost the whole pool and the rest get zero vouchers back.
  // Measured against a purged book before the lease existed: create p50 2874.9ms,
  // 75/100, vstock=0 on every create.
  it("pulls once per colo when many cold isolates race for a missing book", async () => {
    let pulls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        pulls++;
        // The cell only has stock for the FIRST puller, exactly as it behaves
        // when a colo drains it: everyone after gets an empty answer.
        return new Response(JSON.stringify({ vouchers: pulls === 1 ? mkVouchers(64) : [] }));
      }),
    );
    const { refillBook } = await import("./voucher_book");
    // Each cold isolate is its own module state, so reset between them — that is
    // precisely why per-isolate single-flight was no protection.
    for (let i = 0; i < 10; i++) {
      _resetVoucherIsolateState(i);
      await refillBook("https://cell", "IAD", async () => "k");
    }
    expect(pulls).toBe(1);

    // ...and the losers can still draw, from the winner's book.
    _resetVoucherIsolateState(3);
    const d = await takeVoucher("https://cell", "IAD", async () => "k", noWait);
    expect(d).not.toBeNull();
  });

  // A loser must not serve out its full wait when the pull it is waiting on has
  // already died — the winner deletes the lease on failure, so "no lease and no
  // book" means nobody is coming.
  it("stops waiting as soon as the winning pull fails", async () => {
    let pulls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        pulls++;
        return new Response("nope", { status: 500 });
      }),
    );
    const { refillBook } = await import("./voucher_book");
    _resetVoucherIsolateState(0);
    await refillBook("https://cell", "IAD", async () => "k"); // winner: fails, releases

    // A second isolate must return promptly rather than burning LEASE_WAIT_MS,
    // and because the lease was released it is free to pull again itself.
    _resetVoucherIsolateState(1);
    const t0 = Date.now();
    await refillBook("https://cell", "IAD", async () => "k");
    expect(Date.now() - t0).toBeLessThan(500);
    expect(pulls).toBe(2);
  });

  // A voucher about to be reclaimed by the CP's reaper must not be handed out —
  // the claim would race it and lose.
  it("skips vouchers close to expiry rather than losing a race with the reaper", async () => {
    // Not via seed(): a book of nothing BUT near-expiry vouchers can never
    // serve, which is precisely what this asserts.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ vouchers: mkVouchers(32, 5) }))));
    _resetVoucherIsolateState(0);
    const got = await takeVoucher("https://cell", "IAD", async () => "k", noWait);
    expect(got).toBeNull();
  });

  // A binding is written by the create that minted the id, and must survive any
  // number of book rotations — it has nothing to do with book retention.
  it("resolves a sandbox back to its box, and across a book rotation", async () => {
    await seed(mkVouchers(16));
    _resetVoucherIsolateState(0);
    const drawn = await takeVoucher("https://cell", "IAD", async () => "k", noWait);
    bindVoucher("sb-mine", drawn!.voucher, noWait);
    expect((await resolveVoucher("sb-mine"))?.microvmID).toBe(drawn!.voucher.microvmID);

    // Rotate: a brand-new, disjoint book replaces the current one.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ vouchers: mkVouchers(16) }))));
    const { refillBook } = await import("./voucher_book");
    // Past the colo's refill window, so this counts as a NEW pull rather than
    // one racing the pull that just happened.
    vi.setSystemTime(Date.now() + 6_000);
    await refillBook("https://cell", "IAD", async () => "k");

    expect((await resolveVoucher("sb-mine"))?.microvmID).toBe(drawn!.voucher.microvmID);
    expect(await resolveVoucher("sb-never-issued")).toBeNull();
  });

  // The burst-100 regression, pinned: a book must still serve after an idle gap
  // far longer than the old 45s TTL. When it did not, 100 creates missed at once
  // and stampeded the control plane (TTI p50 8.7s, 35 rate-limit 503s).
  it("still serves after a long idle gap", async () => {
    await seed(mkVouchers(256, 3600));
    _resetVoucherIsolateState(0);
    // Ten minutes of nothing — the gap that produced the 8.7s burst.
    vi.setSystemTime(Date.now() + 10 * 60_000);
    const got = await takeVoucher("https://cell", "IAD", async () => "k", noWait);
    expect(got).not.toBeNull();
    vi.useRealTimers();
  });

  // Freshness must not depend on a miss noticing the book is cold — by then a
  // burst has already fallen through.
  it("refreshes proactively at half life, while still serving", async () => {
    const fetchMock = await seed(mkVouchers(256, 3600));
    _resetVoucherIsolateState(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 20 * 60_000); // past half of the 30-min TTL
    const got = await takeVoucher("https://cell", "IAD", async () => "k", noWait);
    expect(got).not.toBeNull(); // served from the current book...
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1); // ...and refreshed behind it
    vi.useRealTimers();
  });

  // The burst-100 stampede, pinned: when the book is cold, concurrent creates
  // must issue ONE refill and then all draw from it — not all fall through to
  // the control plane together.
  it("a cold book coalesces concurrent creates onto one refill", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ vouchers: mkVouchers(256) })));
    vi.stubGlobal("fetch", fetchMock);
    _resetVoucherIsolateState(0);

    const draws = await Promise.all(
      Array.from({ length: 20 }, () => takeVoucher("https://cell", "IAD", async () => "k", noWait)),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1); // one refill, not twenty
    const served = draws.filter((d) => d !== null);
    expect(served.length).toBeGreaterThan(0); // and they got served, not dropped
    const ids = new Set(served.map((d) => d!.voucher.microvmID));
    expect(ids.size).toBe(served.length); // still no self-collision
  });

  // THE burst-100 exec failure, pinned. Every create succeeded and every exec
  // 404'd because the book rotated out from under its own in-flight requests.
  // Resolution must survive any number of rotations.
  it("resolves a sandbox after many book rotations", async () => {
    await seed(mkVouchers(50));
    _resetVoucherIsolateState(0);
    const drawn = await takeVoucher("https://cell", "IAD", async () => "k", noWait);
    const box = drawn!.voucher.microvmID;
    bindVoucher("sb-mine", drawn!.voucher, noWait);

    // Five disjoint refills — far past the two-deep book rotation that dropped it.
    const { refillBook } = await import("./voucher_book");
    for (let r = 0; r < 5; r++) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ vouchers: mkVouchers(50) }))));
      await refillBook("https://cell", "IAD", async () => "k");
    }

    const got = await resolveVoucher("sb-mine");
    expect(got).not.toBeNull();
    expect(got!.microvmID).toBe(box);
  });

  // The defect that made burst unusable, pinned from the edge side: a book
  // smaller than the burst must REFUSE rather than wrap. Wrapping re-issued a
  // voucher this isolate had already handed out, and when the sandbox id lived
  // inside the voucher that meant two customers holding the same sandbox.
  it("refuses to draw past the end of the book instead of wrapping", async () => {
    await seed(mkVouchers(8));
    _resetVoucherIsolateState(0);
    // Refills return nothing, so the book cannot grow under the test and the
    // only thing being measured is what ONE book will serve.
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ vouchers: [] }))));
    const seen = new Set<string>();
    let nulls = 0;
    for (let i = 0; i < 20; i++) {
      const d = await takeVoucher("https://cell", "IAD", async () => "k", noWait);
      if (!d) {
        nulls++;
        continue;
      }
      expect(seen.has(d.voucher.microvmID)).toBe(false);
      seen.add(d.voucher.microvmID);
    }
    expect(seen.size).toBeLessThanOrEqual(8);
    expect(nulls).toBeGreaterThan(0); // the excess fell through to the CP path

    // Restock is NOT asserted here. It needs a refill to land mid-test, and the
    // loop above leaves refills in flight that this one would race — see
    // "carries undrawn stock forward across a refill", which pins it cleanly.
  });

  // The index must not answer for a sandbox nobody issued.
  it("does not resolve an unknown sandbox", async () => {
    await seed(mkVouchers(50));
    expect(await resolveVoucher("sb-never-issued")).toBeNull();
  });

  it("a failed refill degrades to the fallback rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const got = await takeVoucher("https://cell", "IAD", async () => "k", noWait);
    expect(got).toBeNull();
  });
});
