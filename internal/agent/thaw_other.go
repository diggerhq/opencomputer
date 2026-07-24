//go:build !linux

package agent

import "fmt"

// thawMount is a stub on non-Linux platforms (the agent only runs inside the
// Linux guest; this exists so the package still builds on dev machines).
func thawMount(mountpoint string) (alreadyThawed bool, err error) {
	return false, fmt.Errorf("thaw not supported on this platform")
}
