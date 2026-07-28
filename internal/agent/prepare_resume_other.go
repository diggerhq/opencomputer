//go:build !linux

package agent

import (
	"fmt"

	pb "github.com/opensandbox/opensandbox/proto/agent"
)

// Stubs for non-Linux (the agent only runs inside the Linux guest; these exist
// so the package builds on dev machines).

func setGuestClock(unixNanos int64) error {
	return fmt.Errorf("setGuestClock not supported on this platform")
}

func configureGuestNetwork(req *pb.PrepareResumeRequest) (string, error) {
	return "", fmt.Errorf("configureGuestNetwork not supported on this platform")
}
