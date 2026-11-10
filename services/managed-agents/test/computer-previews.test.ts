import { describe, expect, it } from "vitest";

import type { CalvinGatewayToHost } from "../src/computer/protocol.js";
import {
  CloudflareTunnels,
  ComputerPreviews,
  PREVIEW_NAME_LIMIT,
  PREVIEW_WAKE_LIMIT,
  PREVIEW_WAKE_WINDOW_MS,
  type PreviewNameRegistry,
  type PreviewsEnv,
  previewsConfig,
  WIRE_INGRESS_PATH,
  tunnelName,
  wireKeyFor,
} from "../src/computer/previews.js";
import { previewKey } from "../src/previews/auth.js";
import { type PreviewClaim, type PreviewRecord, claimOutcome } from "../src/previews/registry.js";
import { sqlStorage } from "./fixtures/computer-sql.js";

/**
 * Preview URLs on the computer object (work 074): the organization's tunnel,
 * made once, and names claimed in fake PreviewDurableObjects that apply the
 * real claim rule.
 */

const ORG = "org_previews";
const TUNNEL = "6ff42ae2-765d-4adf-8112-31c55c1551ef";

function fixture(options: { env?: Partial<PreviewsEnv>; tunnelFails?: number; names?: string[]; sql?: SqlStorage } = {}) {
  const registry = new Map<string, PreviewRecord>();
  const denied = new Set<string>();
  const released: string[] = [];
  const PREVIEWS = {
    getByName: (name: string): PreviewNameRegistry => ({
      claim: async (claimed: string, claim: PreviewClaim) => {
        const outcome = claimOutcome(claimed, registry.get(name) ?? null, denied.has(name), claim, 1);
        if (outcome.ok) registry.set(name, outcome.record);
        return outcome;
      },
      release: async (organizationId: string) => {
        if (registry.get(name)?.organizationId !== organizationId) return false;
        registry.delete(name);
        released.push(name);
        return true;
      },
    }),
  };
  const env: PreviewsEnv = {
    PREVIEWS,
    PREVIEW_PLATFORM_KEY: "platform-key",
    PREVIEW_CF_API_TOKEN: "cf-token",
    PREVIEW_CF_ACCOUNT_ID: "acct",
    PREVIEW_CF_ZONE_ID: "zone",
    ...options.env,
  };
  const sent: CalvinGatewayToHost[] = [];
  const ensured: string[] = [];
  let failures = options.tunnelFails ?? 0;
  const names = [...(options.names ?? [])];
  let clock = 1_800_000_000_000;
  const previews = new ComputerPreviews({
    sql: options.sql ?? sqlStorage(),
    env,
    organizationId: () => ORG,
    seal: async (value, context) => `sealed(${context}):${value}`,
    unseal: async (sealed, context) => {
      const prefix = `sealed(${context}):`;
      if (!sealed.startsWith(prefix)) throw new Error("wrong context");
      return sealed.slice(prefix.length);
    },
    send: (command) => {
      sent.push(command);
      return true;
    },
    tunnels: () => ({
      ensure: async (name) => {
        ensured.push(name);
        if (failures-- > 0) throw new Error("Cloudflare API POST /accounts/acct/cfd_tunnel: 500");
        return { tunnelId: TUNNEL, token: "tunnel-token" };
      },
    }),
    now: () => clock,
    generateName: () => names.shift() ?? `gen-${Math.random().toString(36).slice(2, 8)}`,
  });
  return { previews, env, registry, denied, released, sent, ensured, advance: (ms: number) => void (clock += ms) };
}

const pushed = (sent: CalvinGatewayToHost[]) => sent.filter((frame) => frame.t === "previews").map((frame) => (frame as { preview: { ports: number[] } }).preview.ports);

describe("computer previews", () => {
  it("is off unless every setting and the binding are there", () => {
    expect(previewsConfig({})).toBeNull();
    expect(previewsConfig({ PREVIEW_PLATFORM_KEY: "k", PREVIEW_CF_API_TOKEN: "t", PREVIEW_CF_ACCOUNT_ID: "a", PREVIEW_CF_ZONE_ID: "z" })).toBeNull();
    const { previews } = fixture({ env: { PREVIEW_DOMAIN: "previews.test" } });
    expect(previews.config()).toMatchObject({ domain: "previews.test", tunnelDomain: "t.previews.test", environment: "development" });
  });

  it("makes the tunnel once, seals its token, and gives the host its token, key and ports", async () => {
    const { previews, sent, ensured } = fixture();
    expect(await previews.hostConfig()).toBeNull();
    const [a, b] = await Promise.all([previews.ensureTunnel(), previews.ensureTunnel()]);
    expect([a, b]).toEqual([true, true]);
    expect(ensured).toEqual([await tunnelName("development", ORG)]);
    expect(ensured[0]).toMatch(/^oc-preview-development-[0-9a-f]{32}$/);
    const expected = { tunnelToken: "tunnel-token", key: await previewKey("platform-key", TUNNEL), ports: [] };
    expect(await previews.hostConfig()).toEqual(expected);
    // The host hears as soon as the tunnel exists.
    expect(sent).toEqual([{ t: "previews", preview: expected }]);
    expect(await previews.ensureTunnel()).toBe(true);
    expect(ensured).toHaveLength(1);
  });

  it("registers a port under a generated name, pushes the allow-list before answering, and returns the same name again", async () => {
    const { previews, registry, sent } = fixture({ names: ["amber-owl-k3x9"] });
    const result = await previews.register("T1:C1:1.1", { port: 5173 });
    expect(result).toEqual({ url: "https://amber-owl-k3x9.opencomputer.app", name: "amber-owl-k3x9", port: 5173 });
    expect(registry.get("amber-owl-k3x9")).toMatchObject({ organizationId: ORG, tunnelId: TUNNEL, port: 5173, createdBy: "T1:C1:1.1" });
    expect(pushed(sent).at(-1)).toEqual([5173]);
    expect(await previews.register("T1:C1:1.1", { port: 5173 })).toEqual(result);
    expect(previews.registered("amber-owl-k3x9")).toBe(true);
  });

  it("makes the tunnel on the first call when the hello's attempt failed, and says so when it fails again", async () => {
    const { previews } = fixture({ tunnelFails: 2 });
    expect(await previews.ensureTunnel()).toBe(false);
    await expect(previews.register("s", { port: 3000 })).rejects.toThrow("still being set up");
    expect((await previews.register("s", { port: 3000 })).port).toBe(3000);
  });

  it("retries a generated name another organization holds", async () => {
    const { previews, registry } = fixture({ names: ["taken-name-0000", "free-name-0001"] });
    registry.set("taken-name-0000", { name: "taken-name-0000", organizationId: "org_other", tunnelId: "t", port: 3000, createdBy: "x", createdAt: 1, lastHitAt: 1 });
    expect((await previews.register("s", { port: 3000 })).name).toBe("free-name-0001");
  });

  it("takes a chosen name, refuses a taken, denied or invalid one or a second name for a port, and moves a name between its own ports", async () => {
    const { previews, registry, denied, released, sent } = fixture({ names: ["first-name-0000"] });
    registry.set("taken", { name: "taken", organizationId: "org_other", tunnelId: "t", port: 3000, createdBy: "x", createdAt: 1, lastHitAt: 1 });
    denied.add("blocked");
    await expect(previews.register("s", { port: 3000, name: "taken" })).rejects.toThrow("The preview name taken is taken");
    await expect(previews.register("s", { port: 3000, name: "blocked" })).rejects.toThrow("cannot be used");
    await expect(previews.register("s", { port: 3000, name: "-bad" })).rejects.toThrow("cannot be a preview name");
    await expect(previews.register("s", { port: 3000, name: "admin" })).rejects.toThrow("cannot be a preview name");
    await expect(previews.register("s", { port: 22 })).rejects.toThrow("Port 22 cannot be previewed");
    await expect(previews.register("s", { port: 7070 })).rejects.toThrow("Port 7070 cannot be previewed");

    // A port that has a name keeps it: another name is refused, naming the current URL.
    await previews.register("s", { port: 3000 });
    await expect(previews.register("s", { port: 3000, name: "my-app" })).rejects.toThrow(
      "Port 3000 already has https://first-name-0000.opencomputer.app; unpreview first-name-0000 first",
    );
    await previews.unregister("first-name-0000");
    expect(released).toEqual(["first-name-0000"]);
    expect((await previews.register("s", { port: 3000, name: "My-App" })).url).toBe("https://my-app.opencomputer.app");

    // The name moves to another port; the old port is no longer forwarded.
    expect(await previews.register("s", { port: 4000, name: "my-app" })).toEqual({ url: "https://my-app.opencomputer.app", name: "my-app", port: 4000 });
    expect(registry.get("my-app")?.port).toBe(4000);
    expect(pushed(sent).at(-1)).toEqual([4000]);
  });

  it("releases a name, and refuses one it does not hold", async () => {
    const { previews, registry, sent } = fixture({ names: ["amber-owl-k3x9"] });
    await previews.register("s", { port: 5173 });
    expect(await previews.unregister(" Amber-Owl-K3X9 ")).toEqual({ url: "", name: "amber-owl-k3x9", port: 0 });
    expect(registry.has("amber-owl-k3x9")).toBe(false);
    expect(pushed(sent).at(-1)).toEqual([]);
    await expect(previews.unregister("amber-owl-k3x9")).rejects.toThrow("No preview named amber-owl-k3x9");
  });

  it("holds at most the limit, and two registrations at once cannot both pass it", async () => {
    const { previews } = fixture();
    for (let port = 3000; port < 3000 + PREVIEW_NAME_LIMIT - 1; port++) await previews.register("s", { port });
    const results = await Promise.allSettled([previews.register("s", { port: 5000 }), previews.register("s", { port: 5001 })]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(String((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)).toContain("already has 50 preview URLs");
    // Re-pointing a name it holds is not a new one.
    expect((await previews.register("s", { port: 3000 })).port).toBe(3000);
  });

  it("allows a few wakes an hour", async () => {
    const { previews, advance } = fixture();
    expect(previews.allowWake()).toBe(false);
    await previews.ensureTunnel();
    for (let i = 0; i < PREVIEW_WAKE_LIMIT; i++) expect(previews.allowWake()).toBe(true);
    expect(previews.allowWake()).toBe(false);
    advance(PREVIEW_WAKE_WINDOW_MS);
    expect(previews.allowWake()).toBe(true);
  });

  it("refuses everything while the feature is off", async () => {
    const { previews } = fixture({ env: { PREVIEW_CF_API_TOKEN: undefined } });
    expect(await previews.ensureTunnel()).toBe(false);
    await expect(previews.register("s", { port: 3000 })).rejects.toThrow("not available on this computer");
  });
});

describe("the tunnel's wire hostname (work 084)", () => {
  it("is off without WIRE_CF_ZONE_ID, and under w.opencomputer.dev unless set", () => {
    expect(fixture().previews.config()?.wire).toBeNull();
    expect(fixture({ env: { WIRE_CF_ZONE_ID: "wzone" } }).previews.config()?.wire).toEqual({ zoneId: "wzone", tunnelDomain: "w.opencomputer.dev" });
    expect(fixture({ env: { WIRE_CF_ZONE_ID: "wzone", WIRE_TUNNEL_DOMAIN: "w.example" } }).previews.config()?.wire).toEqual({ zoneId: "wzone", tunnelDomain: "w.example" });
  });

  it("is applied to an existing tunnel on the next ensure, once", async () => {
    const { previews, env, ensured } = fixture();
    await previews.ensureTunnel();
    expect(ensured).toHaveLength(1);
    env.WIRE_CF_ZONE_ID = "wzone";
    expect(await previews.ensureTunnel()).toBe(true);
    expect(ensured).toHaveLength(2);
    expect(await previews.ensureTunnel()).toBe(true);
    expect(ensured).toHaveLength(2);
  });

  it("keeps an existing tunnel usable when applying it fails, and tries again on the next ensure", async () => {
    // A tunnel made before the wire, now with the wire on and Cloudflare failing once.
    const sql = sqlStorage();
    const { previews, ensured } = fixture({ sql, tunnelFails: 1, env: { WIRE_CF_ZONE_ID: "wzone" } });
    sql.exec("INSERT INTO preview_tunnel (id, tunnel_id, token, created_at) VALUES (1, ?, ?, 1)", TUNNEL, `sealed(${ORG}:${TUNNEL}):tunnel-token`);
    expect(await previews.ensureTunnel()).toBe(true);
    expect(await previews.hostConfig()).toMatchObject({ tunnelToken: "tunnel-token" });
    expect(await previews.ensureTunnel()).toBe(true);
    expect(await previews.ensureTunnel()).toBe(true);
    expect(ensured).toHaveLength(2);
  });

  it("adds its column to a tunnel table made before it", async () => {
    const sql = sqlStorage();
    sql.exec(`CREATE TABLE preview_tunnel (id INTEGER PRIMARY KEY CHECK (id = 1), tunnel_id TEXT NOT NULL, token TEXT NOT NULL,
      wake_window_start INTEGER NOT NULL DEFAULT 0, wakes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);`);
    sql.exec("INSERT INTO preview_tunnel (id, tunnel_id, token, created_at) VALUES (1, ?, ?, 1)", TUNNEL, `sealed(${ORG}:${TUNNEL}):tunnel-token`);
    const { previews, ensured } = fixture({ sql, env: { WIRE_CF_ZONE_ID: "wzone" } });
    expect((await previews.hostConfig())?.tunnelToken).toBe("tunnel-token");
    expect(await previews.ensureTunnel()).toBe(true);
    expect(ensured).toHaveLength(1);
  });

  it("gives the lead the computer's wire key: its preview key", async () => {
    expect(await wireKeyFor({ PREVIEW_PLATFORM_KEY: "platform-key" }, TUNNEL)).toBe(await previewKey("platform-key", TUNNEL));
    expect(await wireKeyFor({}, TUNNEL)).toBeNull();
  });
});

const CF_ENV: PreviewsEnv = { PREVIEWS: {} as never, PREVIEW_PLATFORM_KEY: "k", PREVIEW_CF_API_TOKEN: "cf-token", PREVIEW_CF_ACCOUNT_ID: "acct", PREVIEW_CF_ZONE_ID: "zone" };

describe("the Cloudflare tunnel calls", () => {
  it("creates a remotely managed tunnel, points its ingress and record at the host proxy, and reads its token", async () => {
    const calls: { method: string; url: string; body?: any }[] = [];
    const answers: Record<string, unknown> = {
      "GET /accounts/acct/cfd_tunnel": [],
      "POST /accounts/acct/cfd_tunnel": { id: TUNNEL },
      [`PUT /accounts/acct/cfd_tunnel/${TUNNEL}/configurations`]: {},
      "GET /zones/zone/dns_records": [],
      "POST /zones/zone/dns_records": { id: "rec" },
      [`GET /accounts/acct/cfd_tunnel/${TUNNEL}/token`]: "tunnel-token",
    };
    const config = previewsConfig(CF_ENV)!;
    const api = new CloudflareTunnels(config, async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname.replace("/client/v4", "");
      calls.push({ method: init!.method!, url: `${path}${url.search}`, body: init!.body ? JSON.parse(String(init!.body)) : undefined });
      expect(new Headers(init!.headers).get("authorization")).toBe("Bearer cf-token");
      return Response.json({ success: true, result: answers[`${init!.method} ${path}`] });
    });
    expect(await api.ensure("oc-preview-development-abc")).toEqual({ tunnelId: TUNNEL, token: "tunnel-token" });
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /accounts/acct/cfd_tunnel?name=oc-preview-development-abc&is_deleted=false",
      "POST /accounts/acct/cfd_tunnel",
      `PUT /accounts/acct/cfd_tunnel/${TUNNEL}/configurations`,
      `GET /zones/zone/dns_records?type=CNAME&name=${TUNNEL}.t.opencomputer.app`,
      "POST /zones/zone/dns_records",
      `GET /accounts/acct/cfd_tunnel/${TUNNEL}/token`,
    ]);
    expect(calls[1]!.body).toEqual({ name: "oc-preview-development-abc", config_src: "cloudflare" });
    expect(calls[2]!.body.config.ingress).toEqual([
      { hostname: `${TUNNEL}.t.opencomputer.app`, service: "http://127.0.0.1:7070" },
      { service: "http_status:404" },
    ]);
    expect(calls[4]!.body).toMatchObject({ type: "CNAME", name: `${TUNNEL}.t.opencomputer.app`, content: `${TUNNEL}.cfargotunnel.com`, proxied: true });
  });

  it("adds the wire hostname for the relay, before the catch-all, with its record in the wire zone", async () => {
    const calls: { method: string; url: string; body?: any }[] = [];
    const config = previewsConfig({ ...CF_ENV, WIRE_CF_ZONE_ID: "wzone" })!;
    const api = new CloudflareTunnels(config, async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname.replace("/client/v4", "");
      calls.push({ method: init!.method!, url: `${path}${url.search}`, body: init!.body ? JSON.parse(String(init!.body)) : undefined });
      if (path.endsWith("/token")) return Response.json({ success: true, result: "tunnel-token" });
      if (init!.method === "GET") return Response.json({ success: true, result: path.includes("dns") ? [] : [{ id: TUNNEL }] });
      return Response.json({ success: true, result: {} });
    });
    await api.ensure("n");
    const wire = `${TUNNEL}.w.opencomputer.dev`;
    expect(calls.find((call) => call.url.endsWith("/configurations"))!.body.config.ingress).toEqual([
      { hostname: `${TUNNEL}.t.opencomputer.app`, service: "http://127.0.0.1:7070" },
      { hostname: wire, path: "^/(connect|files)(/|$)", service: "http://127.0.0.1:7071" },
      { service: "http_status:404" },
    ]);
    expect(WIRE_INGRESS_PATH).toBe("^/(connect|files)(/|$)");
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /accounts/acct/cfd_tunnel?name=n&is_deleted=false",
      `PUT /accounts/acct/cfd_tunnel/${TUNNEL}/configurations`,
      `GET /zones/zone/dns_records?type=CNAME&name=${TUNNEL}.t.opencomputer.app`,
      "POST /zones/zone/dns_records",
      `GET /zones/wzone/dns_records?type=CNAME&name=${wire}`,
      "POST /zones/wzone/dns_records",
      `GET /accounts/acct/cfd_tunnel/${TUNNEL}/token`,
    ]);
    expect(calls[5]!.body).toMatchObject({ type: "CNAME", name: wire, content: `${TUNNEL}.cfargotunnel.com`, proxied: true });
  });

  it("reuses an existing tunnel and record, and throws Cloudflare's error otherwise", async () => {
    const config = previewsConfig(CF_ENV)!;
    const methods: string[] = [];
    const api = new CloudflareTunnels(config, async (input, init) => {
      const path = new URL(String(input)).pathname.replace("/client/v4", "");
      methods.push(`${init!.method} ${path}`);
      if (path.endsWith("/token")) return Response.json({ success: true, result: "t" });
      if (init!.method === "GET") return Response.json({ success: true, result: [{ id: path.includes("dns") ? "rec" : TUNNEL }] });
      return Response.json({ success: true, result: {} });
    });
    await api.ensure("n");
    expect(methods).not.toContain("POST /accounts/acct/cfd_tunnel");
    expect(methods).toContain("PUT /zones/zone/dns_records/rec");

    const failing = new CloudflareTunnels(config, async () => Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 }));
    await expect(failing.ensure("n")).rejects.toThrow("Cloudflare API GET /accounts/acct/cfd_tunnel: 403 (10000 Authentication error)");
  });
});
