package controlplane

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"github.com/opensandbox/opensandbox/internal/db"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// LifecycleIngress is the worker-origin half of the webhook pipeline: it consumes
// the events:{cell_id} Redis stream with its own consumer group and materializes
// the webhook-eligible worker events into the canonical sandbox_lifecycle_events
// table (via the single recordLifecycleEvent primitive). CP-origin events
// (stopped/hibernated/resumed) are recorded in-tx and are intentionally NOT
// handled here — this consumer maps only the worker-origin types below.
//
// Independent of EventForwarder's consumer group (each group gets its own copy of
// the stream). Reclaim mirrors event_forwarder: plain XPENDING + XCLAIM JUSTID
// (Azure Redis 6.0 lacks XAUTOCLAIM). See §5 / §12 of the design doc.
type LifecycleIngress struct {
	rdb       *redis.Client
	store     *db.Store
	streamKey string
	groupName string
	consumer  string
	batchSize int64
	blockDur  time.Duration

	stopCh chan struct{}
	doneCh chan struct{}
	wg     sync.WaitGroup
	once   sync.Once
}

// ingressTypeMap maps the internal worker event strings to public lifecycle
// types. Only these worker-origin events become webhooks via the ingress; every
// other stream entry is acked and ignored by this consumer group.
//
// Notes:
//   - No "running" entry: the worker emits no post-boot stream event (sessions
//     are created directly as running), so sandbox.ready is recorded CP-side.
//   - No "migrated" entry: the worker never emits "migrated"; it's recorded
//     CP-side in CompleteMigration (the migration-completion funnel).
//   - "woke" is the worker's wake signal (grpc_server.go WakeSandbox) → resumed.
var ingressTypeMap = map[string]string{
	"created": types.WebhookEventCreated,
	"woke":    types.WebhookEventResumed,
}

// normalizeIngressData maps an internal worker payload to the PUBLIC event.data
// contract (the worker logs include internal fields like sandbox_id; the public
// data is clean camelCase per docs). created → {template}; everything else → {}.
func normalizeIngressData(publicType string, payload json.RawMessage) json.RawMessage {
	if publicType == types.WebhookEventCreated {
		var p struct {
			Template string `json:"template"`
		}
		_ = json.Unmarshal(payload, &p)
		b, _ := json.Marshal(map[string]string{"template": p.Template})
		return b
	}
	return json.RawMessage("{}")
}

// streamLifecycleEnvelope is the subset of the stream "event" payload we need.
// Both the worker publisher and the CP PublishLifecycle helper share these keys.
type streamLifecycleEnvelope struct {
	ID        string          `json:"id"`
	Type      string          `json:"type"`
	SandboxID string          `json:"sandbox_id"`
	OrgID     string          `json:"org_id"`
	Payload   json.RawMessage `json:"payload"`
	Timestamp string          `json:"timestamp"`
}

// NewLifecycleIngress constructs the ingress. Caller must Start it. Requires a
// Redis client (server mode) and the cell id (the stream is events:{cellID}).
func NewLifecycleIngress(rdb *redis.Client, store *db.Store, cellID string) (*LifecycleIngress, error) {
	if rdb == nil {
		return nil, errors.New("lifecycle_ingress: Redis client required")
	}
	if store == nil {
		return nil, errors.New("lifecycle_ingress: store required")
	}
	if cellID == "" {
		return nil, errors.New("lifecycle_ingress: cellID required")
	}
	host, _ := os.Hostname()
	return &LifecycleIngress{
		rdb:       rdb,
		store:     store,
		streamKey: "events:" + cellID,
		groupName: "webhook-ingress",
		consumer:  fmt.Sprintf("%s-%d", host, os.Getpid()),
		batchSize: 200,
		blockDur:  5 * time.Second,
		stopCh:    make(chan struct{}),
		doneCh:    make(chan struct{}),
	}, nil
}

func (g *LifecycleIngress) Start(ctx context.Context) error {
	if err := g.rdb.XGroupCreateMkStream(ctx, g.streamKey, g.groupName, "$").Err(); err != nil {
		if !isBusyGroup(err) {
			return fmt.Errorf("lifecycle_ingress: create consumer group: %w", err)
		}
	}
	g.wg.Add(2)
	go g.readLoop(ctx)
	go g.reclaimLoop(ctx)
	go func() {
		g.wg.Wait()
		close(g.doneCh)
	}()
	log.Printf("lifecycle_ingress: started (stream=%s group=%s consumer=%s)", g.streamKey, g.groupName, g.consumer)
	return nil
}

func (g *LifecycleIngress) Stop(ctx context.Context) error {
	g.once.Do(func() { close(g.stopCh) })
	select {
	case <-g.doneCh:
	case <-ctx.Done():
		return ctx.Err()
	}
	return nil
}

func (g *LifecycleIngress) readLoop(ctx context.Context) {
	defer g.wg.Done()
	for {
		select {
		case <-ctx.Done():
			return
		case <-g.stopCh:
			return
		default:
		}
		streams, err := g.rdb.XReadGroup(ctx, &redis.XReadGroupArgs{
			Group:    g.groupName,
			Consumer: g.consumer,
			Streams:  []string{g.streamKey, ">"},
			Count:    g.batchSize,
			Block:    g.blockDur,
		}).Result()
		if err != nil {
			if errors.Is(err, redis.Nil) || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				continue
			}
			log.Printf("lifecycle_ingress: XREADGROUP error: %v", err)
			select {
			case <-time.After(2 * time.Second):
			case <-ctx.Done():
				return
			case <-g.stopCh:
				return
			}
			continue
		}
		for _, s := range streams {
			for _, m := range s.Messages {
				g.process(ctx, m)
			}
		}
	}
}

func (g *LifecycleIngress) reclaimLoop(ctx context.Context) {
	defer g.wg.Done()
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-g.stopCh:
			return
		case <-ticker.C:
			g.reclaimOnce(ctx)
		}
	}
}

// reclaimOnce recovers entries whose owning consumer died. Plain XPENDING + XCLAIM
// JUSTID with MinIdle (Azure Redis 6.0 compatible — no XAUTOCLAIM/IDLE filter).
func (g *LifecycleIngress) reclaimOnce(ctx context.Context) {
	start := "-"
	const batch = 100
	for {
		pending, err := g.rdb.XPendingExt(ctx, &redis.XPendingExtArgs{
			Stream: g.streamKey,
			Group:  g.groupName,
			Start:  start,
			End:    "+",
			Count:  batch,
		}).Result()
		if err != nil {
			log.Printf("lifecycle_ingress: XPENDING error: %v", err)
			return
		}
		if len(pending) == 0 {
			return
		}
		ids := make([]string, 0, len(pending))
		for _, p := range pending {
			ids = append(ids, p.ID)
		}
		claimed, err := g.rdb.XClaimJustID(ctx, &redis.XClaimArgs{
			Stream:   g.streamKey,
			Group:    g.groupName,
			Consumer: g.consumer,
			MinIdle:  60 * time.Second,
			Messages: ids,
		}).Result()
		if err != nil {
			log.Printf("lifecycle_ingress: XCLAIM error (%d ids): %v", len(ids), err)
			return
		}
		for _, id := range claimed {
			entries, rerr := g.rdb.XRange(ctx, g.streamKey, id, id).Result()
			if rerr != nil {
				log.Printf("lifecycle_ingress: XRANGE %s error: %v", id, rerr)
				continue
			}
			if len(entries) == 0 {
				g.ack(ctx, id) // trimmed away — clear the orphaned PEL entry
				continue
			}
			g.process(ctx, entries[0])
		}
		if len(pending) < batch {
			return
		}
		start = bumpStreamID(pending[len(pending)-1].ID)
		if start == "" {
			return
		}
	}
}

// process handles one stream entry: map to a public lifecycle type, record the
// canonical event, and ack. Irrelevant/malformed entries are acked and dropped;
// a transient store error leaves the entry in the PEL for reclaim.
func (g *LifecycleIngress) process(ctx context.Context, m redis.XMessage) {
	raw, ok := m.Values["event"].(string)
	if !ok || !json.Valid([]byte(raw)) {
		g.ack(ctx, m.ID)
		return
	}
	var env streamLifecycleEnvelope
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		g.ack(ctx, m.ID)
		return
	}
	publicType, eligible := ingressTypeMap[env.Type]
	if !eligible {
		g.ack(ctx, m.ID) // not a webhook-eligible worker event
		return
	}
	if env.OrgID == "" || env.SandboxID == "" {
		log.Printf("lifecycle_ingress: %s (%s) missing org/sandbox — dropping", m.ID, env.Type)
		g.ack(ctx, m.ID)
		return
	}
	orgID, err := uuid.Parse(env.OrgID)
	if err != nil {
		g.ack(ctx, m.ID)
		return
	}
	ts := time.Now().UTC()
	if env.Timestamp != "" {
		if t, perr := time.Parse(time.RFC3339Nano, env.Timestamp); perr == nil {
			ts = t
		}
	}
	id := env.ID
	if id == "" {
		id = fmt.Sprintf("%s:%s:%s", env.SandboxID, env.Type, m.ID)
	}
	// Map the internal worker payload to the public event.data contract.
	data := normalizeIngressData(publicType, env.Payload)
	if err := g.store.RecordLifecycleEvent(ctx, db.LifecycleEvent{
		ID:        id,
		OrgID:     orgID,
		SandboxID: env.SandboxID,
		Type:      publicType,
		Data:      data,
		Ts:        ts,
	}); err != nil {
		log.Printf("lifecycle_ingress: record %s: %v — leaving in PEL", id, err)
		return // do not ack; reclaim retries
	}
	g.ack(ctx, m.ID)
}

func (g *LifecycleIngress) ack(ctx context.Context, ids ...string) {
	if len(ids) == 0 {
		return
	}
	if err := g.rdb.XAck(ctx, g.streamKey, g.groupName, ids...).Err(); err != nil {
		log.Printf("lifecycle_ingress: XACK error: %v", err)
	}
}
