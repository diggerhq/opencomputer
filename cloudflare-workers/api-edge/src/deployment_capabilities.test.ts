import { afterEach, describe, expect, it, vi } from "vitest";

import { capabilityDeclarationsFromArtifact } from "./deployment_capabilities";
import { proxyManagedAgents } from "./managed_agents";

const env = {
  OC_MANAGED_AGENTS_SECRET: "test-secret",
  MANAGED_AGENTS_API_URL: "https://managedagents.test",
};
const caller = { orgID: "org_test", userID: "user_test" };

function artifact(files: Array<{ path: string; content?: string }>): string {
  return JSON.stringify({
    version: 1,
    files: files.map((file) => ({
      path: file.path,
      content: btoa(file.content ?? ""),
    })),
  });
}

const reactive = {
  version: 2,
  entry: "../agent.js",
  tools: ["send_email", "lookup_customer"],
  gatedTools: ["send_email"],
  resultTool: { id: "report", output: { type: "object" } },
  subagents: ["researcher"],
  mcpServers: ["docs", "search"],
  mcpServerDefinitions: [
    { id: "docs", url: "https://mcp.example.com/sse?token=SHOULD_NOT_LEAK" },
  ],
  models: [{ provider: "openrouter", model: "anthropic/claude-sonnet-5" }],
};

const manifest = {
  schema: "opencomputer.deployment-capabilities/v1",
  projectId: "prj_1",
  agentId: "hello-world",
  deploymentId: "hello-world:abc",
  alias: "development",
  sourceDigest: "sha256:abc",
  runtimeImageDigest: "sha256:def",
  runtimeImageVersion: "7",
  runtimeMode: "microvm",
  models: [],
  defaultModel: null,
  tools: [{ id: "lookup_customer", gated: false, declaredBy: "agent" }],
  resultSchemas: [],
  skills: [{ name: "triage" }],
  mcpServers: [],
  subagents: [],
  connections: [],
  memory: [],
  regions: [{ scope: "runtime", region: "us-east-1" }],
  lifecycleCapabilities: { runtime: "microvm" },
  egressCapabilities: { brokered: true },
  createdAt: "2026-09-25T00:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("deployment capability declarations", () => {
  it("reads compiler metadata and skills from an artifact without evaluating code", () => {
    const source = artifact([
      { path: "agent.js", content: "throw new Error('never run')" },
      { path: ".opencomputer/reactive.json", content: JSON.stringify(reactive) },
      { path: ".opencode/skills/triage/SKILL.md", content: "# triage" },
      { path: ".opencode/skills/escalate/SKILL.md", content: "# escalate" },
      { path: ".opencode/skills/escalate/notes.md", content: "not a skill" },
    ]);
    expect(capabilityDeclarationsFromArtifact(source)).toEqual({
      tools: [{ id: "lookup_customer" }, { id: "send_email", gated: true }],
      resultSchemas: [{ toolId: "report", schema: { type: "object" } }],
      skills: [
        { name: "escalate", path: ".opencode/skills/escalate" },
        { name: "triage", path: ".opencode/skills/triage" },
      ],
      mcpServers: [
        { id: "docs", origin: "https://mcp.example.com" },
        { id: "search" },
      ],
      subagents: ["researcher"],
    });
    expect(
      capabilityDeclarationsFromArtifact(artifact([{ path: "agent.js" }])),
    ).toEqual({
      tools: [],
      resultSchemas: [],
      skills: [],
      mcpServers: [],
      subagents: [],
    });
    expect(capabilityDeclarationsFromArtifact("not json")).toBeNull();
  });

  it("forwards the declarations with the deployment registration", async () => {
    const source = artifact([
      { path: ".opencomputer/reactive.json", content: JSON.stringify(reactive) },
      { path: ".opencode/skills/triage/SKILL.md", content: "# triage" },
    ]);
    const digestBytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(source),
    );
    const digest = Array.from(new Uint8Array(digestBytes))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          uploadUrl: "https://uploads.test/signed",
          method: "PUT",
          headers: {},
          artifact: { bucket: "b", key: "k", digest, size: source.length },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(
        Response.json(
          {
            id: `hello-world:${digest}`,
            agentId: "hello-world",
            alias: "development",
            channels: [],
            connections: [],
            createdAt: "2026-09-25T00:00:00.000Z",
          },
          { status: 201 },
        ),
      );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await proxyManagedAgents(
      new Request("https://app.opencomputer.dev/api/managed-agents/deployments", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agentId: "hello-world",
          alias: "development",
          source: {
            digest,
            size: source.length,
            contentType: "application/vnd.opencomputer.agent+json",
            body: source,
          },
        }),
      }),
      env,
      caller,
      "/api/managed-agents",
    );
    expect(response.status).toBe(201);
    const registration = JSON.parse(
      String((fetchSpy.mock.calls[2]?.[1] as RequestInit).body),
    );
    expect(registration.capabilities).toEqual({
      tools: [{ id: "lookup_customer" }, { id: "send_email", gated: true }],
      resultSchemas: [{ toolId: "report", schema: { type: "object" } }],
      skills: [{ name: "triage", path: ".opencode/skills/triage" }],
      mcpServers: [
        { id: "docs", origin: "https://mcp.example.com" },
        { id: "search" },
      ],
      subagents: ["researcher"],
    });
    expect(JSON.stringify(registration)).not.toContain("SHOULD_NOT_LEAK");
  });
});

describe("deployment capability routes", () => {
  it("serves the manifest with its digest and forwards the digest headers", async () => {
    const fetchSpy = vi.fn(async () =>
      Response.json(
        {
          manifest: { ...manifest, imageArn: "arn:aws:private", accountId: "acct" },
          manifestDigest: "sha256:0123",
        },
        {
          headers: {
            etag: '"sha256:0123"',
            "x-opencomputer-manifest-digest": "sha256:0123",
          },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/deployments/hello-world%3Aabc/capabilities",
      ),
      env,
      caller,
      "/api/managed-agents",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"sha256:0123"');
    expect(response.headers.get("x-opencomputer-manifest-digest")).toBe("sha256:0123");
    const [target] = fetchSpy.mock.calls[0] as unknown as [URL];
    expect(String(target)).toBe(
      "https://managedagents.test/v1/deployments/hello-world%3Aabc/capabilities",
    );
    const body = await response.json();
    expect(body).toEqual({ manifest, manifestDigest: "sha256:0123" });
    expect(JSON.stringify(body)).not.toMatch(/arn:aws|accountId/);
  });

  it("runs readiness through the public receipt shape only", async () => {
    const fetchSpy = vi.fn(async () =>
      Response.json({
        schema: "opencomputer.deployment-readiness/v1",
        projectId: "prj_1",
        agentId: "hello-world",
        deploymentId: "hello-world:abc",
        sessionId: null,
        environment: "development",
        checkedAt: "2026-09-25T01:00:00.000Z",
        manifestDigest: "sha256:0123",
        probe: { mode: "platform", executesAgentCode: false, contactsCustomerTargets: false },
        checks: [
          {
            id: "model.route",
            status: "pass",
            required: true,
            summary: "Managed model access is configured",
            detail: { access: "managed" },
            checkedAt: "2026-09-25T01:00:00.000Z",
            durationMs: 3,
            internalTrace: "should-not-leak",
          },
        ],
        ready: true,
        accountId: "acct",
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const response = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/deployments/hello-world%3Aabc/readiness",
        { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      ),
      env,
      caller,
      "/api/managed-agents",
    );
    expect(response.status).toBe(200);
    const [, init] = fetchSpy.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.method).toBe("POST");
    const body = await response.json();
    expect(body).toEqual({
      schema: "opencomputer.deployment-readiness/v1",
      projectId: "prj_1",
      agentId: "hello-world",
      deploymentId: "hello-world:abc",
      sessionId: null,
      environment: "development",
      checkedAt: "2026-09-25T01:00:00.000Z",
      manifestDigest: "sha256:0123",
      probe: { mode: "platform", executesAgentCode: false, contactsCustomerTargets: false },
      checks: [
        {
          id: "model.route",
          status: "pass",
          required: true,
          summary: "Managed model access is configured",
          detail: { access: "managed" },
          checkedAt: "2026-09-25T01:00:00.000Z",
          durationMs: 3,
        },
      ],
      ready: true,
    });
  });

  it("rejects readiness on GET and capabilities on POST", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const readiness = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/deployments/x/readiness",
      ),
      env,
      caller,
      "/api/managed-agents",
    );
    const capabilities = await proxyManagedAgents(
      new Request(
        "https://app.opencomputer.dev/api/managed-agents/deployments/x/capabilities",
        { method: "POST" },
      ),
      env,
      caller,
      "/api/managed-agents",
    );
    expect(readiness.status).toBe(404);
    expect(capabilities.status).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
