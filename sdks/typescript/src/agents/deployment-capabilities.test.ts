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

const sha = (fill: string) => `sha256:${fill.repeat(64)}`;
const manifestDigest = sha("0");

const manifest = {
  schema: "opencomputer.deployment-capabilities/v1",
  projectId: "prj_1",
  agentId: "worker",
  deploymentId: "worker:abc",
  sourceDigest: sha("a"),
  runtimeImageDigest: sha("d"),
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
  manifestDigest,
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
        Response.json({ manifest, manifestDigest }),
      "POST /api/managed-agents/deployments/worker%3Aabc/readiness": () => Response.json(receipt),
    });
    const oc = new OpenComputer({ apiKey: "osb_test", fetch: api.fetch });

    const capabilities = await oc.deployments.capabilities("worker:abc");
    expect(capabilities).toEqual({ manifest, manifestDigest });
    expect(api.last().path).toBe("/api/managed-agents/deployments/worker%3Aabc/capabilities");

    const readiness = await oc.deployments.readiness("worker:abc");
    expect(readiness).toEqual(receipt);
    expect(api.last()).toMatchObject({ method: "POST", path: "/api/managed-agents/deployments/worker%3Aabc/readiness" });
  });

  it("rejects a manifest or receipt that does not match the documented shape", async () => {
    const badManifests: Array<Record<string, unknown>> = [
      { ...manifest, tools: "lookup_customer" },
      { ...manifest, tools: [{ name: "no id" }] },
      { ...manifest, models: [{ provider: "openrouter" }] },
      { ...manifest, resultSchemas: [{ toolId: "report" }] },
      { ...manifest, skills: [{}] },
      { ...manifest, mcpServers: [{ origin: "https://mcp.example.com" }] },
      { ...manifest, connections: [{ id: "github", kind: "github-app" }] },
      { ...manifest, memory: [{ description: "no id" }] },
      { ...manifest, regions: [{ scope: "runtime" }] },
      { ...manifest, sourceDigest: "sha256:abc" },
      { ...manifest, schema: "opencomputer.deployment-capabilities/v2" },
    ];
    const badReceipts: Array<Record<string, unknown>> = [
      { ...receipt, checks: undefined },
      { ...receipt, checks: [{ ...receipt.checks[0], status: "maybe" }] },
      { ...receipt, checks: [{ ...receipt.checks[0], detail: "free text" }] },
      { ...receipt, probe: { mode: "platform" } },
      { ...receipt, environment: "staging" },
      { ...receipt, manifestDigest: "sha256:0123" },
    ];
    let manifestAt = 0;
    let receiptAt = 0;
    const api = fakeApi({
      "GET /api/managed-agents/deployments/dep_1/capabilities": () =>
        Response.json({ manifest: badManifests[manifestAt++], manifestDigest }),
      "GET /api/managed-agents/deployments/dep_2/capabilities": () =>
        Response.json({ manifest, manifestDigest: "sha256:0123" }),
      "POST /api/managed-agents/deployments/dep_1/readiness": () => Response.json(badReceipts[receiptAt++]),
    });
    const oc = new OpenComputer({ apiKey: "osb_test", fetch: api.fetch });
    for (let index = 0; index < badManifests.length; index += 1) {
      await expect(oc.deployments.capabilities("dep_1"), JSON.stringify(badManifests[index])).rejects.toBeInstanceOf(
        OpenComputerError,
      );
    }
    await expect(oc.deployments.capabilities("dep_2")).rejects.toBeInstanceOf(OpenComputerError);
    for (let index = 0; index < badReceipts.length; index += 1) {
      await expect(oc.deployments.readiness("dep_1"), JSON.stringify(badReceipts[index])).rejects.toBeInstanceOf(
        OpenComputerError,
      );
    }
  });
});
