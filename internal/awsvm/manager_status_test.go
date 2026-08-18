package awsvm

import (
	"testing"

	"github.com/aws/aws-sdk-go-v2/service/lambdamicrovms/types"
	ostypes "github.com/opensandbox/opensandbox/pkg/types"
)

// statusFor is what the reconciler keys on to decide whether a sandbox still
// has a host behind it. Getting SUSPENDED wrong in either direction is
// expensive: reporting it stopped closes rows whose box is fine, and reporting
// TERMINATED as running leaves dead rows holding concurrency quota forever —
// which is exactly what happened when the sweep read only the error and never
// the status.
func TestStatusForDistinguishesAliveFromTerminated(t *testing.T) {
	for _, tc := range []struct {
		state types.MicrovmState
		want  ostypes.SandboxStatus
	}{
		{types.MicrovmStateRunning, ostypes.SandboxStatusRunning},
		{types.MicrovmStatePending, ostypes.SandboxStatusRunning},
		// Alive and auto-resumable — must NOT read as stopped.
		{types.MicrovmStateSuspended, ostypes.SandboxStatusRunning},
		{types.MicrovmStateSuspending, ostypes.SandboxStatusRunning},
		// Gone. The row must be closable.
		{types.MicrovmStateTerminated, ostypes.SandboxStatusStopped},
		{types.MicrovmStateTerminating, ostypes.SandboxStatusStopped},
	} {
		if got := statusFor(&Box{State: tc.state}); got != tc.want {
			t.Errorf("state %s -> %s, want %s", tc.state, got, tc.want)
		}
	}
	if got := statusFor(nil); got != ostypes.SandboxStatusStopped {
		t.Errorf("nil box -> %s, want stopped", got)
	}
}
