package db

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Sandbox lifecycle webhooks store layer. The wire/types mapping lives in the
// API layer (internal/db stays decoupled from pkg/types); methods here return
// db row structs and operate on raw SQL via the shared pool.
//
// See .agents/work/sandbox-lifecycle-webhooks.md for the full design.

// Sentinel errors surfaced to the API layer.
var (
	ErrWebhookNotFound            = errors.New("webhook destination not found")
	ErrWebhookNameConflict        = errors.New("webhook name already used with a different config")
	ErrWebhookIdempotencyConflict = errors.New("idempotency key reused with a different request")
	ErrEncryptionNotConfigured    = errors.New("secret encryption not configured")
)

// newWebhookID mints a prefixed random id, e.g. "whk_" / "whd_" + 24 hex chars.
func newWebhookID(prefix string) string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return prefix + hex.EncodeToString(b[:])
}

// ---------------------------------------------------------------------------
// Canonical lifecycle events (the single recordLifecycleEvent primitive)
// ---------------------------------------------------------------------------

// LifecycleEvent is one canonical sandbox lifecycle moment.
type LifecycleEvent struct {
	ID        string // deterministic event id (dedup key)
	OrgID     uuid.UUID
	SandboxID string
	Type      string          // public type, e.g. "sandbox.stopped"
	Data      json.RawMessage // event-specific, camelCase; nil → {}
	Ts        time.Time       // zero → now()
}

// recordLifecycleEvent inserts a canonical lifecycle event within the given tx.
// ON CONFLICT (id) DO NOTHING makes stream replays / double-emits idempotent in
// exactly one place. Both origins call it (CP in-tx; worker via the ingress's
// own tx through RecordLifecycleEvent).
func recordLifecycleEvent(ctx context.Context, tx pgx.Tx, ev LifecycleEvent) error {
	if len(ev.Data) == 0 {
		ev.Data = json.RawMessage("{}")
	}
	ts := ev.Ts
	if ts.IsZero() {
		ts = time.Now().UTC()
	}
	_, err := tx.Exec(ctx,
		`INSERT INTO sandbox_lifecycle_events (id, org_id, sandbox_id, type, data, ts)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (id) DO NOTHING`,
		ev.ID, ev.OrgID, ev.SandboxID, ev.Type, string(ev.Data), ts)
	if err != nil {
		return fmt.Errorf("record lifecycle event: %w", err)
	}
	return nil
}

// RecordLifecycleEvent records a canonical event in its own transaction (used by
// the worker-stream ingress). CP-origin callers instead use recordLifecycleEvent
// inside their existing transaction for in-tx durability.
func (s *Store) RecordLifecycleEvent(ctx context.Context, ev LifecycleEvent) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err := recordLifecycleEvent(ctx, tx, ev); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// CurrentLifecycleSeq returns the current max event seq, used as a destination's
// creation watermark (it then receives only strictly-later events).
func (s *Store) CurrentLifecycleSeq(ctx context.Context) (int64, error) {
	var seq int64
	err := s.pool.QueryRow(ctx, `SELECT COALESCE(MAX(seq), 0) FROM sandbox_lifecycle_events`).Scan(&seq)
	return seq, err
}

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

// WebhookDestinationRow is the stored destination (secret never exposed).
type WebhookDestinationRow struct {
	ID                   string
	OrgID                uuid.UUID
	Name                 *string
	URL                  string
	EventTypes           []string
	SandboxID            *string
	Enabled              bool
	HasSecret            bool
	CreatedAfterEventSeq int64
	DeletedAt            *time.Time
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

// CreateDestinationParams is the resolved input for CreateWebhookDestination
// (the handler has already chosen the secret — generated or caller-supplied).
type CreateDestinationParams struct {
	OrgID                uuid.UUID
	Name                 *string
	URL                  string
	EventTypes           []string
	SandboxID            *string
	Enabled              bool
	SecretPlain          string
	CreatedAfterEventSeq int64
}

const destCols = `id, org_id, name, url, event_types, sandbox_id, enabled,
	(secret_enc IS NOT NULL) AS has_secret, created_after_event_seq, deleted_at, created_at, updated_at`

func scanDestination(row pgx.Row) (*WebhookDestinationRow, error) {
	d := &WebhookDestinationRow{}
	if d.EventTypes == nil {
		d.EventTypes = []string{}
	}
	err := row.Scan(&d.ID, &d.OrgID, &d.Name, &d.URL, &d.EventTypes, &d.SandboxID,
		&d.Enabled, &d.HasSecret, &d.CreatedAfterEventSeq, &d.DeletedAt, &d.CreatedAt, &d.UpdatedAt)
	if err != nil {
		return nil, err
	}
	if d.EventTypes == nil {
		d.EventTypes = []string{}
	}
	return d, nil
}

func samePtrStr(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func sameStrSlice(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// CreateWebhookDestination inserts a destination, encrypting the secret. If a
// Name is given and a live destination with that name already exists: a matching
// config (url + eventTypes + sandboxId) returns the existing row with reused=true
// (caller responds 200 without a secret); a differing config returns
// ErrWebhookNameConflict.
func (s *Store) CreateWebhookDestination(ctx context.Context, p CreateDestinationParams) (row *WebhookDestinationRow, reused bool, err error) {
	if s.encryptor == nil {
		return nil, false, ErrEncryptionNotConfigured
	}
	if p.EventTypes == nil {
		p.EventTypes = []string{}
	}

	if p.Name != nil {
		existing, found, ferr := s.getDestinationByName(ctx, p.OrgID, *p.Name)
		if ferr != nil {
			return nil, false, ferr
		}
		if found {
			if existing.URL == p.URL && sameStrSlice(existing.EventTypes, p.EventTypes) && samePtrStr(existing.SandboxID, p.SandboxID) {
				return existing, true, nil
			}
			return nil, false, ErrWebhookNameConflict
		}
	}

	secretEnc, err := s.encryptor.Encrypt([]byte(p.SecretPlain))
	if err != nil {
		return nil, false, fmt.Errorf("encrypt webhook secret: %w", err)
	}
	id := newWebhookID("whk_")
	r, err := scanDestination(s.pool.QueryRow(ctx,
		`INSERT INTO webhook_destinations
			(id, org_id, name, url, event_types, sandbox_id, secret_enc, enabled, created_after_event_seq)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		 RETURNING `+destCols,
		id, p.OrgID, p.Name, p.URL, p.EventTypes, p.SandboxID, secretEnc, p.Enabled, p.CreatedAfterEventSeq))
	if err != nil {
		// Lost a race on the unique name index → fall back to get-or-create.
		if p.Name != nil && isUniqueViolation(err) {
			existing, found, ferr := s.getDestinationByName(ctx, p.OrgID, *p.Name)
			if ferr == nil && found {
				if existing.URL == p.URL && sameStrSlice(existing.EventTypes, p.EventTypes) && samePtrStr(existing.SandboxID, p.SandboxID) {
					return existing, true, nil
				}
				return nil, false, ErrWebhookNameConflict
			}
		}
		return nil, false, fmt.Errorf("create webhook destination: %w", err)
	}
	return r, false, nil
}

func (s *Store) getDestinationByName(ctx context.Context, orgID uuid.UUID, name string) (*WebhookDestinationRow, bool, error) {
	r, err := scanDestination(s.pool.QueryRow(ctx,
		`SELECT `+destCols+` FROM webhook_destinations
		 WHERE org_id = $1 AND name = $2 AND deleted_at IS NULL`, orgID, name))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, false, nil
		}
		return nil, false, err
	}
	return r, true, nil
}

// ListWebhookDestinations returns an org's live (non-deleted) destinations.
func (s *Store) ListWebhookDestinations(ctx context.Context, orgID uuid.UUID) ([]*WebhookDestinationRow, error) {
	rows, err := s.pool.Query(ctx,
		`SELECT `+destCols+` FROM webhook_destinations
		 WHERE org_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`, orgID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*WebhookDestinationRow{}
	for rows.Next() {
		d, err := scanDestination(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

// GetWebhookDestination fetches one live destination, org-scoped.
func (s *Store) GetWebhookDestination(ctx context.Context, orgID uuid.UUID, id string) (*WebhookDestinationRow, error) {
	r, err := scanDestination(s.pool.QueryRow(ctx,
		`SELECT `+destCols+` FROM webhook_destinations
		 WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, id, orgID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWebhookNotFound
		}
		return nil, err
	}
	return r, nil
}

// GetWebhookDestinationSecret decrypts and returns the destination's secret.
func (s *Store) GetWebhookDestinationSecret(ctx context.Context, id string) (string, error) {
	if s.encryptor == nil {
		return "", ErrEncryptionNotConfigured
	}
	var enc []byte
	err := s.pool.QueryRow(ctx, `SELECT secret_enc FROM webhook_destinations WHERE id = $1`, id).Scan(&enc)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrWebhookNotFound
		}
		return "", err
	}
	plain, err := s.encryptor.Decrypt(enc)
	if err != nil {
		return "", fmt.Errorf("decrypt webhook secret: %w", err)
	}
	return string(plain), nil
}

// UpdateDestinationParams is a partial update. Nil fields are left unchanged.
// ClearEventTypes overrides EventTypes to set an empty allow-list (deliver all).
// RotateSecret/NewSecretPlain set a new secret (sandboxId scope is immutable).
type UpdateDestinationParams struct {
	URL             *string
	EventTypes      *[]string
	ClearEventTypes bool
	Enabled         *bool
	Name            *string
	NewSecretPlain  *string // resolved by handler when secret set or rotateSecret=true
}

// UpdateWebhookDestination applies a partial update and returns the live row.
func (s *Store) UpdateWebhookDestination(ctx context.Context, orgID uuid.UUID, id string, p UpdateDestinationParams) (*WebhookDestinationRow, error) {
	sets := []string{"updated_at = now()"}
	args := []any{}
	add := func(expr string, val any) {
		args = append(args, val)
		sets = append(sets, fmt.Sprintf("%s = $%d", expr, len(args)))
	}
	if p.URL != nil {
		add("url", *p.URL)
	}
	if p.ClearEventTypes {
		add("event_types", []string{})
	} else if p.EventTypes != nil {
		add("event_types", *p.EventTypes)
	}
	if p.Enabled != nil {
		add("enabled", *p.Enabled)
	}
	if p.Name != nil {
		add("name", *p.Name)
	}
	if p.NewSecretPlain != nil {
		if s.encryptor == nil {
			return nil, ErrEncryptionNotConfigured
		}
		enc, err := s.encryptor.Encrypt([]byte(*p.NewSecretPlain))
		if err != nil {
			return nil, fmt.Errorf("encrypt webhook secret: %w", err)
		}
		add("secret_enc", enc)
	}
	args = append(args, id, orgID)
	q := fmt.Sprintf(`UPDATE webhook_destinations SET %s
		WHERE id = $%d AND org_id = $%d AND deleted_at IS NULL
		RETURNING %s`, strings.Join(sets, ", "), len(args)-1, len(args), destCols)
	r, err := scanDestination(s.pool.QueryRow(ctx, q, args...))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWebhookNotFound
		}
		if isUniqueViolation(err) {
			return nil, ErrWebhookNameConflict
		}
		return nil, err
	}
	return r, nil
}

// SoftDeleteWebhookDestination tombstones a destination, disables it, and
// cancels its non-terminal deliveries — all in one tx.
func (s *Store) SoftDeleteWebhookDestination(ctx context.Context, orgID uuid.UUID, id string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	tag, err := tx.Exec(ctx,
		`UPDATE webhook_destinations SET deleted_at = now(), enabled = false, updated_at = now()
		 WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, id, orgID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrWebhookNotFound
	}
	if _, err := tx.Exec(ctx,
		`UPDATE webhook_deliveries
		 SET status = 'canceled', error = 'destination_deleted', locked_by = NULL,
		     locked_until = NULL, updated_at = now()
		 WHERE destination_id = $1 AND status IN ('pending','delivering','failed')`, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ---------------------------------------------------------------------------
// Idempotency-Key storage
// ---------------------------------------------------------------------------

// WebhookIdemOutcome is the result of reserving an Idempotency-Key.
type WebhookIdemOutcome int

const (
	WebhookIdemClaimed    WebhookIdemOutcome = iota // we own a fresh claim; proceed to create + finalize
	WebhookIdemReplay                               // a finalized response exists (same request) → return it
	WebhookIdemInProgress                           // same key+request, claim held by a concurrent request, not finalized yet
	WebhookIdemConflict                             // same key, different request body
)

// ReserveIdempotencyKey atomically claims (org_id, key) for this create request
// BEFORE any destination is created, so two concurrent same-key requests can't
// both create. The unique PK makes the claim INSERT the single arbiter:
//   - we win the INSERT → WebhookIdemClaimed (caller must Finalize or Release)
//   - row exists, different hash → WebhookIdemConflict
//   - row exists, same hash, response stored → WebhookIdemReplay (+ decrypted body)
//   - row exists, same hash, not finalized → WebhookIdemInProgress
func (s *Store) ReserveIdempotencyKey(ctx context.Context, orgID uuid.UUID, key, requestHash string) (WebhookIdemOutcome, []byte, error) {
	if s.encryptor == nil {
		return 0, nil, ErrEncryptionNotConfigured
	}
	tag, err := s.pool.Exec(ctx,
		`INSERT INTO webhook_idempotency_keys (org_id, key, request_hash)
		 VALUES ($1, $2, $3) ON CONFLICT (org_id, key) DO NOTHING`,
		orgID, key, requestHash)
	if err != nil {
		return 0, nil, err
	}
	if tag.RowsAffected() == 1 {
		return WebhookIdemClaimed, nil, nil
	}
	var storedHash string
	var enc []byte // nullable until finalized
	err = s.pool.QueryRow(ctx,
		`SELECT request_hash, response_enc FROM webhook_idempotency_keys WHERE org_id = $1 AND key = $2`,
		orgID, key).Scan(&storedHash, &enc)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return WebhookIdemInProgress, nil, nil // raced with a release; ask the client to retry
		}
		return 0, nil, err
	}
	if storedHash != requestHash {
		return WebhookIdemConflict, nil, nil
	}
	if enc == nil {
		return WebhookIdemInProgress, nil, nil
	}
	plain, err := s.encryptor.Decrypt(enc)
	if err != nil {
		return 0, nil, fmt.Errorf("decrypt idempotent response: %w", err)
	}
	return WebhookIdemReplay, plain, nil
}

// FinalizeIdempotencyKey attaches the destination + encrypted response to a claim
// we own. Returns an error if the claim is missing or already finalized — the
// caller MUST treat a finalize failure as fatal (the one-time secret would
// otherwise be unrecoverable).
func (s *Store) FinalizeIdempotencyKey(ctx context.Context, orgID uuid.UUID, key, destinationID string, responseJSON []byte) error {
	if s.encryptor == nil {
		return ErrEncryptionNotConfigured
	}
	enc, err := s.encryptor.Encrypt(responseJSON)
	if err != nil {
		return fmt.Errorf("encrypt idempotent response: %w", err)
	}
	tag, err := s.pool.Exec(ctx,
		`UPDATE webhook_idempotency_keys SET destination_id = $3, response_enc = $4
		 WHERE org_id = $1 AND key = $2 AND response_enc IS NULL`,
		orgID, key, destinationID, enc)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return fmt.Errorf("idempotency claim missing or already finalized")
	}
	return nil
}

// ReleaseIdempotencyKey drops an unfinalized claim so a later retry can proceed
// (used when create or finalize fails).
func (s *Store) ReleaseIdempotencyKey(ctx context.Context, orgID uuid.UUID, key string) error {
	_, err := s.pool.Exec(ctx,
		`DELETE FROM webhook_idempotency_keys WHERE org_id = $1 AND key = $2 AND response_enc IS NULL`,
		orgID, key)
	return err
}

// ---------------------------------------------------------------------------
// Materializer: canonical events → delivery rows
// ---------------------------------------------------------------------------

type lifecycleEventRow struct {
	ID        string
	Seq       int64
	OrgID     uuid.UUID
	SandboxID string
	Type      string
	Data      []byte
	Ts        time.Time
}

// MaterializePendingLifecycleEvents claims up to `batch` unmaterialized events
// and, per event, matches live destinations (scope + watermark + type filter)
// and inserts pending delivery rows. This is the ONLY place delivery rows are
// created. Returns the number of events materialized.
func (s *Store) MaterializePendingLifecycleEvents(ctx context.Context, batch int) (int, error) {
	if batch <= 0 {
		batch = 100
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback(ctx)

	rows, err := tx.Query(ctx,
		`SELECT id, seq, org_id, sandbox_id, type, data, ts
		 FROM sandbox_lifecycle_events
		 WHERE materialized_at IS NULL
		 ORDER BY seq
		 FOR UPDATE SKIP LOCKED
		 LIMIT $1`, batch)
	if err != nil {
		return 0, err
	}
	events := []lifecycleEventRow{}
	for rows.Next() {
		var e lifecycleEventRow
		if err := rows.Scan(&e.ID, &e.Seq, &e.OrgID, &e.SandboxID, &e.Type, &e.Data, &e.Ts); err != nil {
			rows.Close()
			return 0, err
		}
		events = append(events, e)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	for _, e := range events {
		metadata, err := getSandboxMetadataTx(ctx, tx, e.SandboxID)
		if err != nil {
			return 0, err
		}
		dests, err := matchDestinationsTx(ctx, tx, e)
		if err != nil {
			return 0, err
		}
		for _, d := range dests {
			if !eventTypeMatches(d.eventTypes, e.Type) {
				continue
			}
			deliveryID := newWebhookID("whd_")
			payload, err := renderEnvelope(deliveryID, e, metadata)
			if err != nil {
				return 0, err
			}
			if _, err := tx.Exec(ctx,
				`INSERT INTO webhook_deliveries
					(id, org_id, destination_id, event_id, event_type, payload, status, next_attempt_at)
				 VALUES ($1, $2, $3, $4, $5, $6, 'pending', now())
				 ON CONFLICT (destination_id, event_id) DO NOTHING`,
				deliveryID, e.OrgID, d.id, e.ID, e.Type, string(payload)); err != nil {
				return 0, err
			}
		}
		if _, err := tx.Exec(ctx,
			`UPDATE sandbox_lifecycle_events SET materialized_at = now() WHERE id = $1`, e.ID); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return len(events), nil
}

type matchedDest struct {
	id         string
	eventTypes []string
}

func matchDestinationsTx(ctx context.Context, tx pgx.Tx, e lifecycleEventRow) ([]matchedDest, error) {
	rows, err := tx.Query(ctx,
		`SELECT id, event_types FROM webhook_destinations
		 WHERE org_id = $1 AND enabled AND deleted_at IS NULL
		   AND (sandbox_id IS NULL OR sandbox_id = $2)
		   AND created_after_event_seq < $3`,
		e.OrgID, e.SandboxID, e.Seq)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []matchedDest{}
	for rows.Next() {
		var d matchedDest
		if err := rows.Scan(&d.id, &d.eventTypes); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func getSandboxMetadataTx(ctx context.Context, tx pgx.Tx, sandboxID string) (map[string]string, error) {
	var raw []byte
	err := tx.QueryRow(ctx,
		`SELECT metadata FROM sandbox_sessions WHERE sandbox_id = $1 ORDER BY started_at DESC LIMIT 1`,
		sandboxID).Scan(&raw)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	if len(raw) == 0 {
		return nil, nil
	}
	m := map[string]string{}
	if err := json.Unmarshal(raw, &m); err != nil {
		// Non-string metadata or malformed → treat as absent rather than fail.
		return nil, nil
	}
	if len(m) == 0 {
		return nil, nil
	}
	return m, nil
}

// renderEnvelope builds the camelCase delivery body. Keys MUST match
// pkg/types.SandboxWebhookEnvelope (the canonical contract). metadata nil →
// JSON null.
func renderEnvelope(deliveryID string, e lifecycleEventRow, metadata map[string]string) ([]byte, error) {
	data := json.RawMessage(e.Data)
	if len(data) == 0 {
		data = json.RawMessage("{}")
	}
	env := map[string]any{
		"type":       e.Type,
		"sandboxId":  e.SandboxID,
		"eventId":    e.ID,
		"deliveryId": deliveryID,
		"metadata":   metadata,
		"event": map[string]any{
			"id":        e.ID,
			"ts":        e.Ts.UTC().Format(time.RFC3339Nano),
			"orgId":     e.OrgID.String(),
			"sandboxId": e.SandboxID,
			"type":      e.Type,
			"data":      data,
		},
	}
	return json.Marshal(env)
}

// eventTypeMatches: empty filter = all; exact match or a "prefix.*" wildcard.
func eventTypeMatches(filter []string, eventType string) bool {
	if len(filter) == 0 {
		return true
	}
	for _, f := range filter {
		if f == eventType {
			return true
		}
		if strings.HasSuffix(f, ".*") && strings.HasPrefix(eventType, strings.TrimSuffix(f, "*")) {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Deliveries (the dispatcher's work queue)
// ---------------------------------------------------------------------------

// WebhookDeliveryRow is the stored delivery record.
type WebhookDeliveryRow struct {
	ID            string
	OrgID         uuid.UUID
	DestinationID string
	EventID       string
	EventType     string
	Status        string
	Attempts      int
	RetryCount    int
	NextAttemptAt time.Time
	ResponseCode  *int
	Error         *string
	LastAttemptAt *time.Time
	CreatedAt     time.Time
	UpdatedAt     time.Time
	DeliveredAt   *time.Time
}

const deliveryCols = `id, org_id, destination_id, event_id, event_type, status, attempts,
	retry_count, next_attempt_at, response_code, error, last_attempt_at, created_at, updated_at, delivered_at`

func scanDelivery(row pgx.Row) (*WebhookDeliveryRow, error) {
	d := &WebhookDeliveryRow{}
	err := row.Scan(&d.ID, &d.OrgID, &d.DestinationID, &d.EventID, &d.EventType, &d.Status,
		&d.Attempts, &d.RetryCount, &d.NextAttemptAt, &d.ResponseCode, &d.Error,
		&d.LastAttemptAt, &d.CreatedAt, &d.UpdatedAt, &d.DeliveredAt)
	if err != nil {
		return nil, err
	}
	return d, nil
}

// DueDelivery is a claimed delivery ready to send (live destination joined,
// secret decrypted in-process).
type DueDelivery struct {
	ID         string
	URL        string
	Secret     string
	Payload    []byte
	RetryCount int    // post-claim value (already incremented)
	LockedBy   string // this dispatcher's lock token; used to record results safely
}

// ClaimDueDeliveries atomically claims up to `batch` due deliveries for enabled,
// non-deleted destinations: marks them delivering (attempts+1, retry_count+1,
// lock held), and returns them with the live URL + decrypted secret. Safe for
// multiple dispatcher instances (FOR UPDATE … SKIP LOCKED).
func (s *Store) ClaimDueDeliveries(ctx context.Context, lockedBy string, batch int, lockFor time.Duration) ([]DueDelivery, error) {
	if s.encryptor == nil {
		return nil, ErrEncryptionNotConfigured
	}
	if batch <= 0 {
		batch = 20
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)

	rows, err := tx.Query(ctx,
		`SELECT d.id, d.retry_count, dst.url, dst.secret_enc, d.payload
		 FROM webhook_deliveries d
		 JOIN webhook_destinations dst ON dst.id = d.destination_id AND dst.enabled AND dst.deleted_at IS NULL
		 WHERE d.status IN ('pending','failed') AND d.next_attempt_at <= now()
		 ORDER BY d.next_attempt_at
		 FOR UPDATE OF d SKIP LOCKED
		 LIMIT $1`, batch)
	if err != nil {
		return nil, err
	}
	type claim struct {
		id      string
		retry   int
		url     string
		secEnc  []byte
		payload []byte
	}
	claims := []claim{}
	for rows.Next() {
		var c claim
		if err := rows.Scan(&c.id, &c.retry, &c.url, &c.secEnc, &c.payload); err != nil {
			rows.Close()
			return nil, err
		}
		claims = append(claims, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(claims) == 0 {
		return nil, tx.Commit(ctx)
	}

	out := make([]DueDelivery, 0, len(claims))
	lockUntil := time.Now().Add(lockFor)
	for _, c := range claims {
		if _, err := tx.Exec(ctx,
			`UPDATE webhook_deliveries
			 SET status = 'delivering', attempts = attempts + 1, retry_count = retry_count + 1,
			     last_attempt_at = now(), locked_by = $2, locked_until = $3, updated_at = now()
			 WHERE id = $1`, c.id, lockedBy, lockUntil); err != nil {
			return nil, err
		}
		secret, err := s.encryptor.Decrypt(c.secEnc)
		if err != nil {
			return nil, fmt.Errorf("decrypt secret for delivery %s: %w", c.id, err)
		}
		out = append(out, DueDelivery{
			ID:         c.id,
			URL:        c.url,
			Secret:     string(secret),
			Payload:    c.payload,
			RetryCount: c.retry + 1,
			LockedBy:   lockedBy,
		})
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

// DeliveryResult is the outcome the dispatcher records after a send attempt.
type DeliveryResult struct {
	Status        string // delivered | failed | dead_letter
	ResponseCode  *int
	Error         *string
	NextAttemptAt *time.Time // for failed (retryable)
}

// RecordDeliveryResult writes the outcome of a send attempt and clears the lock.
// It only updates a row THIS dispatcher still owns (status='delivering' AND
// locked_by=lockedBy), so a stale sender can't revive a row that was meanwhile
// canceled (destination deleted) or redelivered (reset to pending by a manual
// redeliver or the reconciler). Returns whether the row was updated.
func (s *Store) RecordDeliveryResult(ctx context.Context, id, lockedBy string, r DeliveryResult) (bool, error) {
	var delivered *time.Time
	if r.Status == "delivered" {
		now := time.Now()
		delivered = &now
	}
	tag, err := s.pool.Exec(ctx,
		`UPDATE webhook_deliveries
		 SET status = $3, response_code = $4, error = $5,
		     next_attempt_at = COALESCE($6, next_attempt_at),
		     delivered_at = COALESCE($7, delivered_at),
		     locked_by = NULL, locked_until = NULL, updated_at = now()
		 WHERE id = $1 AND status = 'delivering' AND locked_by = $2`,
		id, lockedBy, r.Status, r.ResponseCode, r.Error, r.NextAttemptAt, delivered)
	if err != nil {
		return false, err
	}
	return tag.RowsAffected() > 0, nil
}

// ReclaimStaleDeliveries returns deliveries stuck in 'delivering' past their
// lock to 'failed' so the poll loop requeues them. Returns rows reclaimed.
func (s *Store) ReclaimStaleDeliveries(ctx context.Context) (int64, error) {
	tag, err := s.pool.Exec(ctx,
		`UPDATE webhook_deliveries
		 SET status = 'failed', locked_by = NULL, locked_until = NULL, updated_at = now()
		 WHERE status = 'delivering' AND locked_until < now() - interval '30 seconds'`)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}

// RedeliverDelivery re-enqueues any delivery with a fresh retry budget
// (retry_count=0), preserving lifetime attempts, and returns the updated row.
// Org+destination scoped.
func (s *Store) RedeliverDelivery(ctx context.Context, orgID uuid.UUID, destID, deliveryID string) (*WebhookDeliveryRow, error) {
	r, err := scanDelivery(s.pool.QueryRow(ctx,
		`UPDATE webhook_deliveries
		 SET status = 'pending', next_attempt_at = now(), retry_count = 0,
		     response_code = NULL, error = NULL, locked_by = NULL, locked_until = NULL, updated_at = now()
		 WHERE id = $1 AND destination_id = $2 AND org_id = $3
		 RETURNING `+deliveryCols, deliveryID, destID, orgID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWebhookNotFound
		}
		return nil, err
	}
	return r, nil
}

// GetWebhookDelivery fetches one delivery, org+destination scoped.
func (s *Store) GetWebhookDelivery(ctx context.Context, orgID uuid.UUID, destID, deliveryID string) (*WebhookDeliveryRow, error) {
	r, err := scanDelivery(s.pool.QueryRow(ctx,
		`SELECT `+deliveryCols+` FROM webhook_deliveries
		 WHERE id = $1 AND destination_id = $2 AND org_id = $3`, deliveryID, destID, orgID))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, ErrWebhookNotFound
		}
		return nil, err
	}
	return r, nil
}

// destinationOwnedByOrg verifies a destination belongs to the org, INCLUDING
// soft-deleted ones (for delivery-history access after deletion). Returns
// ErrWebhookNotFound if no such row exists for the org.
func (s *Store) destinationOwnedByOrg(ctx context.Context, orgID uuid.UUID, id string) error {
	var exists bool
	err := s.pool.QueryRow(ctx,
		`SELECT true FROM webhook_destinations WHERE id = $1 AND org_id = $2`, id, orgID).Scan(&exists)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrWebhookNotFound
		}
		return err
	}
	return nil
}

// SandboxBelongsToOrg reports whether sandboxID is owned by orgID — used to
// validate a webhook's sandbox scope at registration.
func (s *Store) SandboxBelongsToOrg(ctx context.Context, orgID uuid.UUID, sandboxID string) (bool, error) {
	var exists bool
	err := s.pool.QueryRow(ctx,
		`SELECT EXISTS(SELECT 1 FROM sandbox_sessions WHERE sandbox_id = $1 AND org_id = $2)`,
		sandboxID, orgID).Scan(&exists)
	return exists, err
}

// ListWebhookDeliveries returns a destination's deliveries, newest first,
// cursor-paginated on (created_at, id). An optional status filter narrows it.
func (s *Store) ListWebhookDeliveries(ctx context.Context, orgID uuid.UUID, destID, status, cursor string, limit int) ([]*WebhookDeliveryRow, *string, bool, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	// Verify the destination belongs to the org (so an unknown id 404s, not
	// empties). Soft-deleted destinations are allowed here — their delivery
	// history is retained and remains queryable.
	if err := s.destinationOwnedByOrg(ctx, orgID, destID); err != nil {
		return nil, nil, false, err
	}

	args := []any{destID, orgID}
	where := `destination_id = $1 AND org_id = $2`
	if status != "" {
		args = append(args, status)
		where += fmt.Sprintf(" AND status = $%d", len(args))
	}
	if cursor != "" {
		ts, id, ok := decodeDeliveryCursor(cursor)
		if ok {
			args = append(args, ts)
			tsIdx := len(args)
			args = append(args, id)
			idIdx := len(args)
			where += fmt.Sprintf(" AND (created_at, id) < ($%d::timestamptz, $%d::text)", tsIdx, idIdx)
		}
	}
	args = append(args, limit+1)
	q := fmt.Sprintf(`SELECT %s FROM webhook_deliveries WHERE %s
		ORDER BY created_at DESC, id DESC LIMIT $%d`, deliveryCols, where, len(args))
	rows, err := s.pool.Query(ctx, q, args...)
	if err != nil {
		return nil, nil, false, err
	}
	defer rows.Close()
	out := []*WebhookDeliveryRow{}
	for rows.Next() {
		d, err := scanDelivery(rows)
		if err != nil {
			return nil, nil, false, err
		}
		out = append(out, d)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, false, err
	}
	hasMore := false
	if len(out) > limit {
		hasMore = true
		out = out[:limit]
	}
	var next *string
	if hasMore && len(out) > 0 {
		last := out[len(out)-1]
		c := encodeDeliveryCursor(last.CreatedAt, last.ID)
		next = &c
	}
	return out, next, hasMore, nil
}

func encodeDeliveryCursor(ts time.Time, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(ts.UnixNano(), 10) + "," + id))
}

func decodeDeliveryCursor(c string) (time.Time, string, bool) {
	raw, err := base64.RawURLEncoding.DecodeString(c)
	if err != nil {
		return time.Time{}, "", false
	}
	parts := strings.SplitN(string(raw), ",", 2)
	if len(parts) != 2 {
		return time.Time{}, "", false
	}
	ns, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return time.Time{}, "", false
	}
	return time.Unix(0, ns), parts[1], true
}

// isUniqueViolation reports whether err is a Postgres unique-constraint error.
func isUniqueViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "SQLSTATE 23505")
}
