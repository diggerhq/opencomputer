package main

import (
	"fmt"
	"os"
	"syscall"
)

const (
	// Linux reserves CID 2 for the host side of an AF_VSOCK connection.
	// Guest-local callers use CID 1 (VMADDR_CID_LOCAL) or the guest's own
	// transport CID and must never reach the root agent RPC surface.
	vsockHostCID = uint32(2)

	agentEndpointMode = os.FileMode(0600)
)

func isTrustedAgentVsockPeer(cid uint32) bool {
	return cid == vsockHostCID
}

// restrictAgentEndpoint makes a guest-side transport node usable only by the
// root agent. Host control continues through the already-open virtio-serial
// device or the host-owned side of the Unix socket.
func restrictAgentEndpoint(path string) error {
	return restrictAgentEndpointForOwner(path, 0, 0)
}

func restrictAgentEndpointForOwner(path string, uid int, gid int) error {
	if err := os.Chown(path, uid, gid); err != nil {
		return fmt.Errorf("own agent endpoint %s: %w", path, err)
	}
	if err := os.Chmod(path, agentEndpointMode); err != nil {
		return fmt.Errorf("restrict agent endpoint %s: %w", path, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("stat agent endpoint %s: %w", path, err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != uid || info.Mode().Perm() != agentEndpointMode {
		return fmt.Errorf("agent endpoint %s did not retain owner %d and mode %#o", path, uid, agentEndpointMode)
	}
	return nil
}
