package qemu

// DiskLayout describes how a sandbox's block storage is arranged. It is an
// immutable birth property of a box: chosen at create time and copied verbatim
// onto every derived resource (checkpoint inherits the sandbox's; a fork
// inherits the checkpoint's; a migration carries the source's). It is NEVER
// mutated in place — the disk topology is fixed at QEMU launch (the -drive set)
// and welded into every RAM snapshot, so a running/​snapshotted box cannot change
// layout without being rebuilt.
//
// Two layouts coexist during the rollout (dual-mode workers understand both):
//
//   - LayoutSplit  (legacy): two disks — rootfs qcow2 overlay on the golden base
//     mounted at "/", plus a separate workspace qcow2 (/dev/vdb) mounted at
//     /home/sandbox. This is every box created before the merge.
//   - LayoutMerged (new): one disk — a single qcow2 overlay on a 20GB golden base
//     holding both the OS and /home/sandbox as a directory. No /dev/vdb.
//
// The zero value ("") means LayoutSplit: metadata written before this field
// existed, and any resource we haven't explicitly tagged, is a split box. Always
// route layout values through EffectiveDiskLayout so absent ⇒ split holds
// everywhere.
type DiskLayout = string

const (
	// LayoutSplit is the legacy two-disk topology (rootfs + workspace). It is
	// also the meaning of the empty string, for backward compatibility with
	// metadata that predates the DiskLayout field.
	LayoutSplit DiskLayout = "split"

	// LayoutMerged is the single-disk topology (OS + /home/sandbox on one disk).
	LayoutMerged DiskLayout = "merged"
)

// EffectiveDiskLayout normalizes a possibly-empty layout string to a concrete
// layout, applying the "absent ⇒ split" rule. Every branch on layout must go
// through this so that untagged (pre-merge) resources are treated as split.
func EffectiveDiskLayout(layout string) DiskLayout {
	if layout == LayoutMerged {
		return LayoutMerged
	}
	return LayoutSplit
}

// IsMerged reports whether the given (possibly-empty) layout is the merged
// single-disk topology.
func IsMerged(layout string) bool {
	return EffectiveDiskLayout(layout) == LayoutMerged
}

// boolToLayout maps a "merged?" bool to the corresponding layout constant.
func boolToLayout(merged bool) DiskLayout {
	if merged {
		return LayoutMerged
	}
	return LayoutSplit
}
