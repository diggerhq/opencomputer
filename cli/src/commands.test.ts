import assert from "node:assert/strict";
import test from "node:test";

import { deploymentAlias } from "./commands.js";

test("one-shot deploy defaults to development and production stays explicit", () => {
  assert.equal(deploymentAlias(), "development");
  assert.equal(deploymentAlias("development"), "development");
  assert.equal(deploymentAlias("production"), "production");
});
