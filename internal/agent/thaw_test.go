package agent

import (
	"context"
	"testing"

	pb "github.com/opensandbox/opensandbox/proto/agent"
)

// TestServerThaw_DefaultsMounts verifies an empty request thaws the agent's
// default mount set (rootfs + workspace), one result per mountpoint.
func TestServerThaw_DefaultsMounts(t *testing.T) {
	s := &Server{}
	resp, err := s.Thaw(context.Background(), &pb.ThawRequest{})
	if err != nil {
		t.Fatalf("Thaw returned error: %v", err)
	}
	if len(resp.Results) != len(defaultThawMounts) {
		t.Fatalf("want %d results, got %d", len(defaultThawMounts), len(resp.Results))
	}
	for i, mp := range defaultThawMounts {
		if resp.Results[i].Mountpoint != mp {
			t.Errorf("result %d mountpoint = %q, want %q", i, resp.Results[i].Mountpoint, mp)
		}
	}
}

// TestServerThaw_ExplicitMountReported verifies explicit mountpoints are honored
// and that an un-openable mountpoint is surfaced as a per-result error rather
// than failing the whole RPC (best-effort semantics the host relies on).
func TestServerThaw_ExplicitMountReported(t *testing.T) {
	s := &Server{}
	const missing = "/definitely/not/a/mountpoint/xyzzy"
	resp, err := s.Thaw(context.Background(), &pb.ThawRequest{Mountpoints: []string{missing}})
	if err != nil {
		t.Fatalf("Thaw returned error: %v", err)
	}
	if len(resp.Results) != 1 {
		t.Fatalf("want 1 result, got %d", len(resp.Results))
	}
	if resp.Results[0].Mountpoint != missing {
		t.Errorf("mountpoint = %q, want %q", resp.Results[0].Mountpoint, missing)
	}
	if resp.Results[0].Error == "" {
		t.Errorf("expected a per-result error for a non-existent mountpoint")
	}
}
