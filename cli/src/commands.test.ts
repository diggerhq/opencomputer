import assert from "node:assert/strict";
import test from "node:test";

import {
  deploymentAlias,
  githubEnvironments,
  githubEnvironmentsConnected,
  nextAgentEventDeadline,
  SERVICE_CONNECTIONS,
  shouldBindModelAccessProject,
} from "./commands.js";

test("agent event progress refreshes the inactivity deadline", () => {
  assert.equal(nextAgentEventDeadline(10_000, 3_000, 0, 9_000), 10_000);
  assert.equal(nextAgentEventDeadline(10_000, 3_000, 1, 9_000), 12_000);
});

test("one-shot deploy defaults to development and production stays explicit", () => {
  assert.equal(deploymentAlias(), "development");
  assert.equal(deploymentAlias("development"), "development");
  assert.equal(deploymentAlias("production"), "production");
});

test("model access binds the explicit or current linked project", () => {
  assert.equal(shouldBindModelAccessProject("test", null), true);
  assert.equal(
    shouldBindModelAccessProject(undefined, "/tmp/opencomputer-app"),
    true,
  );
  assert.equal(shouldBindModelAccessProject(undefined, null), false);
});

test("managed service connections exclude the dedicated GitHub App flow", () => {
  assert.equal(SERVICE_CONNECTIONS.includes("linear"), true);
  assert.equal(
    (SERVICE_CONNECTIONS as readonly string[]).includes("github"),
    false,
  );
});

test("GitHub App connections target both environments unless one is explicit", () => {
  assert.deepEqual(githubEnvironments(), ["development", "production"]);
  assert.deepEqual(githubEnvironments("production"), ["production"]);
  assert.throws(
    () => githubEnvironments("staging"),
    /development or production/,
  );
});

test("GitHub App connection readiness requires every requested environment", () => {
  const status = {
    environments: [
      { environment: "development" as const, state: "active" as const },
      { environment: "production" as const, state: "not_connected" as const },
    ],
    connections: [],
    app: { slug: "opencomputer" },
  };
  assert.equal(githubEnvironmentsConnected(status, ["development"]), true);
  assert.equal(
    githubEnvironmentsConnected(status, ["development", "production"]),
    false,
  );
});
