import { describe, expect, it } from "vitest";

import { PREVIEW_SIGNATURE_TTL_MS, previewKey, signPreview, verifyPreview } from "../src/previews/auth.js";
import { RESERVED_NAMES, WORD_LIST_SIZES, generatePreviewName, previewHost, validPreviewName } from "../src/previews/names.js";
import { WAKE_PATH } from "../src/previews/pages.js";
import { type PreviewClaim, type PreviewRecord, type PreviewResolution, claimOutcome } from "../src/previews/registry.js";
import { type PreviewComputerState, type PreviewEnv, createPreviewHandler, visitorHeaders } from "../src/previews/worker.js";

const KEY = "test-preview-platform-key";
const claim: PreviewClaim = { organizationId: "org_a", tunnelId: "6ff42ae2-765d-4adf-8112-31c55c1551ef", port: 5173, createdBy: "C1:1.2" };
const record: PreviewRecord = { name: "amber-owl-k3x9", ...claim, createdAt: 1, lastHitAt: 1 };

describe("preview names", () => {
  it("accepts one DNS label and refuses reserved and malformed ones", () => {
    expect(validPreviewName("my-app")).toBe(true);
    expect(validPreviewName("a")).toBe(true);
    for (const name of ["", "-a", "a-", "A", "a.b", "a_b", "xn--abc", "a".repeat(64), "www", "t", "api"]) {
      expect(validPreviewName(name), name).toBe(false);
    }
    expect(RESERVED_NAMES.has("www")).toBe(true);
  });

  it("reads the name from a host on the preview domain only", () => {
    expect(previewHost("my-app.opencomputer.app")).toEqual({ kind: "preview", name: "my-app" });
    expect(previewHost("My-App.OpenComputer.app:443")).toEqual({ kind: "preview", name: "my-app" });
    expect(previewHost("opencomputer.app")).toEqual({ kind: "apex" });
    expect(previewHost("www.opencomputer.app")).toEqual({ kind: "apex" });
    expect(previewHost("abc.t.opencomputer.app")).toEqual({ kind: "other" });
    expect(previewHost("my-app.opencomputer.dev")).toEqual({ kind: "other" });
    expect(previewHost("evilopencomputer.app")).toEqual({ kind: "other" });
    expect(previewHost(null)).toEqual({ kind: "other" });
  });

  it("generates valid names from two 128-word lists and a four-character suffix", () => {
    expect(WORD_LIST_SIZES).toEqual({ adjectives: 128, nouns: 128 });
    const names = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const name = generatePreviewName();
      expect(validPreviewName(name), name).toBe(true);
      expect(name).toMatch(/^[a-z]+-[a-z]+-[a-z2-9]{4}$/);
      names.add(name);
    }
    expect(names.size).toBeGreaterThan(1990);
    expect(generatePreviewName((b) => b.fill(0))).toBe("amber-acorn-aaaa");
  });
});

describe("preview signature", () => {
  it("derives one key per tunnel and verifies only its own port within a minute", async () => {
    const key = await previewKey(KEY, claim.tunnelId);
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await previewKey(KEY, "other-tunnel")).not.toBe(key);
    const now = 1_800_000_000_000;
    const header = await signPreview(key, 5173, now);
    expect(header).toMatch(/^\d{13}\.[A-Za-z0-9_-]{43}$/);
    expect(await verifyPreview(key, 5173, header, now)).toBe(true);
    expect(await verifyPreview(key, 3000, header, now)).toBe(false);
    expect(await verifyPreview(await previewKey(KEY, "other-tunnel"), 5173, header, now)).toBe(false);
    expect(await verifyPreview(key, 5173, header, now + PREVIEW_SIGNATURE_TTL_MS)).toBe(false);
    expect(await verifyPreview(key, 5173, header.replace(/^\d+/, String(now + 30 * 60_000)), now)).toBe(false);
    expect(await verifyPreview(key, 5173, null, now)).toBe(false);
  });
});

describe("claiming a name", () => {
  it("claims a free name, moves an owned one and refuses another organization", () => {
    const first = claimOutcome("demo", null, false, claim, 10);
    expect(first).toEqual({ ok: true, record: { name: "demo", ...claim, createdAt: 10, lastHitAt: 10 } });
    if (!first.ok) throw new Error("unreachable");
    const moved = claimOutcome("demo", first.record, false, { ...claim, port: 3000 }, 20);
    expect(moved).toMatchObject({ ok: true, record: { port: 3000, createdAt: 10 } });
    expect(claimOutcome("demo", first.record, false, { ...claim, organizationId: "org_b" }, 20)).toEqual({ ok: false, error: "name_taken" });
    expect(claimOutcome("demo", null, true, claim, 20)).toEqual({ ok: false, error: "denied" });
    expect(claimOutcome("www", null, false, claim, 20)).toEqual({ ok: false, error: "invalid" });
  });

  it("refuses privileged ports, the host proxy's port and odd tunnel ids", () => {
    for (const port of [0, 80, 1023, 7070, 65536, 5173.5]) {
      expect(claimOutcome("demo", null, false, { ...claim, port }, 1), String(port)).toEqual({ ok: false, error: "invalid" });
    }
    expect(claimOutcome("demo", null, false, { ...claim, tunnelId: "../x" }, 1)).toEqual({ ok: false, error: "invalid" });
  });
});

describe("visitor headers", () => {
  it("drops the marker, adds noindex and makes domain-wide cookies host-only", () => {
    const upstream = new Headers({ "x-preview-origin": "computer", "content-type": "text/html" });
    upstream.append("set-cookie", "a=1; Path=/; Domain=.opencomputer.app; HttpOnly");
    upstream.append("set-cookie", "b=2; domain=opencomputer.app");
    upstream.append("set-cookie", "c=3; Domain=my-app.opencomputer.app");
    const headers = visitorHeaders(upstream);
    expect(headers.get("x-preview-origin")).toBeNull();
    expect(headers.get("x-robots-tag")).toBe("noindex");
    expect(headers.getSetCookie()).toEqual(["a=1; Path=/; HttpOnly", "b=2", "c=3; Domain=my-app.opencomputer.app"]);
  });
});

interface Harness {
  env: PreviewEnv;
  calls: { url: string; init: RequestInit }[];
  resolves: number;
  hits: number[];
  computerHits: number;
  states: number;
  wakes: string[];
  waits: Promise<unknown>[];
}

function harness(options: {
  resolution?: PreviewResolution;
  respond?: (url: string, init: RequestInit) => Response | Promise<Response>;
  state?: PreviewComputerState;
  wake?: "waking" | "refused";
}) {
  const h: Harness = { env: undefined as unknown as PreviewEnv, calls: [], resolves: 0, hits: [], computerHits: 0, states: 0, wakes: [], waits: [] };
  h.env = {
    PREVIEW_PLATFORM_KEY: KEY,
    PREVIEWS: {
      getByName: () => ({
        resolve: async () => {
          h.resolves++;
          return options.resolution ?? { state: "live", record };
        },
        hit: async (at) => void h.hits.push(at),
      }),
    },
    COMPUTERS: {
      getByName: () => ({
        previewState: async () => {
          h.states++;
          return options.state ?? "asleep";
        },
        wakeForPreview: async (name) => {
          h.wakes.push(name);
          return options.wake ?? "waking";
        },
        notePreviewHit: async () => void h.computerHits++,
      }),
    },
  };
  let clock = 1_800_000_000_000;
  const handle = createPreviewHandler({
    now: () => clock,
    fetch: async (input, init) => {
      h.calls.push({ url: String(input), init: init ?? {} });
      return options.respond
        ? options.respond(String(input), init ?? {})
        : new Response("app", { headers: { "x-preview-origin": "computer" } });
    },
  });
  const ctx = { waitUntil: (p: Promise<unknown>) => void h.waits.push(p) };
  return {
    h,
    advance: (ms: number) => void (clock += ms),
    request: (url: string, init?: RequestInit) => handle(new Request(url, init), h.env, ctx),
  };
}

describe("the previews Worker", () => {
  it("proxies to the computer's tunnel with the port, a valid signature and the visitor's host", async () => {
    const { h, request } = harness({});
    const response = await request("https://amber-owl-k3x9.opencomputer.app/src/main.ts?t=1", {
      headers: { "x-preview-port": "22", "x-preview-auth": "forged", cookie: "s=1" },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("app");
    expect(response.headers.get("x-robots-tag")).toBe("noindex");
    expect(response.headers.get("x-preview-origin")).toBeNull();
    const [call] = h.calls;
    expect(call!.url).toBe(`https://${claim.tunnelId}.t.opencomputer.app/src/main.ts?t=1`);
    const headers = new Headers(call!.init.headers);
    expect(headers.get("x-preview-port")).toBe("5173");
    expect(headers.get("x-preview-host")).toBe("amber-owl-k3x9.opencomputer.app");
    expect(headers.get("cookie")).toBe("s=1");
    expect(call!.init.redirect).toBe("manual");
    const key = await previewKey(KEY, claim.tunnelId);
    expect(await verifyPreview(key, 5173, headers.get("x-preview-auth"), 1_800_000_000_000)).toBe(true);
  });

  it("caches the name for ten seconds and counts a hit at most every thirty", async () => {
    const { h, request, advance } = harness({});
    await request("https://amber-owl-k3x9.opencomputer.app/");
    await request("https://amber-owl-k3x9.opencomputer.app/a.js");
    expect(h.resolves).toBe(1);
    expect(h.hits).toHaveLength(1);
    expect(h.computerHits).toBe(1);
    advance(10_001);
    await request("https://amber-owl-k3x9.opencomputer.app/");
    expect(h.resolves).toBe(2);
    expect(h.hits).toHaveLength(1);
    advance(20_000);
    await request("https://amber-owl-k3x9.opencomputer.app/");
    expect(h.hits).toHaveLength(2);
    expect(h.computerHits).toBe(2);
  });

  it("does not count error responses as activity", async () => {
    const { h, request } = harness({
      respond: () => new Response("no", { status: 404, headers: { "x-preview-origin": "computer" } }),
    });
    const response = await request("https://amber-owl-k3x9.opencomputer.app/missing");
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("no");
    expect(h.hits).toHaveLength(0);
  });

  it("passes the app's redirects through untouched", async () => {
    const { request } = harness({
      respond: () => new Response(null, { status: 302, headers: { location: "/login", "x-preview-origin": "computer" } }),
    });
    const response = await request("https://amber-owl-k3x9.opencomputer.app/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/login");
  });

  it("shows the unavailable page for free, denied and malformed names without fetching", async () => {
    for (const resolution of [{ state: "free" }, { state: "denied" }] as PreviewResolution[]) {
      const { h, request } = harness({ resolution });
      const response = await request("https://taken-name.opencomputer.app/");
      expect(response.status).toBe(404);
      expect(await response.text()).toContain("not available");
      expect(h.calls).toHaveLength(0);
    }
    const { h, request } = harness({});
    expect((await request("https://bad_name.opencomputer.app/")).status).toBe(404);
    expect((await request("https://x.t.opencomputer.app/")).status).toBe(404);
    expect(h.resolves).toBe(0);
  });

  it("serves the apex page on the apex and www", async () => {
    const { h, request } = harness({});
    for (const url of ["https://opencomputer.app/", "https://www.opencomputer.app/x"]) {
      const response = await request(url);
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain("href");
    }
    expect(h.resolves).toBe(0);
  });

  it("replaces every unmarked upstream response with our page, as a 503 so it is not mistaken for a missing name", async () => {
    for (const status of [200, 502, 404, 1033]) {
      const { request } = harness({ respond: () => new Response("cloudflare error page", { status: status > 599 ? 500 : status }) });
      const response = await request("https://amber-owl-k3x9.opencomputer.app/");
      expect(await response.text()).not.toContain("cloudflare");
      expect(response.status).toBe(503);
      expect(response.headers.get("retry-after")).toBe("5");
    }
    const { request } = harness({ respond: () => Promise.reject(new Error("network")) });
    expect((await request("https://amber-owl-k3x9.opencomputer.app/")).status).toBe(503);
  });

  it("answers our page, not a platform error, when the name's object throws", async () => {
    const broken = createPreviewHandler();
    const env = { ...harness({}).h.env, PREVIEWS: { getByName: () => ({ resolve: () => Promise.reject(new Error("reset")), hit: async () => {} }) } };
    const response = await broken(new Request("https://amber-owl-k3x9.opencomputer.app/"), env, { waitUntil() {} });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("not available");
  });

  it("renders the port-closed page from the host proxy's marked 503", async () => {
    const { h, request } = harness({
      respond: () => new Response("", { status: 503, headers: { "x-preview-origin": "computer", "x-preview-state": "closed" } }),
    });
    const response = await request("https://amber-owl-k3x9.opencomputer.app/");
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("<code>5173</code>");
    expect(h.hits).toHaveLength(0);
  });

  it("asks the computer, once per burst, which page a disconnected tunnel gets", async () => {
    const tunnelDown = () => new Response("error 1033", { status: 530 });
    const asleep = harness({ respond: tunnelDown, state: "asleep" });
    const pages = await Promise.all(
      ["/", "/a.js", "/b.css"].map((path) => asleep.request(`https://amber-owl-k3x9.opencomputer.app${path}`)),
    );
    expect(asleep.h.states).toBe(1);
    const body = await pages[0]!.text();
    expect(body).toContain("asleep");
    expect(body).toContain(`action="${WAKE_PATH}"`);
    expect(body).not.toMatch(/slack|azure|cloudflare|tunnel/i);

    const waking = harness({ respond: tunnelDown, state: "waking" });
    expect(await (await waking.request("https://amber-owl-k3x9.opencomputer.app/")).text()).toContain("Waking up");

    const gone = harness({ respond: tunnelDown, state: "gone" });
    expect((await gone.request("https://amber-owl-k3x9.opencomputer.app/")).status).toBe(404);

    // A running computer whose tunnel is down is not booting: no spinner that never ends.
    const ready = harness({ respond: tunnelDown, state: "ready" });
    const page = await ready.request("https://amber-owl-k3x9.opencomputer.app/");
    expect(page.status).toBe(503);
    expect(await page.text()).not.toContain("Waking up");
  });

  it("wakes only on a same-origin POST to the wake path", async () => {
    const { h, request } = harness({});
    const url = `https://amber-owl-k3x9.opencomputer.app${WAKE_PATH}`;
    const crossSite = await request(url, { method: "POST", headers: { origin: "https://evil.example" } });
    expect(crossSite.status).toBe(404);
    expect(h.wakes).toHaveLength(0);
    const response = await request(url, {
      method: "POST",
      headers: { origin: "https://amber-owl-k3x9.opencomputer.app", referer: "https://amber-owl-k3x9.opencomputer.app/docs/intro?tab=2" },
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/docs/intro?tab=2");
    expect(h.wakes).toEqual(["amber-owl-k3x9"]);
    expect(h.calls).toHaveLength(0);

    // A computer that is not asleep is not woken, and the computer object is not asked to.
    const awake = harness({ state: "ready" });
    expect((await awake.request(url, { method: "POST", headers: { "sec-fetch-site": "same-origin" } })).status).toBe(404);
    expect(awake.h.wakes).toHaveLength(0);

    const refused = harness({ wake: "refused" });
    const answer = await refused.request(url, { method: "POST", headers: { "sec-fetch-site": "same-origin" } });
    expect(answer.status).toBe(404);
  });

  it("refuses to proxy without the platform key", async () => {
    const { h, request } = harness({});
    delete h.env.PREVIEW_PLATFORM_KEY;
    expect((await request("https://amber-owl-k3x9.opencomputer.app/")).status).toBe(404);
    expect(h.calls).toHaveLength(0);
  });
});
