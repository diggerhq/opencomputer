package controlplane

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

// CapacityReporter periodically aggregates worker memory pressure from the
// local RedisWorkerRegistry and pushes a `cell_capacity` event onto the
// events:{cell_id} Redis stream — the same stream EventForwarder drains. The
// events-ingest Worker keys off type=="cell_capacity" to UPSERT the cell's
// row in D1 with healthy_workers / available_workers / running_sandboxes /
// capacity_updated_at, which the api-edge consults in its pickCell() cascade.
//
// "available" = worker whose REAL memory usage (MemPct, RSS-based) is below
// the pressure threshold (~85%) — the same signal the routing hard-caps use.
// NOT committed memory: virtio-mem boxes are demand-backed, so a pre-grown
// warm pool commits pool_target×4GB while touching a fraction of it — gating
// on committed read a 9%-used dev fleet as full (available_workers=0 → every
// create 503'd). Single-worker-below-threshold is the right placement gate
// because a sandbox lands on one worker — aggregating across the cell would
// wrongly skip a cell with 1 free worker and 9 loaded ones.
//
// Reuses the existing event pipe so there's no second transport, no new HMAC
// path, no new ingest endpoint. Cost: one extra event per cell per
// ReportInterval, opaque JSON bytes through the same forwarder.

const (
	memPressureThresholdPct = 85
	defaultReportInterval   = 30 * time.Second
	// reporterStreamMaxLen caps the Redis stream so capacity events don't
	// accumulate if the forwarder is down. Sized small — only the most recent
	// sample matters for placement, older ones are stale anyway.
	reporterStreamMaxLen = 10_000
)

// capacityEnvelope mirrors worker.SandboxEventEnvelope on the wire. Defined
// locally to avoid an import of internal/worker from internal/controlplane;
// the forwarder treats stream entries as opaque JSON, so wire-format match is
// all that matters. JSON tags MUST match SandboxEventEnvelope; cross-check
// internal/worker/redis_event_publisher.go if either side changes.
type capacityEnvelope struct {
	ID        string          `json:"id"`
	Type      string          `json:"type"`
	SandboxID string          `json:"sandbox_id"`
	CellID    string          `json:"cell_id"`
	WorkerID  string          `json:"worker_id"`
	Payload   json.RawMessage `json:"payload"`
	Timestamp time.Time       `json:"timestamp"`
}

type capacityPayload struct {
	HealthyWorkers   int `json:"healthy_workers"`
	AvailableWorkers int `json:"available_workers"`
	RunningSandboxes int `json:"running_sandboxes"`
}

// CapacitySource supplies the three placement numbers for a cell.
//
// Behind an interface because "capacity" is not inherently a worker count —
// that is just how a QEMU cell measures it. A cell backed by AWS Lambda
// MicroVMs has no workers at all, and with the registry hardcoded here it could
// never emit cell_capacity, so the edge's isHealthy() gate (which requires
// available_workers > 0) refused to route to it — including an explicit
// cellId pin. The cell was unreachable, not unhealthy.
//
// available is the one that matters to placement: the edge treats > 0 as "this
// cell can accept a create" and ignores the other two.
type CapacitySource interface {
	Capacity() (healthy, available, running int)
}

// workerRegistryCapacity is the QEMU cell's answer: count workers whose REAL
// memory usage is under the pressure threshold. Unchanged from when this logic
// lived inline in emit().
type workerRegistryCapacity struct{ registry *RedisWorkerRegistry }

// WorkerRegistryCapacity adapts a worker registry to a CapacitySource.
func WorkerRegistryCapacity(r *RedisWorkerRegistry) CapacitySource {
	return workerRegistryCapacity{registry: r}
}

func (w workerRegistryCapacity) Capacity() (healthy, available, running int) {
	for _, wk := range w.registry.GetAllWorkers() {
		if wk == nil || wk.Draining {
			continue
		}
		healthy++
		running += wk.Current
		if wk.MemPct < memPressureThresholdPct {
			available++
		}
	}
	return healthy, available, running
}

// CapacityReporter periodically XADDs cell_capacity events.
type CapacityReporter struct {
	rdb       *redis.Client
	source    CapacitySource
	cellID    string
	streamKey string
	interval  time.Duration

	stopCh chan struct{}
	doneCh chan struct{}
	once   sync.Once
}

// CapacityReporterConfig configures the reporter.
type CapacityReporterConfig struct {
	Redis *redis.Client
	// Registry is the QEMU shorthand for Source. Exactly one of the two must be
	// set; Registry wins when both are, so existing callers keep their meaning.
	Registry *RedisWorkerRegistry
	Source   CapacitySource
	CellID   string
	Interval time.Duration // default 30s
}

// NewCapacityReporter constructs a reporter. Returns an error if required
// fields are missing.
func NewCapacityReporter(cfg CapacityReporterConfig) (*CapacityReporter, error) {
	if cfg.Redis == nil {
		return nil, errors.New("capacity_reporter: Redis required")
	}
	source := cfg.Source
	if cfg.Registry != nil {
		source = WorkerRegistryCapacity(cfg.Registry)
	}
	if source == nil {
		return nil, errors.New("capacity_reporter: Registry or Source required")
	}
	if cfg.CellID == "" {
		return nil, errors.New("capacity_reporter: CellID required")
	}
	iv := cfg.Interval
	if iv == 0 {
		iv = defaultReportInterval
	}
	return &CapacityReporter{
		rdb:       cfg.Redis,
		source:    source,
		cellID:    cfg.CellID,
		streamKey: "events:" + cfg.CellID,
		interval:  iv,
		stopCh:    make(chan struct{}),
		doneCh:    make(chan struct{}),
	}, nil
}

// Start launches the report loop. Emits one sample immediately so D1 sees a
// fresh capacity_updated_at without waiting a full interval.
func (r *CapacityReporter) Start(ctx context.Context) {
	go r.runLoop(ctx)
	log.Printf("capacity_reporter: started (cell=%s interval=%s threshold=%d%%)",
		r.cellID, r.interval, memPressureThresholdPct)
}

// Stop signals the loop to exit and waits for it to finish.
func (r *CapacityReporter) Stop() {
	r.once.Do(func() { close(r.stopCh) })
	<-r.doneCh
}

func (r *CapacityReporter) runLoop(ctx context.Context) {
	defer close(r.doneCh)
	r.emit(ctx)
	t := time.NewTicker(r.interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-r.stopCh:
			return
		case <-t.C:
			r.emit(ctx)
		}
	}
}

func (r *CapacityReporter) emit(ctx context.Context) {
	healthy, available, running := r.source.Capacity()

	payload, err := json.Marshal(capacityPayload{
		HealthyWorkers:   healthy,
		AvailableWorkers: available,
		RunningSandboxes: running,
	})
	if err != nil {
		log.Printf("capacity_reporter: marshal payload: %v", err)
		return
	}
	body, err := json.Marshal(capacityEnvelope{
		ID:        uuid.NewString(),
		Type:      "cell_capacity",
		CellID:    r.cellID,
		Payload:   payload,
		Timestamp: time.Now(),
	})
	if err != nil {
		log.Printf("capacity_reporter: marshal envelope: %v", err)
		return
	}

	xaddCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := r.rdb.XAdd(xaddCtx, &redis.XAddArgs{
		Stream: r.streamKey,
		MaxLen: reporterStreamMaxLen,
		Approx: true,
		Values: map[string]interface{}{"event": string(body)},
	}).Err(); err != nil {
		log.Printf("capacity_reporter: XADD failed: %v (cell=%s)", err, r.cellID)
		return
	}
}
