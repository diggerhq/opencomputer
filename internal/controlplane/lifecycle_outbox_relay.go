package controlplane

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/opensandbox/opensandbox/internal/cellevents"
	"github.com/opensandbox/opensandbox/internal/db"
)

// LifecycleOutboxRelay drains the in-tx lifecycle outbox (sandbox_lifecycle_events,
// written transactionally by CP-origin transitions) and publishes each event to
// the cell's events:{cell} stream, where it reaches the edge → Svix exactly like
// worker-origin events. Only events that successfully publish are marked relayed,
// so a Redis hiccup is retried on the next tick (durability preserved); a stable
// event id makes the at-least-once re-publish idempotent at the edge and at Svix.
//
// Replaces the old WebhookMaterializer + WebhookDispatcher: OC no longer fans out
// or tracks delivery state — Svix owns that.
// See .agents/work/sandbox-webhooks-rearchitecture.md.
type LifecycleOutboxRelay struct {
	store    *db.Store
	rdb      *redis.Client
	cellID   string
	interval time.Duration
	batch    int
	stop     chan struct{}
	stopped  chan struct{}
}

func NewLifecycleOutboxRelay(store *db.Store, rdb *redis.Client, cellID string) *LifecycleOutboxRelay {
	return &LifecycleOutboxRelay{
		store:    store,
		rdb:      rdb,
		cellID:   cellID,
		interval: 1 * time.Second,
		batch:    100,
		stop:     make(chan struct{}),
		stopped:  make(chan struct{}),
	}
}

func (r *LifecycleOutboxRelay) Start() { go r.loop() }

func (r *LifecycleOutboxRelay) Stop() {
	close(r.stop)
	<-r.stopped
}

func (r *LifecycleOutboxRelay) loop() {
	defer close(r.stopped)
	tick := time.NewTicker(r.interval)
	defer tick.Stop()
	for {
		select {
		case <-r.stop:
			return
		case <-tick.C:
			r.drainSafe()
		}
	}
}

func (r *LifecycleOutboxRelay) drainSafe() {
	defer func() {
		if rec := recover(); rec != nil {
			log.Printf("lifecycle_outbox_relay: recovered from panic: %v", rec)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Minute)
	defer cancel()
	for {
		rows, err := r.store.DrainLifecycleOutbox(ctx, r.batch)
		if err != nil {
			log.Printf("lifecycle_outbox_relay: drain: %v", err)
			return
		}
		if len(rows) == 0 {
			return
		}
		sent := make([]string, 0, len(rows))
		for _, row := range rows {
			var data map[string]any
			if len(row.Data) > 0 {
				_ = json.Unmarshal(row.Data, &data)
			}
			if cellevents.PublishLifecycleEvent(ctx, r.rdb, r.cellID, cellevents.LifecycleEvent{
				ID:        row.ID,
				Type:      row.Type,
				SandboxID: row.SandboxID,
				OrgID:     row.OrgID,
				Data:      data,
				Ts:        row.Ts,
			}) {
				sent = append(sent, row.ID)
			}
		}
		if len(sent) > 0 {
			if err := r.store.MarkLifecycleOutboxSent(ctx, sent); err != nil {
				log.Printf("lifecycle_outbox_relay: mark sent (%d): %v", len(sent), err)
				return // retry next tick; the re-publish is idempotent via the stable id
			}
		}
		if len(rows) < r.batch {
			return
		}
	}
}
