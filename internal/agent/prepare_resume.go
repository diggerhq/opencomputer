package agent

import (
	"context"
	"fmt"

	pb "github.com/opensandbox/opensandbox/proto/agent"
)

// PrepareResume folds the whole post-golden-restore guest setup into one native
// round-trip: thaw → clock → envs → network. It replaces the serial
// Thaw + patchGuestNetwork(exec) + syncGuestClock(exec) + SetEnvs chain the host
// used to make on the create critical path — four virtio-serial RPCs, two of
// which spawned guest shells (the `ip` script alone forks ~10 processes).
//
// Ordering matters and is enforced here: thaw runs first, because the network
// step both writes files on the rootfs and (on the exec path) spawns a shell
// from it — neither is safe while the rootfs is frozen. Thaw is a native ioctl,
// so it can't deadlock the way an exec-based thaw could.
//
// Every sub-step is best-effort and reported individually (flags + warnings);
// the RPC itself returns a non-nil error only on an unexpected internal failure.
// The host inspects the flags and, e.g., treats network_ok=false the same as the
// old patchGuestNetwork error (cold-boot fallback).
func (s *Server) PrepareResume(ctx context.Context, req *pb.PrepareResumeRequest) (*pb.PrepareResumeResponse, error) {
	resp := &pb.PrepareResumeResponse{}

	// 1. Thaw (must precede any rootfs write/exec below).
	if req.Thaw {
		mounts := req.ThawMountpoints
		if len(mounts) == 0 {
			mounts = defaultThawMounts
		}
		thawed := true
		for _, mp := range mounts {
			if _, err := thawMount(mp); err != nil {
				resp.Warnings = append(resp.Warnings, fmt.Sprintf("thaw %s: %v", mp, err))
				thawed = false
			}
		}
		resp.Thawed = thawed
	}

	// 2. Clock — native settimeofday, no `date` shell-out. (Doesn't touch the fs,
	// but kept after thaw for a simple linear order.)
	if req.ClockUnixNanos > 0 {
		if err := setGuestClock(req.ClockUnixNanos); err != nil {
			resp.Warnings = append(resp.Warnings, fmt.Sprintf("clock: %v", err))
		} else {
			resp.ClockOk = true
		}
	}

	// 3. Envs — same store SetEnvs writes to (injected into subsequent Exec).
	if len(req.Envs) > 0 {
		envs := mapToEnv(req.Envs)
		s.envMu.Lock()
		s.sandboxEnvs = envs
		s.envMu.Unlock()
		resp.EnvsSet = true
	}

	// 4. Network — golden booted with a different IP; reconfigure the NIC + DNS.
	if req.GuestIp != "" {
		method, err := configureGuestNetwork(req)
		resp.NetworkMethod = method
		if err != nil {
			resp.Warnings = append(resp.Warnings, fmt.Sprintf("network: %v", err))
		} else {
			resp.NetworkOk = true
		}
	}

	return resp, nil
}
