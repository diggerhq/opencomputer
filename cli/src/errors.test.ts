import assert from "node:assert/strict";
import test from "node:test";

import { APIError } from "./api.js";
import { CLIError, structuredError } from "./errors.js";

test("structured CLI errors always include a stable code and fix hint", () => {
  assert.deepEqual(
    structuredError(new CLIError("doctor_failed", "Invalid project.", "Run doctor.")),
    { code: "doctor_failed", message: "Invalid project.", hint: "Run doctor." },
  );
  assert.deepEqual(structuredError(new APIError("Missing", 404)), {
    code: "resource_not_found",
    message: "Missing",
    hint: "Check the bound project and resource identifier, then retry.",
    details: { status: 404 },
  });
});
