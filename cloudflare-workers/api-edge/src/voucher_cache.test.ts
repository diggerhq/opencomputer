import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  popVoucher,
  _resetCacheClientState,
  _setPeersForTest,
  type CachePeer,
} from "./voucher_cache";

const SECRET = "shh";
const mintToken = async () => "cap-token";
const waitUntil = (p: Promise<unknown>) => { void p.catch(() => {}); };

function voucher(id: string) {
  return {
    microvmID: id,
    endpoint: "box.example",
    token: "t",
    port: 8080,
    expiresAtUnix: Math.floor(Date.now() / 1000) + 3600,
  };
}

function peer(endpoint: string, retireAtUnix?: number): CachePeer {
  return { endpoint, token: "pt", port: 8079, retireAtUnix };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetCacheClientState();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function popOK(v: unknown, peers?: CachePeer[]) {
  return new Response(JSON.stringify({ voucher: v, peers }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("in-region voucher cache client", () => {
  it("pops a voucher and reports how many instances it had to try", async () => {
    _setPeersForTest([peer("a.example")]);
    fetchMock.mockResolvedValue(popOK(voucher("mvm-1")));

    const got = await popVoucher("https://cell", SECRET, mintToken, waitUntil);
    expect(got?.voucher.microvmID).toBe("mvm-1");
    expect(got?.tries).toBe(1);
  });

  // A cold isolate must ask the control plane ONCE. This is the same stampede
  // that made a cold colo book cost 1498ms: 100 concurrent creates each
  // discovering independently is 100 calls into the thing we are avoiding.
  // A cold isolate must not block on discovery — awaiting it cost 336ms p50 at
  // burst-100 because every cold isolate called the control plane at once. It
  // returns null (caller falls back to the book) and discovers in background.
  it("does not block a create on discovery", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/internal/pool/cache-peers")) {
        return new Response(JSON.stringify({ peers: [peer("a.example")] }), { status: 200 });
      }
      return popOK(voucher("mvm-x"));
    });
    expect(await popVoucher("https://cell", SECRET, mintToken, waitUntil)).toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    // Now warm: the next create pops without touching the control plane.
    const got = await popVoucher("https://cell", SECRET, mintToken, waitUntil);
    expect(got?.voucher.microvmID).toBe("mvm-x");
  });

  it("pops on a cold isolate when the colo already knows the peers", async () => {
    // The regression that made this tier dead under burst: a burst is almost
    // entirely COLD isolates, so folding the colo read into the background
    // discovery path meant every create returned null and fell through to the
    // book. Measured burst-100: vpop=0 on all 100. The colo read is same-colo
    // and cheap, so a cold isolate must await it; only the control-plane fetch
    // stays in the background.
    vi.stubGlobal("caches", {
      default: {
        match: async () =>
          new Response(JSON.stringify([peer("a.example")]), {
            headers: { "content-type": "application/json" },
          }),
        put: async () => {},
        delete: async () => true,
      },
    });
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/internal/pool/cache-peers")) {
        throw new Error("cold isolate must not wait on the control plane");
      }
      return popOK(voucher("mvm-colo"));
    });

    // First call on a brand-new isolate: no module state, straight to a pop.
    const got = await popVoucher("https://cell", SECRET, mintToken, waitUntil);
    expect(got?.voucher.microvmID).toBe("mvm-colo");
    expect(
      fetchMock.mock.calls.filter((c) => String(c[0]).includes("/internal/pool/cache-peers")).length,
    ).toBe(0);
  });

  it("discovers peers once no matter how many creates race", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes("/internal/pool/cache-peers")) {
        return new Response(JSON.stringify({ peers: [peer("a.example")] }), { status: 200 });
      }
      return popOK(voucher("mvm-x"));
    });

    await Promise.all(Array.from({ length: 100 }, () => popVoucher("https://cell", SECRET, mintToken, waitUntil)));
    await new Promise((r) => setTimeout(r, 5));

    const discoveries = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/internal/pool/cache-peers"),
    );
    expect(discoveries.length).toBe(1);
  });

  // Rotation. The control plane publishes the replacement before retiring the
  // incumbent, and the edge must pick it up from ordinary traffic — never by
  // asking, which would put discovery back on a create.
  it("learns the new instance set from the pop response", async () => {
    _setPeersForTest([peer("old.example", 100)]);
    fetchMock.mockResolvedValueOnce(
      popOK(voucher("mvm-1"), [peer("old.example", 100), peer("new.example", 999)]),
    );
    await popVoucher("https://cell", SECRET, mintToken, waitUntil);

    fetchMock.mockResolvedValueOnce(popOK(voucher("mvm-2")));
    await popVoucher("https://cell", SECRET, mintToken, waitUntil);
    expect(String(fetchMock.mock.calls[1][0])).toContain("new.example");
  });

  it("prefers the instance furthest from retirement", async () => {
    _setPeersForTest([peer("soon.example", 10), peer("later.example", 10_000)]);
    fetchMock.mockResolvedValue(popOK(voucher("mvm-1")));
    await popVoucher("https://cell", SECRET, mintToken, waitUntil);
    expect(String(fetchMock.mock.calls[0][0])).toContain("later.example");
  });

  // An empty instance is not a broken one — it stays in the list, because the
  // control plane is about to refill it.
  it("falls through to the next instance when one is stocked out", async () => {
    _setPeersForTest([peer("a.example", 999), peer("b.example", 998)]);
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(popOK(voucher("mvm-2")));

    const got = await popVoucher("https://cell", SECRET, mintToken, waitUntil);
    expect(got?.voucher.microvmID).toBe("mvm-2");
    expect(got?.tries).toBe(2);
  });

  it("returns null when every instance is empty, so the caller falls back", async () => {
    _setPeersForTest([peer("a.example", 999), peer("b.example", 998)]);
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    expect(await popVoucher("https://cell", SECRET, mintToken, waitUntil)).toBeNull();
  });

  // A 502 means the box is gone (rotation raced us). Leaving it at the head of
  // the list would make every subsequent create pay a timeout to rediscover it.
  it("drops an instance that is gone instead of retrying it forever", async () => {
    _setPeersForTest([peer("dead.example", 999), peer("live.example", 998)]);
    fetchMock
      .mockResolvedValueOnce(new Response("gone", { status: 502 }))
      .mockResolvedValueOnce(popOK(voucher("mvm-2")));
    await popVoucher("https://cell", SECRET, mintToken, waitUntil);

    fetchMock.mockResolvedValue(popOK(voucher("mvm-3")));
    await popVoucher("https://cell", SECRET, mintToken, waitUntil);
    const targets = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(targets.filter((t) => t.includes("dead.example")).length).toBe(1);
  });

  // Every failure here has to become a fall-through. A throw would take down a
  // create that the colo book or the control plane could still have served.
  it("never throws when the transport fails", async () => {
    _setPeersForTest([peer("a.example")]);
    fetchMock.mockRejectedValue(new Error("connection reset"));
    await expect(popVoucher("https://cell", SECRET, mintToken, waitUntil)).resolves.toBeNull();
  });

  it("does not re-ask the control plane on every create when no cache exists", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ peers: [] }), { status: 200 }));
    await popVoucher("https://cell", SECRET, mintToken, waitUntil);
    await new Promise((r) => setTimeout(r, 5));
    await popVoucher("https://cell", SECRET, mintToken, waitUntil);
    await popVoucher("https://cell", SECRET, mintToken, waitUntil);
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  it("sends the shared secret and the proxy headers", async () => {
    _setPeersForTest([peer("a.example")]);
    fetchMock.mockResolvedValue(popOK(voucher("mvm-1")));
    await popVoucher("https://cell", SECRET, mintToken, waitUntil);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const h = init.headers as Record<string, string>;
    expect(h["X-osb-cache-auth"]).toBe(SECRET);
    expect(h["X-aws-proxy-auth"]).toBe("pt");
    expect(h["X-aws-proxy-port"]).toBe("8079");
  });
});
