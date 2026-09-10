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

test("memory precondition and size failures map to their own codes", () => {
  const stale = structuredError(
    new APIError("Stale revision.", 412, "precondition_failed"),
  );
  assert.equal(stale.code, "precondition_failed");
  assert.deepEqual(stale.details, { status: 412, apiCode: "precondition_failed" });
  assert.match(stale.hint, /reconcile/);
  assert.equal(
    structuredError(new APIError("Too big.", 413, "memory_limit_exceeded")).code,
    "payload_too_large",
  );
  assert.equal(
    structuredError(new APIError("If-Match required.", 428)).code,
    "precondition_required",
  );
});
