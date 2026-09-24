import assert from "node:assert/strict";
import test from "node:test";

import {
  deploymentAlias,
  githubEnvironments,
  githubEnvironmentsConnected,
  nextAgentEventDeadline,
  selectGitHubInstallation,
  SERVICE_CONNECTIONS,
  shouldBindModelAccessProject,
  validateGitHubConnectionChoice,
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

test("GitHub App connection selection reuses one active account and disambiguates many", () => {
  const installation = (id: string, accountLogin: string) => ({
    id,
    githubInstallationId: 1,
    accountLogin,
    accountType: "Organization",
    repositorySelection: "selected" as const,
    state: "active" as const,
    createdAt: "2026-09-24T00:00:00.000Z",
    updatedAt: "2026-09-24T00:00:00.000Z",
  });
  const digger = installation("ghi_digger", "diggerhq");
  const personal = installation("ghi_personal", "mohamed");

  assert.equal(selectGitHubInstallation([digger]), digger);
  assert.equal(
    selectGitHubInstallation([digger, personal], "diggerhq"),
    digger,
  );
  assert.throws(
    () => selectGitHubInstallation([digger, personal]),
    /--connection/,
  );
  assert.equal(
    selectGitHubInstallation([{ ...digger, state: "suspended" }]),
    undefined,
  );
});

test("a fresh GitHub App install cannot also select an existing connection", () => {
  assert.doesNotThrow(() => validateGitHubConnectionChoice(true));
  assert.doesNotThrow(() =>
    validateGitHubConnectionChoice(false, "diggerhq"),
  );
  assert.throws(
    () => validateGitHubConnectionChoice(true, "diggerhq"),
    /either --new or --connection/,
  );
});
