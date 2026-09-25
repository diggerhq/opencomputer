import assert from "node:assert/strict";
import test from "node:test";

import { CLIError } from "./errors.js";
import {
  projectEnvironments,
  resolveEnvironment,
  resolveEnvironmentFilter,
  workingEnvironment,
} from "./scope.js";

test("legacy projects keep Development as the default and Production explicit", () => {
  assert.equal(resolveEnvironment("legacy", undefined), "development");
  assert.equal(resolveEnvironment("legacy", "production"), "production");
  assert.throws(() => resolveEnvironment("legacy", "default"), /development or production/);
  assert.equal(resolveEnvironmentFilter("legacy", undefined), undefined);
  assert.deepEqual(projectEnvironments("legacy"), ["development", "production"]);
  assert.equal(workingEnvironment("legacy"), "development");
});

test("single-mode projects resolve to the one scope and refuse an environment flag", () => {
  assert.equal(resolveEnvironment("single", undefined), "default");
  assert.equal(resolveEnvironmentFilter("single", undefined), "default");
  for (const value of ["development", "production", "default"]) {
    assert.throws(
      () => resolveEnvironment("single", value),
      (error: unknown) =>
        error instanceof CLIError &&
        error.code === "single_environment_project" &&
        /--environment/.test(error.message),
    );
  }
  assert.deepEqual(projectEnvironments("single"), ["default"]);
  assert.equal(workingEnvironment("single"), "default");
});
