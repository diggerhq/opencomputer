package controlplane

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// EventForwarder drains the local Redis Stream events:{cell_id} and POSTs
// HMAC-signed batches to the CF events-ingest Worker. It is the only
// back-channel from a regional control plane to the global Cloudflare layer.
//
// Lifecycle:
//   - Start: ensures consumer group "cf-forwarder" exists (XGROUP CREATE MKSTREAM,
//     idempotent — ignores BUSYGROUP).
//   - readLoop: XREADGROUP Count: 500 Block: 5s, dispatch to CFEventClient,
//     XAck on success, leave in PEL on retry-able error.
//   - reclaimLoop: XAUTOCLAIM every 30s with MinIdle: 60s — recovers messages
//     left pending by a crashed instance.
//   - 4xx (non-429): poison pill — XAck, log, drop.
type EventForwarder struct {
	rdb       *redis.Client
	streamKey string // events:{cell_id}
	groupName string // "cf-forwarder"
	consumer  string

	client    *CFEventClient
	batchSize int64
	blockDur  time.Duration

	stopCh chan struct{}
	doneCh chan struct{}
	wg     sync.WaitGroup
	once   sync.Once
}

// EventForwarderConfig configures the forwarder.
type EventForwarderConfig struct {
	Redis    *redis.Client
	CellID   string
	Client   *CFEventClient
	Consumer string // optional, defaults to hostname:pid
}

// NewEventForwarder constructs a forwarder. Caller must Start it.
func NewEventForwarder(cfg EventForwarderConfig) (*EventForwarder, error) {
	if cfg.Redis == nil {
		return nil, errors.New("event_forwarder: Redis client required")
	}
	if cfg.CellID == "" {
		return nil, errors.New("event_forwarder: CellID required")
	}
	if cfg.Client == nil {
		return nil, errors.New("event_forwarder: CFEventClient required")
	}
	consumer := cfg.Consumer
	if consumer == "" {
		host, _ := os.Hostname()
		consumer = fmt.Sprintf("%s-%d", host, os.Getpid())
	}
	return &EventForwarder{
		rdb:       cfg.Redis,
		streamKey: "events:" + cfg.CellID,
		groupName: "cf-forwarder",
		consumer:  consumer,
		client:    cfg.Client,
		batchSize: 500,
		blockDur:  5 * time.Second,
		stopCh:    make(chan struct{}),
		doneCh:    make(chan struct{}),
	}, nil
}

// Start begins read + reclaim loops. Idempotent.
func (f *EventForwarder) Start(ctx context.Context) error {
	// Create the consumer group; ignore BUSYGROUP (already exists).
	if err := f.rdb.XGroupCreateMkStream(ctx, f.streamKey, f.groupName, "$").Err(); err != nil {
		// go-redis returns the raw error string; check for the BUSYGROUP suffix.
		if !isBusyGroup(err) {
			return fmt.Errorf("create consumer group: %w", err)
		}
	}

	f.wg.Add(2)
	go f.readLoop(ctx)
	go f.reclaimLoop(ctx)
	go func() {
		f.wg.Wait()
		close(f.doneCh)
	}()
	log.Printf("event_forwarder: started (stream=%s group=%s consumer=%s)", f.streamKey, f.groupName, f.consumer)
	return nil
}

// Stop gracefully shuts down. Drains in-flight ack on best-effort basis.
func (f *EventForwarder) Stop(ctx context.Context) error {
	f.once.Do(func() { close(f.stopCh) })
	select {
	case <-f.doneCh:
	case <-ctx.Done():
		return ctx.Err()
	}
	return nil
}

func (f *EventForwarder) readLoop(ctx context.Context) {
	defer f.wg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case <-f.stopCh:
			return
		default:
		}

		streams, err := f.rdb.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group:    f.groupName,
			Consumer: f.consumer,
			Streams:  []string{f.streamKey, ">"},
			Count:    f.batchSize,
			Block:    f.blockDur,
		}).Result()

		if err != nil {
			if errors.Is(err, redis.Nil) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				continue
			}
			log.Printf("event_forwarder: XREADGROUP error: %v", err)
			select {
			case <-time.After(2 * time.Second):
			case <-ctx.Done():
				return
			case <-f.stopCh:
				return
			}
			continue
		}

		for _, s := range streams {
			f.processBatch(ctx, s.Messages)
		}
	}
}

func (f *EventForwarder) reclaimLoop(ctx context.Context) {
	defer f.wg.Done()
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-f.stopCh:
			return
		case <-ticker.C:
			f.reclaimOnce(ctx)
		}
	}
}

// reclaimOnce recovers messages whose previous owning consumer died (e.g. a CP
// restart left entries in the PEL). Both XAUTOCLAIM and XPENDING's IDLE filter
// are Redis 6.2+ features; prod runs Azure Cache for Redis 6.0, where they fail
// every 30s ("ERR unknown command 'xautoclaim'" / "ERR syntax error"
// respectively), stranding events after a restart. So we use *plain* XPENDING
// (5.0+) to enumerate the whole PEL and let XCLAIM's MinIdle (5.0+) gate which
// entries are stale enough to steal — fresh, in-flight messages fail the
// MinIdle check and are left to their current owner.
func (f *EventForwarder) reclaimOnce(ctx context.Context) {
	start := "-"
	const batch = 100
	for {
		pending, err := f.rdb.XPendingExt(ctx, &redis.XPendingExtArgs{
			Stream: f.streamKey,
			Group:  f.groupName,
			Start:  start,
			End:    "+",
			Count:  batch,
		}).Result()
		if err != nil {
			log.Printf("event_forwarder: XPENDING error: %v", err)
			return
		}
		if len(pending) == 0 {
			return
		}
		ids := make([]string, 0, len(pending))
		for _, p := range pending {
			ids = append(ids, p.ID)
		}
		msgs, err := f.rdb.XClaim(ctx, &redis.XClaimArgs{
			Stream:   f.streamKey,
			Group:    f.groupName,
			Consumer: f.consumer,
			MinIdle:  60 * time.Second,
			Messages: ids,
		}).Result()
		if err != nil {
			log.Printf("event_forwarder: XCLAIM error (%d ids): %v", len(ids), err)
			return
		}
		if len(msgs) > 0 {
			f.processBatch(ctx, msgs)
		}
		// Next page starts strictly after the last id we just processed; if the
		// batch was short, we're done.
		if len(pending) < batch {
			return
		}
		// Append "-0" terminator-free? Redis IDs are inclusive on both ends; the
		// stream-id immediately following N-S is N-(S+1). Using the last id + " "
		// is wrong — use the exclusive form "(<id>" introduced in Redis 6.2 if
		// available, else fall back to bumping the sequence. Bumping is safer
		// across versions: split ms-seq, increment seq, format back.
		last := pending[len(pending)-1].ID
		start = bumpStreamID(last)
		if start == "" {
			return
		}
	}
}

// bumpStreamID returns the stream id immediately after the given one. Redis
// stream ids are "<ms>-<seq>"; the next id is "<ms>-<seq+1>". Used so the
// next XPENDING window doesn't re-fetch the entry we just processed.
func bumpStreamID(id string) string {
	dash := -1
	for i := len(id) - 1; i >= 0; i-- {
		if id[i] == '-' {
			dash = i
			break
		}
	}
	if dash <= 0 || dash == len(id)-1 {
		return ""
	}
	msPart := id[:dash]
	seqPart := id[dash+1:]
	seq := 0
	for _, c := range seqPart {
		if c < '0' || c > '9' {
			return ""
		}
		seq = seq*10 + int(c-'0')
	}
	return msPart + "-" + strconv.Itoa(seq+1)
}

// processBatch serializes a batch and dispatches via the CF client. Acks on
// success or permanent error, leaves in PEL on retryable failure.
//
// Per-entry validation: malformed JSON is poison — acked and dropped immediately
// rather than left in the PEL where it would block progress on every retry.
func (f *EventForwarder) processBatch(ctx context.Context, msgs []redis.XMessage) {
	if len(msgs) == 0 {
		return
	}

	envelopes := make([]json.RawMessage, 0, len(msgs))
	idsBySource := make([]string, 0, len(msgs))
	for _, m := range msgs {
		raw, ok := m.Values["event"]
		if !ok {
			log.Printf("event_forwarder: stream entry %s missing 'event' field — acking and dropping", m.ID)
			f.ack(ctx, m.ID)
			continue
		}
		s, ok := raw.(string)
		if !ok {
			log.Printf("event_forwarder: stream entry %s 'event' field not a string — acking and dropping", m.ID)
			f.ack(ctx, m.ID)
			continue
		}
		// Per-entry JSON validation. Without this, a single malformed entry
		// poisons the whole batch (json.Marshal of []json.RawMessage validates
		// every element) and the forwarder retries forever.
		if !json.Valid([]byte(s)) {
			preview := s
			if len(preview) > 120 {
				preview = preview[:120] + "..."
			}
			log.Printf("event_forwarder: stream entry %s has invalid JSON — acking and dropping; preview=%q", m.ID, preview)
			f.ack(ctx, m.ID)
			continue
		}
		envelopes = append(envelopes, json.RawMessage(s))
		idsBySource = append(idsBySource, m.ID)
	}
	if len(envelopes) == 0 {
		return
	}

	body, err := json.Marshal(envelopes)
	if err != nil {
		// All entries individually validated above, so this should be unreachable.
		// If it ever fires, log loudly and leave entries in PEL for inspection.
		log.Printf("event_forwarder: BUG: marshal batch failed despite per-entry validation: %v — leaving %d msgs in PEL", err, len(envelopes))
		return
	}

	sendCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	err = f.client.SendBatch(sendCtx, body)
	switch {
	case err == nil:
		f.ack(ctx, idsBySource...)
	case errors.Is(err, ErrPermanent):
		log.Printf("event_forwarder: poison-pill batch (%d msgs): %v — acking and dropping", len(envelopes), err)
		f.ack(ctx, idsBySource...)
	default:
		log.Printf("event_forwarder: batch send failed (%d msgs): %v — leaving in PEL", len(envelopes), err)
	}
}

func (f *EventForwarder) ack(ctx context.Context, ids ...string) {
	if len(ids) == 0 {
		return
	}
	if err := f.rdb.XAck(ctx, f.streamKey, f.groupName, ids...).Err(); err != nil {
		log.Printf("event_forwarder: XACK error: %v", err)
	}
}

func isBusyGroup(err error) bool {
	return err != nil && strings.Contains(err.Error(), "BUSYGROUP")
}
