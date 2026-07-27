//go:build linux

package agent

import (
	"os"
	"testing"
)

// TestThawMount_UnfrozenIsIdempotent exercises the real FITHAW ioctl against an
// un-frozen filesystem: thaw_super() returns EINVAL, which thawMount maps to
// alreadyThawed=true. This proves the ioctl constant, O_NOATIME open, and EINVAL
// handling on real Linux without freezing (and thus risking) anything. Requires
// CAP_SYS_ADMIN (FITHAW), so it skips when not run as root.
func TestThawMount_UnfrozenIsIdempotent(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("FITHAW requires CAP_SYS_ADMIN; run as root to exercise the ioctl")
	}
	dir := t.TempDir()
	already, err := thawMount(dir)
	if err != nil {
		t.Fatalf("thawMount(%s) on an unfrozen fs: unexpected error %v", dir, err)
	}
	if !already {
		t.Fatalf("thawMount(%s): want alreadyThawed=true for an unfrozen fs", dir)
	}
}
