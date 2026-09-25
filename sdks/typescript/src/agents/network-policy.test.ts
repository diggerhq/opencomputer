import { describe, expect, expectTypeOf, it } from "vitest";
import { OpenComputer } from "./client.js";
import { OpenComputerError } from "./errors.js";
import type { NetworkPolicyReceipt, NetworkPolicyRevocation, SessionEvent } from "./types.js";

interface Call { method: string; path: string; headers: Record<string, string>; body?: unknown }

function fakeApi(routes: Record<string, (call: Call) => Response> = {}) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => { headers[name] = value; });
    const call: Call = { method: init?.method ?? "GET", path: `${url.pathname}${url.search}`, headers };
    if (typeof init?.body === "string") call.body = JSON.parse(init.body) as unknown;
    calls.push(call);
    const route = routes[`${call.method} ${url.pathname}`];
    if (route) return route(call);
    return Response.json({ error: { code: "not_found", message: `no route ${call.method} ${url.pathname}` } }, { status: 404 });
  };
  return { calls, fetch, last: () => calls[calls.length - 1] };
}

const oc = (api: ReturnType<typeof fakeApi>) => new OpenComputer({ apiKey: "osb_test", fetch: api.fetch });

const receipt: NetworkPolicyReceipt = {
  policyId: "npol_1",
  policyDigest: `sha256:${"ab".repeat(32)}`,
  enforcementVersion: "egress-gateway/1",
  state: "active",
  declaredAt: "t",
  installedAt: "t",
  activatedAt: "t",
  generation: 1,
  installations: 1,
  counters: { connectionsAllowed: 3, connectionsDenied: 2, dnsAllowed: 3, dnsDenied: 1, bytesIn: 10, bytesOut: 20 },
  policy: {
    version: 1,
    mode: "deny_by_default",
    destinations: [{ type: "origin", scheme: "https", hostname: "owned-target.example", port: 443, addressFamilies: ["ipv4"] }],
    exclusions: [],
    dns: { mode: "provider_resolver_only" },
  },
};

const session = {
  id: "ses_1", agentId: "worker", deploymentId: "dep_1", status: "idle", source: "api", turns: [],
  createdAt: "t", updatedAt: "t", networkPolicy: receipt,
};

describe("network policy", () => {
  it("sends networkPolicy on create as given", async () => {
    const api = fakeApi({
      "POST /api/managed-agents/sessions": () =>
        Response.json({ session: { id: "ses_1", status: "new", createdAt: "t" } }, { status: 201 }),
    });
    const networkPolicy = {
      destinations: [{ type: "origin" as const, origin: "https://owned-target.example" }],
      expiresAt: "2026-09-26T00:00:00Z",
    };
    await oc(api).sessions.create({ agentId: "worker@production", networkPolicy }, { idempotencyKey: "pentest/1" });
    expect(api.last()).toMatchObject({
      method: "POST",
      headers: { "idempotency-key": "pentest/1" },
      body: { agentId: "worker@production", networkPolicy },
    });
  });

  it("reads the receipt on a session and its digest", async () => {
    const api = fakeApi({ "GET /api/managed-agents/sessions/ses_1": () => Response.json(session) });
    const got = await oc(api).sessions.get("ses_1");
    expect(got.networkPolicy).toEqual(receipt);
    expect(got.networkPolicy?.policyDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expectTypeOf(got.networkPolicy).toEqualTypeOf<NetworkPolicyReceipt | undefined>();
  });

  it("rejects a receipt that is missing its digest as invalid_response", async () => {
    const { policyDigest: _digest, ...broken } = receipt;
    const api = fakeApi({
      "GET /api/managed-agents/sessions/ses_1": () => Response.json({ ...session, networkPolicy: broken }),
    });
    await expect(oc(api).sessions.get("ses_1")).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("revokes on the documented route and returns the closure confirmation", async () => {
    const api = fakeApi({
      "POST /api/managed-agents/sessions/ses_1/network-policy/revoke": (call) =>
        Response.json({
          networkPolicy: { ...receipt, state: "revoked", revokedAt: "t2", revokeReason: (call.body as { reason: string }).reason },
          changed: true,
          enforcement: { closed: true, method: "supervisor", generation: 1 },
        }),
    });
    const revoked = await oc(api).sessions.revokeNetworkPolicy("ses_1", { reason: "window closed" });
    expectTypeOf(revoked).toEqualTypeOf<NetworkPolicyRevocation>();
    expect(revoked.changed).toBe(true);
    expect(revoked.enforcement).toEqual({ closed: true, method: "supervisor", generation: 1 });
    expect(revoked.networkPolicy.state).toBe("revoked");
    expect(revoked.networkPolicy.revokeReason).toBe("window closed");
    expect(api.last()).toMatchObject({
      method: "POST",
      path: "/api/managed-agents/sessions/ses_1/network-policy/revoke",
      body: { reason: "window closed" },
    });
    await oc(api).sessions.revokeNetworkPolicy("ses_1");
    expect(api.last().body).toEqual({});
  });

  it("surfaces egress_policy_required for a session without a policy", async () => {
    const api = fakeApi({
      "POST /api/managed-agents/sessions/ses_2/network-policy/revoke": () =>
        Response.json({ error: { code: "egress_policy_required", message: "The session has no network policy" } }, { status: 404 }),
    });
    const failure = await oc(api).sessions.revokeNetworkPolicy("ses_2").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(OpenComputerError);
    expect(failure).toMatchObject({ status: 404, code: "egress_policy_required" });
  });

  it("types the network events on the session log", async () => {
    const events = [
      { seq: 1, type: "network.policy.applied", data: { policyId: "npol_1", policyDigest: receipt.policyDigest, state: "active", enforcementVersion: "egress-gateway/1", generation: 1, installations: 1 } },
      { seq: 2, type: "network.egress.denied", data: { policyDigest: receipt.policyDigest, generation: 1, reason: "destination_not_allowed", protocol: "tcp", scheme: "https", hostname: "evil.example", port: 443 } },
      { seq: 3, type: "network.policy.revoked", data: { policyId: "npol_1", policyDigest: receipt.policyDigest, state: "revoked", reason: "window closed", generation: 1 } },
    ];
    const api = fakeApi({ "GET /api/managed-agents/sessions/ses_1/events": () => Response.json({ events }) });
    const log = await oc(api).sessions.events.list("ses_1");
    expect(log.map((event) => event.type)).toEqual(["network.policy.applied", "network.egress.denied", "network.policy.revoked"]);
    const denied = log[1] as Extract<SessionEvent, { type: "network.egress.denied" }>;
    expect(denied.data.reason).toBe("destination_not_allowed");
    expect(denied.data.hostname).toBe("evil.example");
  });
});
