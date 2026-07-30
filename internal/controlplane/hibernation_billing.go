package controlplane

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/opensandbox/opensandbox/internal/db"
)

// syntheticSandboxEvent mirrors the JSON shape of
// worker.SandboxEventEnvelope (kept local here because controlplane cannot
// import worker without a cycle). Only the fields events-ingest actually reads
// are declared.
type syntheticSandboxEvent struct {
	ID        string          `json:"id"`
	Type      string          `json:"type"`
	SandboxID string          `json:"sandbox_id"`
	OrgID     string          `json:"org_id,omitempty"`
	WorkerID  string          `json:"worker_id"`
	CellID    string          `json:"cell_id"`
	Payload   json.RawMessage `json:"payload"`
	Timestamp time.Time       `json:"timestamp"`
}

// HibernationBillingSweeper closes the "billed for the lifetime of the sandbox
// — running or hibernated" gap.
//
// Running sandboxes emit a `usage_tick` every 20s from the worker's ticker;
// events-ingest lands them in `usage_samples` on the edge, autumn_meter reads
// disk_mb per row and bills overage. Hibernated sandboxes have no running VM
// on any worker so no organic tick fires, yet the qcow2 still sits in Tigris
// consuming real storage cost — this sweeper mints the missing signal.
//
// Every `interval`, query the cell's PG for hibernated sandboxes whose current
// disk_mb exceeds the 20 GB free allowance, wrap each into a synthetic
// `usage_tick` envelope (memory_mb=0, cpu_count=0, disk_mb=<current>), batch,
// and POST to events-ingest via the same HMAC-signed path the CF forwarder
// uses. events-ingest INSERTs into `usage_samples` with the same
// `ON CONFLICT(id) DO NOTHING` dedup as organic ticks, and autumn_meter
// naturally aggregates the disk-overage column across all rows in the bucket
// — a synthetic hibernated row is indistinguishable from an organic running
// row at the aggregation layer.
//
// The synthetic event's ID is deterministic per (sandbox, bucket-start) so a
// retry after a partial batch failure deduplicates cleanly at events-ingest.
// worker_id is intentionally empty: the zombie-tick guard drops mismatches
// but treats missing worker_id as "unknown, allow" (hibernated boxes have no
// live owner to match against).
type HibernationBillingSweeper struct {
	store    *db.Store
	client   *CFEventClient
	cellID   string
	interval time.Duration

	stopCh chan struct{}
	doneCh chan struct{}
	once   sync.Once
}

// NewHibernationBillingSweeper wires the sweeper. A nil store or client
// returns nil (sweeper disabled — matches the CFEventClient's own opt-in
// behavior when the events endpoint isn't configured).
func NewHibernationBillingSweeper(store *db.Store, client *CFEventClient, cellID string, interval time.Duration) *HibernationBillingSweeper {
	if store == nil || client == nil || cellID == "" {
		return nil
	}
	if interval <= 0 {
		interval = 5 * time.Minute // matches autumn_meter bucket size
	}
	return &HibernationBillingSweeper{
		store:    store,
		client:   client,
		cellID:   cellID,
		interval: interval,
		stopCh:   make(chan struct{}),
		doneCh:   make(chan struct{}),
	}
}

// Start begins the sweep loop. Safe to call once.
func (s *HibernationBillingSweeper) Start(ctx context.Context) {
	go s.loop(ctx)
}

// Stop signals the loop to exit and waits for it to drain.
func (s *HibernationBillingSweeper) Stop(ctx context.Context) error {
	s.once.Do(func() { close(s.stopCh) })
	select {
	case <-s.doneCh:
	case <-ctx.Done():
		return ctx.Err()
	}
	return nil
}

func (s *HibernationBillingSweeper) loop(ctx context.Context) {
	defer close(s.doneCh)
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	// First sweep runs immediately so a hibernated sandbox created just before
	// process start doesn't wait a full interval for its first bill.
	s.safeSweep(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.stopCh:
			return
		case <-ticker.C:
			s.safeSweep(ctx)
		}
	}
}

func (s *HibernationBillingSweeper) safeSweep(ctx context.Context) {
	defer func() {
		if v := recover(); v != nil {
			log.Printf("hibernation_billing: recovered from panic: %v", v)
		}
	}()
	s.sweep(ctx)
}

func (s *HibernationBillingSweeper) sweep(ctx context.Context) {
	rows, err := s.store.ListHibernatedSandboxesForBilling(ctx)
	if err != nil {
		log.Printf("hibernation_billing: list failed: %v", err)
		return
	}
	if len(rows) == 0 {
		return
	}

	// Bucket the tick to the current 5-minute wall boundary so the synthetic
	// event ID is deterministic across retries. A retry within the same bucket
	// dedupes at events-ingest (ON CONFLICT DO NOTHING on id).
	now := time.Now()
	bucketStart := now.Unix() / 300 * 300
	intervalSec := int(s.interval / time.Second)

	envelopes := make([]syntheticSandboxEvent, 0, len(rows))
	for _, r := range rows {
		payload, err := json.Marshal(map[string]interface{}{
			"sandbox_id": r.SandboxID,
			"cost_cents": 0,
			"interval_s": intervalSec,
			"memory_mb":  0,
			"cpu_count":  0,
			"disk_mb":    r.DiskMB,
		})
		if err != nil {
			log.Printf("hibernation_billing: marshal payload for %s failed: %v", r.SandboxID, err)
			continue
		}
		envelopes = append(envelopes, syntheticSandboxEvent{
			ID:        fmt.Sprintf("hibernated:%s:%d", r.SandboxID, bucketStart),
			Type:      "usage_tick",
			SandboxID: r.SandboxID,
			OrgID:     r.OrgID,
			WorkerID:  "", // intentionally empty — no live owner while hibernated
			CellID:    s.cellID,
			Payload:   payload,
			Timestamp: now,
		})
	}
	if len(envelopes) == 0 {
		return
	}

	body, err := json.Marshal(envelopes)
	if err != nil {
		log.Printf("hibernation_billing: marshal batch failed: %v", err)
		return
	}
	sendCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := s.client.SendBatch(sendCtx, body); err != nil {
		log.Printf("hibernation_billing: send batch (%d envelopes) failed: %v", len(envelopes), err)
		return
	}
	log.Printf("hibernation_billing: emitted %d disk-overage ticks for bucket=%d", len(envelopes), bucketStart)
}
