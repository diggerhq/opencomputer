package controlplane

import (
	"testing"

	"github.com/redis/go-redis/v9"
)

type fakeCapacity struct{ healthy, available, running int }

func (f fakeCapacity) Capacity() (int, int, int) { return f.healthy, f.available, f.running }

// A cell that reports no capacity is not routed to by the edge — isHealthy()
// gates on available_workers > 0. So a reporter constructed with no source at
// all must fail loudly at startup rather than run and emit zeros, which would
// read as "cell full" and silently strand every create.
func TestNewCapacityReporterRequiresASource(t *testing.T) {
	_, err := NewCapacityReporter(CapacityReporterConfig{
		Redis:  nil,
		CellID: "cell-a",
	})
	if err == nil {
		t.Fatal("constructed a reporter with neither Registry nor Source")
	}
}

// The MicroVM control plane supplies capacity directly: it has no worker
// registry, and requiring one is exactly what made such a cell unroutable.
func TestNewCapacityReporterAcceptsACustomSource(t *testing.T) {
	src := fakeCapacity{healthy: 1, available: 3, running: 7}
	r, err := NewCapacityReporter(CapacityReporterConfig{
		// Never dialled — the constructor only nil-checks it.
		Redis:  redis.NewClient(&redis.Options{Addr: "127.0.0.1:1"}),
		Source: src,
		CellID: "cell-a",
	})
	if err != nil {
		t.Fatalf("NewCapacityReporter: %v", err)
	}
	h, a, run := r.source.Capacity()
	if h != 1 || a != 3 || run != 7 {
		t.Fatalf("source reported (%d,%d,%d), want (1,3,7)", h, a, run)
	}
}
