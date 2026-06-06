package sandbox

import "time"

// LifecycleObserver receives per-sandbox lifecycle events from the runtime
// Manager. It exists so the billing ticker can flush an accurate final slice
// at exactly the moment a sandbox's config changes or its existence ends —
// without that, the slice between the last periodic tick and the lifecycle
// event is either lost (destroy / hibernate) or attributed to the wrong
// config (scale).
//
// All methods are called on the goroutine that triggered the lifecycle
// event. Implementations should not block; offload to a goroutine if needed.
// The Manager guards against nil observer — implementing this is opt-in.
//
// The `startedAt` parameter on scale/destroy/hibernate is the time the
// sandbox started its current run (sandbox creation, or wake-completion
// time for a post-wake event). Implementations use it as a fallback
// attribution point when no prior tick has been emitted for this sandbox
// — e.g. a sandbox created and destroyed within a single tick interval.
// Without this, sandboxes that live shorter than the tick interval and
// have no other observation events go un-billed.
//
// Why this exists alongside the existing per-callback fields (OnSandboxReady,
// OnSandboxDestroy used by the metadata server): those carry data the
// metadata service needs (guestIP, template). This interface carries the
// memory_mb / cpu_count data the billing pipeline needs. Keeping them
// separate avoids breaking the metadata callers when billing needs change.
type LifecycleObserver interface {
	// OnSandboxScale fires BEFORE the sandbox's resource limits change.
	// oldMemoryMB / oldCPUCount are the values active during the slice that
	// ends now; the post-scale config is whatever the next periodic tick
	// observes from the live sandbox.
	OnSandboxScale(sandboxID string, oldMemoryMB, oldCPUCount int, startedAt time.Time)

	// OnSandboxDestroy fires when a sandbox is killed. memoryMB / cpuCount
	// are the final config; the observer should emit a closing tick for the
	// slice ending at destroy, then drop any per-sandbox state.
	OnSandboxDestroy(sandboxID string, memoryMB, cpuCount int, startedAt time.Time)

	// OnSandboxHibernate fires BEFORE savevm. memoryMB / cpuCount are the
	// config the sandbox had immediately before hibernation. Used to emit
	// the final pre-hibernate slice (otherwise the last-tick-to-hibernate
	// window is lost, and on wake the next periodic tick would attribute
	// it backwards through the hibernation window).
	OnSandboxHibernate(sandboxID string, memoryMB, cpuCount int, startedAt time.Time)

	// OnSandboxWake fires AFTER loadvm restores the sandbox. Sets a fresh
	// observation marker so subsequent emits (periodic or lifecycle)
	// measure from wake-completion forward — hibernation time itself is
	// not billed as compute.
	OnSandboxWake(sandboxID string)
}
