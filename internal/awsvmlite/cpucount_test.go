package awsvmlite

import "testing"

// A customer-supplied cpuCount must never reach metering.
//
// This runtime has no CPU knob — RunMicrovmInput carries no vCPU field — so a
// requested count cannot be honoured. Recording it anyway would let a customer
// set a number in their own usage records for a machine they did not receive,
// which is the CPU form of the silent-wrong-size failure delivered() exists to
// prevent for memory.
func TestRequestedCPUCountIsDiscardedNotRecorded(t *testing.T) {
	var m *Manager // nil-safe by design: delivered() is pure bookkeeping

	for _, tc := range []struct {
		name      string
		requested int
	}{
		{"unset", 0},
		{"the deliverable value", 1},
		{"more than we can deliver", 4},
		{"absurd", 512},
		{"negative", -3},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := m.delivered(Meta{CPUCount: tc.requested}).CPUCount
			if got != deliveredCPUCount {
				t.Errorf("requested cpuCount=%d was recorded as %d; metering must always see %d, "+
					"or a customer picks the CPU count on their own usage records",
					tc.requested, got, deliveredCPUCount)
			}
		})
	}
}

// Memory keeps its existing behaviour — the CPU change must not disturb the
// sizing logic sharing this function.
func TestDeliveredStillDefaultsMemoryWithoutAClient(t *testing.T) {
	var m *Manager
	if got := m.delivered(Meta{MemoryMB: 4096}).MemoryMB; got != 4096 {
		t.Errorf("memory rewritten to %d with no client configured; expected the request to stand", got)
	}
}
