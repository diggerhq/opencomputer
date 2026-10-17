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
  upgradeUrl: "https://app.opencomputer.dev/billing?plan=max",
  plans: [{ id: "max", name: "Pro", priceUsd: 200, creditsUsd: 2000 }],
};

test("run footer nudges free orgs, warns when low, and is silent for healthy paid plans", () => {
  assert.match(creditsFooter(base), /3.4 free credits left/);
  assert.match(creditsFooter(base), /plan=max/);
  assert.match(creditsFooter(base), /Pro \(\$200\/mo\)/);
  assert.match(
    creditsFooter({ ...base, creditsRemainingCents: 90, isLow: true }),
    /running low/,
  );
  assert.match(
    creditsFooter({ ...base, creditsRemainingCents: 0, isHalted: true }),
    /You've used your free credits\. Upgrade to Pro \(\$200\/mo\)/,
  );
  for (const status of [
    base,
    { ...base, isLow: true },
    { ...base, isHalted: true },
    { ...base, usagePlan: "pro" as const, isHalted: true },
  ]) {
    assert.doesNotMatch(creditsFooter(status), /\$20\/mo|top.?up|plan=pro/i);
  }
  // $200 Pro orgs are never offered an upgrade or a top-up.
  const maxHalted = creditsFooter({ ...base, usagePlan: "max", isHalted: true });
  assert.match(maxHalted, /renew/);
  assert.doesNotMatch(maxHalted, /upgrade|top.?up/i);
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

test("billing table lists only Pro ($200) unless the org is on legacy Pro", () => {
  const free = formatBilling(base);
  assert.match(free, /Plan\s+Free/);
  assert.match(free, /Pro\s+\$200\/mo — 2,000 credits every month/);
  assert.doesNotMatch(free, /\$20\/mo|top.?up|Max \(/i);

  const legacy = formatBilling({
    ...base,
    usagePlan: "pro",
    plans: [
      { id: "pro", name: "Pro (legacy)", priceUsd: 20, creditsUsd: 200 },
      { id: "max", name: "Pro", priceUsd: 200, creditsUsd: 2000 },
    ],
  });
  assert.match(legacy, /Plan\s+Pro \(legacy, \$20\/mo\)/);
  assert.match(legacy, /Pro \(legacy\)\s+\$20\/mo.*\(current\)/);
  assert.match(legacy, /Upgrade:\s+\S+plan=max/);
});

test("upgrade url falls back to the API origin when no credit status is available", () => {
  assert.equal(
    upgradeUrlFor(null, "https://app.opencomputer.dev/", "max"),
    "https://app.opencomputer.dev/billing?plan=max",
  );
  assert.equal(upgradeUrlFor(base, "https://x"), base.upgradeUrl);
});
