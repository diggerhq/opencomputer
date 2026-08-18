// Package diskpolicy holds the disk-pressure ladder — the one place the
// checkpoint cache and the scaler both read their thresholds from.
//
// They used to be independent numbers in packages that do not import each
// other: the cache kept a 20% reserve (evicting only above 80% full) while the
// scaler began scaling up at 60% and live-migrating sandboxes off at 70%. Two
// subsystems, one disk, no shared definition of "full".
//
// That produced a band from 60% to 80% in which the scaler was spending money
// and moving customer VMs while the largest reclaimable pool on the box — the
// checkpoint cache — was behaving exactly as designed and releasing nothing.
// Worse, the scaler's two responses cannot fix that cause: evacuating a sandbox
// frees its directory, not the cache. So the box stayed full, and the scaler
// kept reacting to pressure it had no way to relieve.
//
// The ordering below is the invariant that prevents it: the cache gives back
// everything it can BEFORE the scaler takes any action at all. By the time the
// scaler sees pressure, that pressure is real — it is sandboxes, not cache, and
// adding a worker is genuinely the right answer.
//
// TestLadderIsOrdered pins the relationship. Change a number here and the test
// tells you whether you broke it; change one in the scaler or the cache and
// there is now nowhere else to change it.
package diskpolicy

// The ladder, as percentage-full of the data volume.
const (
	// CacheEvictPct is where the checkpoint cache starts releasing LRU entries.
	//
	// First rung deliberately, and below ScaleUpPct with headroom to spare: the
	// cache is elastic and sandboxes are not, so the elastic thing must yield
	// first. Everything the cache holds is a latency optimisation — evicting it
	// costs a cold restore on the next fork of that checkpoint, which is a far
	// cheaper mistake than launching a worker or migrating a live VM.
	//
	// This bounds the cache at roughly this share of the volume rather than the
	// ~80% it could previously reach. That is the intended trade.
	CacheEvictPct = 55.0

	// ScaleUpPct is where the scaler adds a worker.
	ScaleUpPct = 60.0

	// EvacuatePct is where the scaler live-migrates sandboxes off a hot worker.
	EvacuatePct = 70.0

	// RoutingExcludePct is where a worker stops receiving new sandboxes.
	//
	// This rung is why eviction must not be demand-driven. Exclusion stops the
	// traffic that used to be the ONLY trigger for eviction, so a cache that
	// evicts only when something is being downloaded can never shrink once its
	// worker crosses this line — the worker latches out of the fleet and stays
	// there. See CheckpointStore.StartEvictionSweeper.
	RoutingExcludePct = 85.0

	// EmergencyPct is where sandboxes are hibernated to free space immediately.
	EmergencyPct = 90.0
)
