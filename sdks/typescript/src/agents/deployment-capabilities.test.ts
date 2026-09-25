import { describe, expect, it } from "vitest";
import { OpenComputer } from "./client.js";
import { OpenComputerError } from "./errors.js";

interface Call { method: string; path: string; body?: unknown }

function fakeApi(routes: Record<string, (call: Call) => Response>) {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? "GET", path: `${url.pathname}${url.search}` };
    if (typeof init?.body === "string") call.body = JSON.parse(init.body) as unknown;
    calls.push(call);
    const route = routes[`${call.method} ${url.pathname}`];
    if (route) return route(call);
    return Response.json({ error: { code: "not_found", message: "no route" } }, { status: 404 });
  };
  return { calls, fetch, last: () => calls[calls.length - 1] };
}

const manifest = {
  schema: "opencomputer.deployment-capabilities/v1",
  projectId: "prj_1",
  agentId: "worker",
  deploymentId: "worker:abc",
  sourceDigest: "sha256:abc",
  runtimeImageDigest: "sha256:def",
  models: [{ provider: "openrouter", model: "anthropic/claude-sonnet-5" }],
  tools: [{ id: "lookup_customer" }],
  resultSchemas: [],
  skills: [{ name: "triage" }],
  mcpServers: [],
  connections: [{ id: "github", kind: "github-app", policy: { permissions: { contents: "read" } } }],
  memory: [],
  regions: [{ scope: "runtime", region: "us-east-1" }],
  lifecycleCapabilities: {},
  egressCapabilities: {},
  createdAt: "t",
};

const receipt = {
  schema: "opencomputer.deployment-readiness/v1",
  projectId: "prj_1",
  agentId: "worker",
  deploymentId: "worker:abc",
  sessionId: null,
  environment: "development",
  checkedAt: "t",
  manifestDigest: "sha256:0123",
  probe: { mode: "platform", executesAgentCode: false, contactsCustomerTargets: false },
  checks: [
    { id: "model.route", status: "pass", required: true, summary: "ok", detail: {}, checkedAt: "t", durationMs: 1 },
  ],
  ready: true,
};

describe("deployments.capabilities / deployments.readiness", () => {
  it("fetches the manifest with its digest and posts a readiness probe", async () => {
    const api = fakeApi({
      "GET /api/managed-agents/deployments/worker%3Aabc/capabilities": () =>
        Response.json({ manifest, manifestDigest: "sha256:0123" }),
      "POST /api/managed-agents/deployments/worker%3Aabc/readiness": () => Response.json(receipt),
    });
    const oc = new OpenComputer({ apiKey: "osb_test", fetch: api.fetch });

    const capabilities = await oc.deployments.capabilities("worker:abc");
    expect(capabilities).toEqual({ manifest, manifestDigest: "sha256:0123" });
    expect(api.last().path).toBe("/api/managed-agents/deployments/worker%3Aabc/capabilities");

    const readiness = await oc.deployments.readiness("worker:abc");
    expect(readiness).toEqual(receipt);
    expect(api.last()).toMatchObject({ method: "POST", path: "/api/managed-agents/deployments/worker%3Aabc/readiness" });
  });

  it("rejects a manifest or receipt that does not match the documented shape", async () => {
    const api = fakeApi({
      "GET /api/managed-agents/deployments/dep_1/capabilities": () =>
        Response.json({ manifest: { ...manifest, tools: "lookup_customer" }, manifestDigest: "sha256:0123" }),
      "POST /api/managed-agents/deployments/dep_1/readiness": () => Response.json({ ...receipt, checks: undefined }),
    });
    const oc = new OpenComputer({ apiKey: "osb_test", fetch: api.fetch });
    await expect(oc.deployments.capabilities("dep_1")).rejects.toBeInstanceOf(OpenComputerError);
    await expect(oc.deployments.readiness("dep_1")).rejects.toBeInstanceOf(OpenComputerError);
  });
});
