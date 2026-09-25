import assert from "node:assert/strict";
import test from "node:test";

import { OpenComputerClient } from "./api.js";
import {
  formatCapabilities,
  formatReadiness,
  runDeploymentsCommand,
} from "./deployment-commands.js";
import { CLIError } from "./errors.js";

const config = { apiUrl: "https://app.opencomputer.dev", apiKey: "test" };

const capabilities = {
  manifest: {
    schema: "opencomputer.deployment-capabilities/v1",
    projectId: "prj_1",
    agentId: "hello-world",
    deploymentId: "hello-world:abc",
    alias: "development",
    sourceDigest: "sha256:abc",
    runtimeImageDigest: "sha256:def",
    runtimeMode: "microvm",
    models: [{ provider: "openrouter", model: "anthropic/claude-sonnet-5" }],
    tools: [{ id: "lookup_customer" }, { id: "send_email", gated: true }],
    resultSchemas: [{ toolId: "report", schema: { type: "object" } }],
    skills: [{ name: "triage" }],
    mcpServers: [{ id: "docs", origin: "https://mcp.example.com" }],
    connections: [{ id: "github", kind: "github-app", policy: { permissions: { contents: "read" } } }],
    memory: [{ id: "requirements" }],
    regions: [{ scope: "runtime", region: "us-east-1" }],
    lifecycleCapabilities: {},
    egressCapabilities: {},
    createdAt: "2026-09-25T00:00:00.000Z",
  },
  manifestDigest: "sha256:0123",
};

const receipt = {
  schema: "opencomputer.deployment-readiness/v1",
  projectId: "prj_1",
  agentId: "hello-world",
  deploymentId: "hello-world:abc",
  sessionId: null,
  environment: "development" as const,
  checkedAt: "2026-09-25T01:00:00.000Z",
  manifestDigest: "sha256:0123",
  probe: { mode: "platform", executesAgentCode: false, contactsCustomerTargets: false },
  checks: [
    {
      id: "model.route",
      status: "fail" as const,
      required: true,
      summary: "No model access is configured",
      detail: {},
      checkedAt: "2026-09-25T01:00:00.000Z",
      durationMs: 2,
    },
    {
      id: "connections",
      status: "skip" as const,
      required: false,
      summary: "No connections declared",
      detail: {},
      checkedAt: "2026-09-25T01:00:00.000Z",
      durationMs: 0,
    },
  ],
  ready: false,
};

function captureStdout(): { output: () => string; restore: () => void } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  return {
    output: () => chunks.join(""),
    restore: () => {
      process.stdout.write = original;
    },
  };
}

test("capabilities formats the manifest with its digest and declarations", () => {
  const text = formatCapabilities(capabilities);
  assert.match(text, /Manifest      sha256:0123/);
  assert.match(text, /Tools\s+lookup_customer, send_email \(gated\)/);
  assert.match(text, /Skills\s+triage/);
  assert.match(text, /Connections\s+github \(github-app\)/);
  assert.match(text, /Regions\s+runtime=us-east-1/);
});

test("readiness lists every check and the final decision", () => {
  const text = formatReadiness(receipt);
  assert.match(text, /Ready         no/);
  assert.match(text, /FAIL model\.route\s+No model access is configured\n/);
  assert.match(text, /SKIP connections\s+No connections declared \(optional\)/);
});

test("deployments commands call the documented routes and fail on a not-ready receipt", async (context) => {
  const calls: Array<{ path: string; method: string }> = [];
  context.mock.method(
    globalThis,
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push({ path: `${url.pathname}${url.search}`, method: init?.method ?? "GET" });
      if (url.pathname.endsWith("/capabilities")) return Response.json(capabilities);
      if (url.pathname.endsWith("/readiness")) return Response.json(receipt);
      throw new Error(`unexpected request ${url.pathname}`);
    },
  );
  const client = new OpenComputerClient(config);

  const stdout = captureStdout();
  try {
    await runDeploymentsCommand(client, ["capabilities", "hello-world:abc"], true);
    assert.deepEqual(JSON.parse(stdout.output()), capabilities);
    await runDeploymentsCommand(
      client,
      ["capabilities", "hello-world:abc", "--digest", "sha256:0123"],
      true,
    );
    await assert.rejects(
      runDeploymentsCommand(client, ["readiness", "hello-world:abc"], true),
      (error: unknown) =>
        error instanceof CLIError && error.code === "deployment_not_ready",
    );
  } finally {
    stdout.restore();
  }
  assert.deepEqual(calls, [
    { path: "/api/managed-agents/deployments/hello-world%3Aabc/capabilities", method: "GET" },
    {
      path: "/api/managed-agents/deployments/hello-world%3Aabc/capabilities?digest=sha256%3A0123",
      method: "GET",
    },
    { path: "/api/managed-agents/deployments/hello-world%3Aabc/readiness", method: "POST" },
  ]);
  await assert.rejects(runDeploymentsCommand(client, ["capabilities"], true), /Usage/);
  await assert.rejects(
    runDeploymentsCommand(client, ["capabilities", "hello-world:abc", "--digest"], true),
    /--digest requires a value/,
  );
  await assert.rejects(
    runDeploymentsCommand(client, ["inspect", "hello-world:abc"], true),
    /Usage/,
  );
});
