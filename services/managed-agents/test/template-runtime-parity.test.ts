import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { deploymentAllowsGatewayModel } from "../src/edge/model-catalog.js";
import { templateDeployments } from "../src/edge/template-service.js";
import type { InitializeSessionResult, Project, ProjectResourceManifest } from "../src/protocol.js";

/**
 * A template-installed Jev Router agent must land where a CLI deployment
 * would: the configured Workerd runtime, with the declared router model
 * admitted by the model gateway's allowlist.
 */

const base = "https://managedagents.test";
const jevRouter = { provider: "openrouter", model: "typesafe/jev-router" };
const platformDefault = { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" };
const resources: ProjectResourceManifest = {
  version: 1,
  channels: [],
  channelRegistrations: [],
  outboxes: [],
  outboxRegistrations: [],
  schedules: [],
};

beforeEach(async () => {
  await env.SERVERLESS_AGENTS_DB.prepare(
    `CREATE TABLE IF NOT EXISTS session_creations (
      session_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      countable INTEGER NOT NULL DEFAULT 1,
      exclusion_reason TEXT,
      outcome_at TEXT
    )`,
  ).run();
});

async function project(): Promise<Project> {
  const response = await SELF.fetch(`${base}/v1/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ environmentMode: "legacy", name: `Router ${crypto.randomUUID().slice(0, 8)}` }),
  });
  expect(response.status).toBe(201);
  const created = await response.json<{ project?: Project } & Project>();
  return created.project ?? created;
}

describe("template installation runtime parity", () => {
  it("installs the Jev Router template on Workerd with the router model admitted at the gateway", { timeout: 15_000 }, async () => {
    const created = await project();
    const digest = "5".repeat(64);
    const deployments = await templateDeployments({
      installationId: "inst_router",
      accountId: "local",
      project: created,
      artifacts: [
        {
          localAgentId: "router",
          name: "Router",
          digest,
          size: 1,
          contentType: "application/json",
          connections: [],
          httpConnections: [],
          models: [jevRouter],
          artifact: { bucket: "b", key: `template-cache/${digest}`, digest, size: 1 },
        },
      ],
      resources,
      imageArn: "test-image",
      imageVersion: "1",
      runtimeMode: "workerd-lazy-sandbox",
      defaultModel: platformDefault,
    });
    const account = env.ACCOUNTS.getByName("local");
    for (const deployment of deployments) await account.registerDeployment(deployment);

    const agentId = deployments[0]!.agentId;
    const resolved = await account.resolveDeployment(`${agentId}@development`);
    expect(resolved).toMatchObject({
      runtimeMode: "workerd-lazy-sandbox",
      models: [jevRouter],
      defaultModel: platformDefault,
    });
    const allowed = [...resolved!.models, ...(resolved!.defaultModel ? [resolved!.defaultModel] : [])];
    expect(deploymentAllowsGatewayModel(allowed, jevRouter)).toBe(true);
    expect(deploymentAllowsGatewayModel(allowed, { provider: "openrouter", model: "openai/gpt-5" })).toBe(false);

    const session = await SELF.fetch(`${base}/v1/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: `${agentId}@development` }),
    });
    expect(session.status).toBe(201);
    expect((await session.json<InitializeSessionResult>()).session).toMatchObject({
      executionMode: "workerd",
      environment: "development",
    });

    // Session creation refills the fake Workerd pool under waitUntil. Let its
    // immediate service calls and console RPCs drain before Vitest tears down
    // this file's isolate; otherwise a late log can strand the workerd child.
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
});
