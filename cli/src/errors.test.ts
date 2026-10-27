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

test("out-of-credits responses tell the agent to stop and surface the upgrade link", () => {
  const halted = structuredError(
    new APIError(
      "Out of prepaid credits.",
      402,
      "insufficient_credits",
      "https://app.opencomputer.dev/billing?plan=max",
    ),
  );
  assert.equal(halted.code, "insufficient_credits");
  assert.match(halted.hint, /do not retry/);
  assert.match(halted.hint, /https:\/\/app\.opencomputer\.dev\/billing\?plan=max/);
  assert.deepEqual(halted.details, {
    status: 402,
    apiCode: "insufficient_credits",
    upgradeUrl: "https://app.opencomputer.dev/billing?plan=max",
  });

  const bare = structuredError(new APIError("Payment required.", 402));
  assert.equal(bare.code, "insufficient_credits");
  assert.match(bare.hint, /opencomputer upgrade/);
  assert.match(bare.hint, /Pro \(\$200\/mo\)/);
  assert.doesNotMatch(bare.hint + halted.hint, /\$20\/mo|top.?up/i);

  // A $200 Pro org is pointed at billing (credits renew), not at an upgrade.
  const pro = structuredError(
    new APIError("Out of credits.", 402, "insufficient_credits", "https://app.opencomputer.dev/billing"),
  );
  assert.match(pro.hint, /renew/);
  assert.doesNotMatch(pro.hint, /upgrade/i);
});

test("a work-minute 402 says why and links Billing", () => {
  const trial = structuredError(
    new APIError(
      "Your 3-day trial has ended.",
      402,
      "insufficient_credits",
      "https://app.opencomputer.dev/billing",
      "trial_days",
    ),
  );
  assert.equal(trial.code, "insufficient_credits");
  assert.match(trial.hint, /^Your 3-day trial has ended\. Pick a plan to keep going at https:\/\/app\.opencomputer\.dev\/billing,/);
  assert.match(trial.hint, /Do not retry/);
  assert.deepEqual(trial.details, {
    status: 402,
    apiCode: "insufficient_credits",
    haltReason: "trial_days",
    upgradeUrl: "https://app.opencomputer.dev/billing",
  });

  const payment = structuredError(
    new APIError("Payment failed.", 402, "insufficient_credits", undefined, "payment"),
  );
  assert.match(payment.hint, /Update your payment method to keep going on the Billing page/);

  // The credit rule keeps its copy.
  const exhausted = structuredError(
    new APIError("Out.", 402, "insufficient_credits", "https://app.opencomputer.dev/billing?plan=max", "credits_exhausted"),
  );
  assert.match(exhausted.hint, /upgrade to Pro/);
});
