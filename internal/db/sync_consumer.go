package db

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
)

// SyncConsumer reads sandbox events from NATS JetStream and writes them to PostgreSQL.
type SyncConsumer struct {
	store *Store
	nc    *nats.Conn
	js    nats.JetStreamContext
	sub   *nats.Subscription
	stop  chan struct{}
	wg    sync.WaitGroup
}

// NATSEvent is the event payload from workers.
type NATSEvent struct {
	Type      string          `json:"type"`
	SandboxID string          `json:"sandbox_id"`
	WorkerID  string          `json:"worker_id"`
	Region    string          `json:"region"`
	Payload   json.RawMessage `json:"payload"`
	Timestamp time.Time       `json:"timestamp"`
}

// NewSyncConsumer creates a new NATS-to-PG sync consumer.
func NewSyncConsumer(store *Store, natsURL string) (*SyncConsumer, error) {
	nc, err := nats.Connect(natsURL,
		nats.RetryOnFailedConnect(true),
		nats.MaxReconnects(-1),
		nats.ReconnectWait(2*time.Second),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to NATS: %w", err)
	}

	js, err := nc.JetStream()
	if err != nil {
		nc.Close()
		return nil, fmt.Errorf("failed to get JetStream context: %w", err)
	}

	// Ensure the stream exists
	_, _ = js.AddStream(&nats.StreamConfig{
		Name:     "SANDBOX_EVENTS",
		Subjects: []string{"sandbox.events.>"},
		MaxAge:   7 * 24 * time.Hour,
	})

	return &SyncConsumer{
		store: store,
		nc:    nc,
		js:    js,
		stop:  make(chan struct{}),
	}, nil
}

// Start begins consuming events from NATS and writing to PG.
func (c *SyncConsumer) Start() error {
	// Subscribe to all sandbox events with a durable consumer
	sub, err := c.js.Subscribe("sandbox.events.>", c.handleMessage,
		nats.Durable("pg-sync-consumer"),
		nats.AckExplicit(),
		nats.MaxAckPending(256),
	)
	if err != nil {
		return fmt.Errorf("failed to subscribe: %w", err)
	}
	c.sub = sub
	log.Println("sync_consumer: subscribed to sandbox.events.>")

	// Also subscribe to worker heartbeats (regular NATS, not JetStream)
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		heartbeatSub, err := c.nc.Subscribe("workers.heartbeat.>", c.handleHeartbeat)
		if err != nil {
			log.Printf("sync_consumer: failed to subscribe to heartbeats: %v", err)
			return
		}
		defer heartbeatSub.Unsubscribe()
		<-c.stop
	}()

	return nil
}

// Stop stops the consumer.
func (c *SyncConsumer) Stop() {
	close(c.stop)
	if c.sub != nil {
		c.sub.Unsubscribe()
	}
	c.wg.Wait()
	c.nc.Close()
}

func (c *SyncConsumer) handleMessage(msg *nats.Msg) {
	var event NATSEvent
	if err := json.Unmarshal(msg.Data, &event); err != nil {
		log.Printf("sync_consumer: failed to unmarshal event: %v", err)
		msg.Ack()
		return
	}

	switch event.Type {
	case "command":
		c.handleCommandEvent(event)
	case "pty_start", "pty_end":
		c.handlePTYEvent(event)
	case "created", "destroyed":
		log.Printf("sync_consumer: lifecycle event %s for sandbox %s", event.Type, event.SandboxID)
	default:
		log.Printf("sync_consumer: unknown event type %s for sandbox %s", event.Type, event.SandboxID)
	}

	msg.Ack()
}

func (c *SyncConsumer) handleCommandEvent(event NATSEvent) {
	var payload struct {
		SandboxID  string   `json:"sandbox_id"`
		Command    string   `json:"command"`
		Args       []string `json:"args"`
		Cwd        string   `json:"cwd"`
		ExitCode   *int     `json:"exit_code"`
		DurationMs *int     `json:"duration_ms"`
	}
	if err := json.Unmarshal(event.Payload, &payload); err != nil {
		log.Printf("sync_consumer: failed to unmarshal command payload: %v", err)
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := c.store.InsertCommandLog(
		ctx, event.SandboxID, payload.Command, payload.Args, payload.Cwd,
		payload.ExitCode, payload.DurationMs,
	); err != nil {
		log.Printf("sync_consumer: failed to insert command log: %v", err)
	}
}

func (c *SyncConsumer) handlePTYEvent(event NATSEvent) {
	log.Printf("sync_consumer: PTY event %s for sandbox %s", event.Type, event.SandboxID)
}

func (c *SyncConsumer) handleHeartbeat(msg *nats.Msg) {
	var heartbeat struct {
		WorkerID string  `json:"worker_id"`
		Region   string  `json:"region"`
		GRPCAddr string  `json:"grpc_addr"`
		HTTPAddr string  `json:"http_addr"`
		Capacity int     `json:"capacity"`
		Current  int     `json:"current"`
		CPUPct   float64 `json:"cpu_pct"`
		MemPct   float64 `json:"mem_pct"`
	}
	if err := json.Unmarshal(msg.Data, &heartbeat); err != nil {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	worker := &Worker{
		ID:           heartbeat.WorkerID,
		Region:       heartbeat.Region,
		GRPCAddr:     heartbeat.GRPCAddr,
		HTTPAddr:     heartbeat.HTTPAddr,
		Capacity:     heartbeat.Capacity,
		CurrentCount: heartbeat.Current,
		Status:       "healthy",
	}
	if err := c.store.UpsertWorker(ctx, worker); err != nil {
		log.Printf("sync_consumer: failed to upsert worker: %v", err)
	}
}
