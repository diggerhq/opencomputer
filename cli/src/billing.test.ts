import assert from "node:assert/strict";
import test from "node:test";

import type { CreditsStatus } from "./api.js";
import {
  creditsFooter,
  creditsSummary,
  formatBilling,
  upgradeUrlFor,
} from "./billing.js";

const base: CreditsStatus = {
  usagePlan: "base",
  creditsRemainingCents: 340,
  lowCreditThresholdCents: 150,
  isLow: false,
  isHalted: false,
  billingUrl: "https://app.opencomputer.dev/billing",
  upgradeUrl: "https://app.opencomputer.dev/billing?plan=pro",
  plans: [
    { id: "pro", priceUsd: 20, creditsUsd: 200 },
    { id: "max", priceUsd: 200, creditsUsd: 2000 },
  ],
};

test("run footer nudges free orgs, warns when low, and is silent for healthy paid plans", () => {
  assert.match(creditsFooter(base), /\$3\.40 free credits left/);
  assert.match(creditsFooter(base), /plan=pro/);
  assert.match(
    creditsFooter({ ...base, creditsRemainingCents: 90, isLow: true }),
    /running low/,
  );
  assert.match(
    creditsFooter({ ...base, creditsRemainingCents: 0, isHalted: true }),
    /exhausted/,
  );
  assert.equal(
    creditsFooter({ ...base, usagePlan: "pro", creditsRemainingCents: 15_000 }),
    "",
  );
  assert.equal(creditsFooter(null), "");
});

test("json credits block carries a machine-readable warning", () => {
  assert.deepEqual(creditsSummary(base), {
    plan: "base",
    remainingCents: 340,
    upgradeUrl: base.upgradeUrl,
  });
  assert.equal(creditsSummary({ ...base, isLow: true })?.warning, "low_credits");
  assert.equal(
    creditsSummary({ ...base, isHalted: true })?.warning,
    "insufficient_credits",
  );
  assert.equal(creditsSummary(null), undefined);
});

test("billing table lists plans and marks the current one", () => {
  const text = formatBilling({ ...base, usagePlan: "pro" });
  assert.match(text, /Pro \(\$20\/mo\)/);
  assert.match(text, /pro\s+\$20\/mo.*\(current\)/);
  assert.match(text, /max\s+\$200\/mo — \$2,000/);
});

test("upgrade url falls back to the API origin when no credit status is available", () => {
  assert.equal(
    upgradeUrlFor(null, "https://app.opencomputer.dev/", "max"),
    "https://app.opencomputer.dev/billing?plan=max",
  );
  assert.equal(upgradeUrlFor(base, "https://x", "pro"), base.upgradeUrl);
});
