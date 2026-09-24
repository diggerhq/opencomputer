import assert from "node:assert/strict";
import test from "node:test";

import {
  deploymentAlias,
  initSummary,
  nextAgentEventDeadline,
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

test("init prints the full first-run sequence with login and link", () => {
  const out = initSummary({
    directory: "my-agent",
    root: "/tmp/my-agent",
    name: "my-agent",
    spa: false,
  });
  const steps = (out.split("Next:\n")[1] ?? "")
    .split("\n\n")[0]!
    .split("\n")
    .map((line) => line.trim());
  assert.deepEqual(steps, [
    "cd my-agent",
    "npm install",
    "npx opencomputer login",
    "npx opencomputer link --create-project my-agent",
    "npm run deploy -- --watch",
  ]);
  assert.match(out, /Project:\s+not linked yet/);
  assert.match(out, /login signs this machine in/);

  const inPlace = initSummary({
    directory: ".",
    root: "/tmp/here",
    name: "here",
    spa: true,
  });
  assert.doesNotMatch(inPlace, /cd \./);
  assert.match(inPlace, /link --create-project here\n/);
  assert.match(inPlace, /npm run dev:web/);

  const unsafe = initSummary({
    directory: "my $(agent)",
    root: "/tmp/my $(agent)",
    name: "x",
    spa: false,
  });
  assert.match(unsafe, /cd 'my \$\(agent\)'\n/);
  assert.match(unsafe, /link --create-project 'my \$\(agent\)'\n/);
});

test("model access binds the explicit or current linked project", () => {
  assert.equal(shouldBindModelAccessProject("test", null), true);
  assert.equal(
    shouldBindModelAccessProject(undefined, "/tmp/opencomputer-app"),
    true,
  );
  assert.equal(shouldBindModelAccessProject(undefined, null), false);
});
