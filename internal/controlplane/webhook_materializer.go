package controlplane

import (
	"context"
	"log"
	"time"

	"github.com/opensandbox/opensandbox/internal/db"
)

// WebhookMaterializer turns canonical sandbox_lifecycle_events into
// webhook_deliveries rows — the single place delivery rows are created (the
// match / filter / watermark / metadata logic lives in the store). It runs on a
// short tick and drains the backlog each pass. Needs only Postgres, so it runs
// in combined mode too (CP-origin events still flow without Redis).
//
// See .agents/work/sandbox-lifecycle-webhooks.md §5.
type WebhookMaterializer struct {
	store    *db.Store
	interval time.Duration
	batch    int
	stop     chan struct{}
	stopped  chan struct{}
}

func NewWebhookMaterializer(store *db.Store) *WebhookMaterializer {
	return &WebhookMaterializer{
		store:    store,
		interval: 1 * time.Second,
		batch:    100,
		stop:     make(chan struct{}),
		stopped:  make(chan struct{}),
	}
}

func (m *WebhookMaterializer) Start() { go m.loop() }

func (m *WebhookMaterializer) Stop() {
	close(m.stop)
	<-m.stopped
}

func (m *WebhookMaterializer) loop() {
	defer close(m.stopped)
	tick := time.NewTicker(m.interval)
	defer tick.Stop()
	for {
		select {
		case <-m.stop:
			return
		case <-tick.C:
			m.drainSafe()
		}
	}
}

func (m *WebhookMaterializer) drainSafe() {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("webhook_materializer: recovered from panic: %v", r)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Minute)
	defer cancel()
	for {
		n, err := m.store.MaterializePendingLifecycleEvents(ctx, m.batch)
		if err != nil {
			log.Printf("webhook_materializer: materialize: %v", err)
			return
		}
		if n < m.batch {
			return // backlog drained for now
		}
	}
}
