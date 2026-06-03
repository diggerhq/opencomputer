// Pricing constants mirrored from internal/billing/pricing.go and stripe.go.
//
// KEEP IN SYNC with the Go side — these derive Stripe meter event_names, and
// the whole point of the rollup cron is to emit the SAME meter events the
// cell's billing pipeline does so the edge output is parity-checkable. If the
// Go meter keys change, change them here too.
//
// Meter event_name derivation (stripe.go): "sandbox_compute_" + <key>.

// All Stripe meter event_names share this prefix (stripe.go:80,247-248).
const METER_PREFIX = "sandbox_compute_";

// Legacy per-tier metering. memory_mb → Stripe meter key (pricing.go TierMeterKey).
// NEVER change these values: meters hold historical usage across price versions.
const TIER_METER_KEY: Record<number, string> = {
  1024: "sandbox_1gb",
  4096: "sandbox_4gb",
  8192: "sandbox_8gb",
  16384: "sandbox_16gb",
  32768: "sandbox_32gb",
  65536: "sandbox_64gb",
};

// Unified flat overage meter (pricing.go OverageMeterKey). A single meter,
// flat across all sandbox sizes, billed in GB-seconds.
const OVERAGE_METER_KEY = "sandbox_overage";

// legacyMeterEventName returns the Stripe meter event_name for a legacy
// per-tier meter, or null if memory_mb isn't an allowed tier (defensive — pro
// sandboxes always run an allowed tier, but a malformed sample shouldn't bill).
export function legacyMeterEventName(memoryMB: number): string | null {
  const key = TIER_METER_KEY[memoryMB];
  return key ? METER_PREFIX + key : null;
}

// overageMeterEventName returns the single unified overage meter event_name.
export function overageMeterEventName(): string {
  return METER_PREFIX + OVERAGE_METER_KEY;
}
