import { describe, expect, it } from "vitest";

import {
  admitDeploymentModels,
} from "../src/edge/deployment-admission.js";
import { ModelValidationError } from "../src/edge/model-catalog.js";
import {
  templateDeployments,
  validTemplateBundle,
} from "../src/edge/template-service.js";
import type { Project, ProjectResourceManifest } from "../src/protocol.js";

/**
 * Template installation must admit deployments the way `POST /v1/deployments`
 * does: the configured runtime mode, the compiled model declarations and a
 * validated platform default. Memory forwarding is covered separately in
 * `memory-template.test.ts`.
 */

const jevRouter = { provider: "openrouter", model: "typesafe/jev-router" };
const platformDefault = {
  provider: "openrouter",
  model: "anthropic/claude-sonnet-4.6",
};

const project: Project = {
  id: "prj_test",
  slug: "template",
  name: "Template",
  agentId: "local/template",
  environmentMode: "legacy",
  environments: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const resources: ProjectResourceManifest = {
  version: 1,
  channels: [],
  channelRegistrations: [],
  outboxes: [],
  outboxRegistrations: [],
  schedules: [],
};

function artifact(
  localAgentId: string,
  models?: Array<{ provider: string; model: string }>,
) {
  const digest = localAgentId.charCodeAt(0).toString(16).repeat(32);
  return {
    localAgentId,
    name: `Agent ${localAgentId}`,
    digest,
    size: 1,
    contentType: "application/json",
    connections: [],
    httpConnections: [],
    ...(models ? { models } : {}),
    artifact: { bucket: "b", key: `template-cache/${digest}`, digest, size: 1 },
  };
}

function bundle(models?: unknown) {
  return {
    schema: 1,
    template: {},
    agents: [{ id: "agent", name: "Agent" }],
    artifacts: [
      {
        localAgentId: "agent",
        name: "Agent",
        digest: "a".repeat(64),
        size: 1,
        contentType: "application/json",
        body: "e30=",
        connections: [],
        httpConnections: [],
        ...(models === undefined ? {} : { models }),
      },
    ],
    resources,
    requirements: { secrets: [], runtimeVariables: [], connections: [] },
  };
}

const catalog = (ids: string[]) => ({
  fetch: (async () => Response.json({ data: ids.map((id) => ({ id })) })) as unknown as typeof fetch,
});

describe("template bundle model declarations", () => {
  it("accepts declared models and legacy bundles without them", () => {
    expect(validTemplateBundle(bundle([jevRouter]))).toBe(true);
    expect(validTemplateBundle(bundle([]))).toBe(true);
    expect(validTemplateBundle(bundle())).toBe(true);
  });

  it("rejects malformed providers and models", () => {
    expect(validTemplateBundle(bundle(null))).toBe(false);
    expect(validTemplateBundle(bundle("typesafe/jev-router"))).toBe(false);
    expect(validTemplateBundle(bundle([{ model: "typesafe/jev-router" }]))).toBe(false);
    expect(validTemplateBundle(bundle([{ provider: "", model: "x" }]))).toBe(false);
    expect(validTemplateBundle(bundle([{ provider: "openrouter", model: 7 }]))).toBe(false);
    expect(validTemplateBundle(bundle([{ provider: "openrouter", model: " " }]))).toBe(false);
  });
});

describe("template deployment admission", () => {
  it("validates the Jev Router declaration and the platform default against the catalog", async () => {
    await expect(
      admitDeploymentModels([jevRouter], {}, catalog(["typesafe/jev-router", platformDefault.model])),
    ).resolves.toEqual(platformDefault);
    await expect(
      admitDeploymentModels([jevRouter], {}, catalog([platformDefault.model])),
    ).rejects.toBeInstanceOf(ModelValidationError);
  });

  it("forwards runtime mode, models and default model for current bundles", async () => {
    const deployments = await templateDeployments({
      installationId: "inst_1",
      accountId: "local",
      project,
      artifacts: [artifact("router", [jevRouter])],
      resources,
      imageArn: "img",
      imageVersion: "1",
      runtimeMode: "workerd-lazy-sandbox",
      defaultModel: platformDefault,
    });
    expect(deployments).toHaveLength(1);
    expect(deployments[0]).toMatchObject({
      runtimeMode: "workerd-lazy-sandbox",
      models: [jevRouter],
      defaultModel: platformDefault,
    });
  });

  it("gives an agent without useModel the validated platform default", async () => {
    const [deployment] = await templateDeployments({
      installationId: "inst_2",
      accountId: "local",
      project,
      artifacts: [artifact("plain", [])],
      resources,
      imageArn: "img",
      imageVersion: "1",
      runtimeMode: "workerd-lazy-sandbox",
      defaultModel: platformDefault,
    });
    expect(deployment).toMatchObject({
      runtimeMode: "workerd-lazy-sandbox",
      models: [],
      defaultModel: platformDefault,
    });
  });

  it("legacy bundles get the runtime mode while both model fields stay absent", async () => {
    const [deployment] = await templateDeployments({
      installationId: "inst_3",
      accountId: "local",
      project,
      artifacts: [artifact("legacy")],
      resources,
      imageArn: "img",
      imageVersion: "1",
      runtimeMode: "workerd-lazy-sandbox",
    });
    expect(deployment?.runtimeMode).toBe("workerd-lazy-sandbox");
    expect(deployment).not.toHaveProperty("models");
    expect(deployment).not.toHaveProperty("defaultModel");
  });

  it("refuses to register current bundles whose models were not admitted", async () => {
    await expect(
      templateDeployments({
        installationId: "inst_4",
        accountId: "local",
        project,
        artifacts: [artifact("router", [jevRouter])],
        resources,
        imageArn: "img",
        imageVersion: "1",
        runtimeMode: "workerd-lazy-sandbox",
      }),
    ).rejects.toThrow(/not admitted/);
  });

  it("multi-agent templates keep each artifact's own model list", async () => {
    const other = { provider: "openrouter", model: "anthropic/claude-sonnet-5" };
    const deployments = await templateDeployments({
      installationId: "inst_5",
      accountId: "local",
      project,
      artifacts: [artifact("router", [jevRouter]), artifact("writer", [other]), artifact("plain", [])],
      resources,
      imageArn: "img",
      imageVersion: "1",
      runtimeMode: "workerd-lazy-sandbox",
      defaultModel: platformDefault,
    });
    expect(deployments.map((deployment) => deployment.models)).toEqual([[jevRouter], [other], []]);
    expect(new Set(deployments.map((deployment) => deployment.defaultModel))).toEqual(
      new Set([platformDefault]),
    );
    expect(deployments.every((deployment) => deployment.runtimeMode === "workerd-lazy-sandbox")).toBe(true);
  });
});
