import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { publishDevelopment } from "./dev.js";
import { initializeAgentProject } from "./project.js";

test("development publish builds an immutable artifact under the development alias", async () => {
  const parent = await mkdtemp(resolve(tmpdir(), "opencomputer-dev-"));
  try {
    const initialized = await initializeAgentProject(resolve(parent, "app"), {
      id: "prj_test",
      name: "Test project",
      agentId: "hello-agent",
    });
    let input:
      | Parameters<
          Parameters<typeof publishDevelopment>[0]["registerDeployment"]
        >[0]
      | undefined;
    const client = {
      async registerDeployment(value: NonNullable<typeof input>) {
        input = value;
        return {
          id: `${value.agentId}:${value.source.digest}`,
          agentId: value.agentId,
          alias: value.alias,
          createdAt: new Date(0).toISOString(),
        };
      },
    };
    const result = await publishDevelopment(
      client,
      initialized.agentRoot,
      "hello-agent",
    );
    assert.equal(input?.agentId, "hello-agent");
    assert.equal(input?.alias, "development");
    assert.equal(input?.source.digest, result.built.digest);
    assert.match(result.deployment.id, /^hello-agent:[a-f0-9]{64}$/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
