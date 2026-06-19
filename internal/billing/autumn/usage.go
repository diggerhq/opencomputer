package autumn

import "fmt"

// DiskOverageFeatureID is the metered feature for disk used above the included
// allowance (value tracked in GB-seconds).
const DiskOverageFeatureID = "disk_overage"

// tierFeatureByMemoryMB maps a sandbox memory tier (MB) to its Autumn compute
// feature. Keep in sync with the per-tier rates in internal/billing/pricing.go
// and the credit schema configured in Autumn.
var tierFeatureByMemoryMB = map[int]string{
	1024:  "compute_1gb",
	4096:  "compute_4gb",
	8192:  "compute_8gb",
	16384: "compute_16gb",
	32768: "compute_32gb",
	65536: "compute_64gb",
}

// FeatureForMemoryMB returns the Autumn compute feature id for a memory tier,
// or ("", false) if the tier is unknown (caller should skip + log).
func FeatureForMemoryMB(mb int) (string, bool) {
	f, ok := tierFeatureByMemoryMB[mb]
	return f, ok
}

// UsageIdempotencyKey builds a globally-unique, retry-stable idempotency key for
// a usage bucket. Autumn dedupes on the bare key across all customers, so it
// must include the org; it must also be stable across retries, so it's keyed on
// the bucket start (not wall-clock now).
func UsageIdempotencyKey(orgID string, bucketStartUnix int64, featureID string) string {
	return fmt.Sprintf("usage:%s:%d:%s", orgID, bucketStartUnix, featureID)
}
