import assert from "node:assert/strict";
import test from "node:test";

import {
  deploymentAlias,
  shouldBindModelAccessProject,
} from "./commands.js";

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
