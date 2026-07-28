package agent

import (
	"context"
	"testing"

	pb "github.com/opensandbox/opensandbox/proto/agent"
)

// TestPrepareResume_EnvsStored verifies the env step folds SetEnvs semantics:
// the supplied map is stored in the same slice Exec injects from.
func TestPrepareResume_EnvsStored(t *testing.T) {
	s := &Server{}
	resp, err := s.PrepareResume(context.Background(), &pb.PrepareResumeRequest{
		Envs: map[string]string{"FOO": "bar"},
	})
	if err != nil {
		t.Fatalf("PrepareResume err: %v", err)
	}
	if !resp.EnvsSet {
		t.Fatalf("want EnvsSet=true")
	}
	s.envMu.RLock()
	got := append([]string(nil), s.sandboxEnvs...)
	s.envMu.RUnlock()
	found := false
	for _, e := range got {
		if e == "FOO=bar" {
			found = true
		}
	}
	if !found {
		t.Fatalf("env not stored in sandboxEnvs: %v", got)
	}
}

// TestPrepareResume_BestEffort verifies the RPC never returns a top-level error
// for a failing sub-step — clock/network failures are surfaced as flags+warnings
// so the host can decide, not as an RPC error. (On non-Linux the clock/network
// helpers are stubs that fail; on Linux-non-root settimeofday/ip fail too.)
func TestPrepareResume_BestEffort(t *testing.T) {
	s := &Server{}
	resp, err := s.PrepareResume(context.Background(), &pb.PrepareResumeRequest{
		ClockUnixNanos: 1,
		GuestIp:        "10.0.0.2",
		PrefixLen:      30,
		Gateway:        "10.0.0.1",
		FlushNeigh:     true,
	})
	if err != nil {
		t.Fatalf("PrepareResume must be best-effort (no top-level error), got: %v", err)
	}
	if resp == nil {
		t.Fatalf("nil response")
	}
	// network_method is set whenever a network step was attempted.
	if resp.NetworkOk && resp.NetworkMethod == "" {
		t.Fatalf("network_ok without a method")
	}
}

// TestPrepareResume_Empty verifies an all-empty request is a clean no-op.
func TestPrepareResume_Empty(t *testing.T) {
	s := &Server{}
	resp, err := s.PrepareResume(context.Background(), &pb.PrepareResumeRequest{})
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if resp.Thawed || resp.NetworkOk || resp.ClockOk || resp.EnvsSet {
		t.Fatalf("empty request should touch nothing, got %+v", resp)
	}
}
