package billing

import (
	"github.com/opensandbox/opensandbox/internal/db"
)

// TierPricePerSecond maps memory_mb → USD per second.
var TierPricePerSecond = map[int]float64{
	1024:  0.000001080246914, // 1GB / 1 vCPU
	4096:  0.000005787037037, // 4GB / 1 vCPU
	8192:  0.00001350308642,  // 8GB / 2 vCPU
	16384: 0.00002700617284,  // 16GB / 4 vCPU
	32768: 0.0001929012346,   // 32GB / 8 vCPU
	65536: 0.0005401234568,   // 64GB / 16 vCPU
}

// TierMeterKey maps memory_mb → stable key used to derive the Stripe meter
// event_name ("sandbox_compute_" + value). NEVER change these values: meters
// hold historical usage and are shared across price versions.
var TierMeterKey = map[int]string{
	1024:  "sandbox_1gb",
	4096:  "sandbox_4gb",
	8192:  "sandbox_8gb",
	16384: "sandbox_16gb",
	32768: "sandbox_32gb",
	65536: "sandbox_64gb",
}

// TierPriceKey maps memory_mb → Stripe Price metadata["tier"] key.
// Bump the suffix (e.g. sandbox_8gb → sandbox_8gb_v2) whenever TierPricePerSecond
// changes for that tier: Stripe Prices are immutable, so a new key forces
// EnsureProducts to create a fresh Price at the new rate. Existing subscriptions
// must then be migrated to the new Price via cmd/migrate-prices.
//
// The suffixes were bumped one step (1gb→_v2, 4gb→_v2, 8gb_v2→_v3, 16gb→_v2,
// 32gb→_v2, 64gb→_v2) to force EnsureProducts to recreate every memory-tier
// Stripe Price at the documented per-second rate. The previously-deployed
// Prices were calibrated off a stale rate map and were under-billing
// subscribers by 60× (per-minute economics instead of per-second). Run
// `migrate-prices --tier=<X> --live` for every tier after deploy to move all
// existing subscriptions onto the corrected Prices — this is a correction,
// not a price change, so no grandfathering.
var TierPriceKey = map[int]string{
	1024:  "sandbox_1gb_v2",
	4096:  "sandbox_4gb_v2",
	8192:  "sandbox_8gb_v3",
	16384: "sandbox_16gb_v2",
	32768: "sandbox_32gb_v2",
	65536: "sandbox_64gb_v2",
}

// Disk overage billing — every GB above DiskFreeAllowanceMB is metered for the
// full lifetime of the sandbox (running OR hibernated, since the workspace
// qcow2 still occupies host disk).
const (
	DiskFreeAllowanceMB            = 20480      // 20GB included with every sandbox
	DiskOveragePricePerGBPerSecond = 0.0000001  // ~$0.26 per GB-month
	DiskOverageMetadataKey         = "sandbox_disk_overage"
)

// DiskOverageGBSeconds returns the chargeable GB-seconds for one usage summary
// row (zero if the sandbox stayed within the free allowance).
func DiskOverageGBSeconds(s db.OrgUsageSummary) float64 {
	overageMB := s.DiskMB - DiskFreeAllowanceMB
	if overageMB <= 0 || s.TotalSeconds <= 0 {
		return 0
	}
	return float64(overageMB) / 1024.0 * s.TotalSeconds
}

// CalculateUsageCostCents returns total cost in cents from usage summaries —
// memory tier compute plus per-GB-second disk overage above 20GB.
func CalculateUsageCostCents(summaries []db.OrgUsageSummary) float64 {
	var totalUSD float64
	for _, s := range summaries {
		if rate, ok := TierPricePerSecond[s.MemoryMB]; ok {
			totalUSD += s.TotalSeconds * rate
		}
		totalUSD += DiskOverageGBSeconds(s) * DiskOveragePricePerGBPerSecond
	}
	return totalUSD * 100.0
}
