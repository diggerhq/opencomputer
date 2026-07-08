//go:build !linux

package qemu

import "fmt"

// reclaimGuestRAM is Linux-only (process_madvise + /proc/<pid>/maps). On other
// platforms it's a no-op error so the package still builds for local dev.
func reclaimGuestRAM(pid int, minRegionBytes uint64) (uint64, error) {
	return 0, fmt.Errorf("guest RAM reclaim not supported on this platform")
}
