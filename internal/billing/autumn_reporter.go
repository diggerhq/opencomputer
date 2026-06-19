package billing

import (
	"context"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/opensandbox/opensandbox/internal/billing/autumn"
	"github.com/opensandbox/opensandbox/internal/db"
)

// autumnBucketSize is the fixed window each track() call covers. Buckets are
// aligned to each org's seed watermark (not wall-clock) and are the unit of
// idempotency: a retried bucket reuses the same idempotency_key, so Autumn
// dedupes it. It also bounds the overspend window once enforcement is on
// (Phase 3) — usage can run at most one bucket past a zero balance before the
// inline halt fires. 5m matches the legacy reporter's debit cadence.
const autumnBucketSize = 5 * time.Minute

// autumnUsageStore is the narrow slice of *db.Store the reporter needs. Keeping
// it an interface lets the bucket/idempotency logic be unit-tested against an
// in-memory fake without standing up Postgres.
type autumnUsageStore interface {
	ListAutumnOrgIDsWithUsage(ctx context.Context) ([]uuid.UUID, error)
	GetOrg(ctx context.Context, id uuid.UUID) (*db.Org, error)
	GetOrgUsage(ctx context.Context, orgID string, from, to time.Time) ([]db.OrgUsageSummary, error)
	SetLastUsageSyncedAt(ctx context.Context, orgID uuid.UUID, t time.Time) error
}

// HaltFunc halts an org whose Autumn balance is exhausted: hibernate its running
// sandboxes locally (via EnforceCreditExhaustion) and project is_halted to the
// edge (D1) so create/wake gates reject it everywhere. Injected via SetHaltFunc;
// nil keeps the reporter in shadow (log-only) even when enforce is on.
type HaltFunc func(ctx context.Context, orgID uuid.UUID) error

// AutumnReporter ships per-org compute/disk usage to Autumn via track(). It is
// the Autumn-side counterpart of UsageReporter and runs only for orgs flagged
// billing_provider='autumn'.
//
// Phase 2 (now): SHADOW. It tracks usage to Autumn (building the real ledger)
// but never halts — it only logs a parity line comparing our locally-computed
// cost against Autumn's returned balance, so we can confirm Autumn's credit
// schema matches pricing.go before any org's sandboxes are gated on it.
//
// Phase 3 will flip enforce=true: when a bucket's track() comes back with
// Remaining <= 0, the reporter halts the org inline (same tightness as today's
// debit loop) instead of just logging.
type AutumnReporter struct {
	store    autumnUsageStore
	client   autumn.Client
	interval time.Duration
	enforce  bool
	halt     HaltFunc         // invoked on exhaustion when enforce is on
	now      func() time.Time // injectable clock (tests)

	stop    chan struct{}
	stopped chan struct{}
}

func NewAutumnReporter(store autumnUsageStore, client autumn.Client) *AutumnReporter {
	return &AutumnReporter{
		store:    store,
		client:   client,
		interval: 5 * time.Minute,
		enforce:  false, // shadow until Phase 3
		now:      time.Now,
		stop:     make(chan struct{}),
		stopped:  make(chan struct{}),
	}
}

// SetEnforce flips the reporter out of shadow mode: track() responses with a
// non-positive balance halt the org inline (requires a HaltFunc). Wired in Phase 3.
func (r *AutumnReporter) SetEnforce(enabled bool) { r.enforce = enabled }

// SetHaltFunc installs the action taken when an org's balance is exhausted.
func (r *AutumnReporter) SetHaltFunc(fn HaltFunc) { r.halt = fn }

func (r *AutumnReporter) Start() { go r.loop() }
func (r *AutumnReporter) Stop()  { close(r.stop); <-r.stopped }

func (r *AutumnReporter) loop() {
	defer close(r.stopped)
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			r.safeReportAll()
		case <-r.stop:
			return
		}
	}
}

func (r *AutumnReporter) safeReportAll() {
	defer func() {
		if p := recover(); p != nil {
			log.Printf("autumn-reporter: panic in tick: %v", p)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	r.reportAll(ctx)
}

func (r *AutumnReporter) reportAll(ctx context.Context) {
	orgIDs, err := r.store.ListAutumnOrgIDsWithUsage(ctx)
	if err != nil {
		log.Printf("autumn-reporter: failed to list autumn orgs: %v", err)
		return
	}
	if len(orgIDs) == 0 {
		return
	}
	log.Printf("autumn-reporter: tracking usage for %d org(s)", len(orgIDs))
	for _, orgID := range orgIDs {
		if err := r.reportOrg(ctx, orgID); err != nil {
			log.Printf("autumn-reporter: org %s: %v", orgID, err)
		}
	}
}

// reportOrg ships every fully-elapsed bucket since the org's watermark to
// Autumn, advancing the watermark one bucket at a time so a mid-run failure
// only replays the unfinished bucket (whose idempotency keys dedupe).
func (r *AutumnReporter) reportOrg(ctx context.Context, orgID uuid.UUID) error {
	org, err := r.store.GetOrg(ctx, orgID)
	if err != nil {
		return err
	}
	if org.BillingProvider != "autumn" {
		return nil // flag flipped back between listing and now
	}

	now := r.now()

	// First sight: seed the watermark to now and bill forward only — never
	// retroactively charge usage that accrued before the org moved to Autumn.
	if org.LastUsageSyncedAt == nil {
		if err := r.store.SetLastUsageSyncedAt(ctx, orgID, now); err != nil {
			return err
		}
		log.Printf("autumn-reporter: org %s seeded watermark at %s", orgID, now.Format(time.RFC3339))
		return nil
	}

	cursor := *org.LastUsageSyncedAt
	for bucketEnd := cursor.Add(autumnBucketSize); !bucketEnd.After(now); bucketEnd = cursor.Add(autumnBucketSize) {
		if err := r.trackBucket(ctx, org, cursor, bucketEnd); err != nil {
			// Leave the watermark where it is; the next tick replays this
			// bucket with the same idempotency keys (Autumn dedupes the parts
			// that already landed).
			return err
		}
		if err := r.store.SetLastUsageSyncedAt(ctx, orgID, bucketEnd); err != nil {
			return err
		}
		cursor = bucketEnd
	}
	return nil
}

// trackBucket reports one [from, to) window: one track() per compute tier plus
// one for disk overage, then (shadow) logs the parity line.
func (r *AutumnReporter) trackBucket(ctx context.Context, org *db.Org, from, to time.Time) error {
	usage, err := r.store.GetOrgUsage(ctx, org.ID.String(), from, to)
	if err != nil {
		return err
	}
	if len(usage) == 0 {
		return nil
	}

	bucketStart := from.Unix()
	var lastBalance float64
	var diskGBSeconds float64
	tracked := false

	for _, u := range usage {
		diskGBSeconds += DiskOverageGBSeconds(u)
		if u.TotalSeconds <= 0 {
			continue
		}
		feature, ok := autumn.FeatureForMemoryMB(u.MemoryMB)
		if !ok {
			log.Printf("autumn-reporter: org %s unknown memory tier %dMB — skipping", org.ID, u.MemoryMB)
			continue
		}
		res, err := r.client.Track(ctx, autumn.TrackParams{
			CustomerID:     org.ID.String(),
			FeatureID:      feature,
			Value:          u.TotalSeconds,
			IdempotencyKey: autumn.UsageIdempotencyKey(org.ID.String(), bucketStart, feature),
		})
		if err != nil {
			return err
		}
		lastBalance = res.Balance.Remaining
		tracked = true
	}

	if diskGBSeconds > 0 {
		res, err := r.client.Track(ctx, autumn.TrackParams{
			CustomerID:     org.ID.String(),
			FeatureID:      autumn.DiskOverageFeatureID,
			Value:          diskGBSeconds,
			IdempotencyKey: autumn.UsageIdempotencyKey(org.ID.String(), bucketStart, autumn.DiskOverageFeatureID),
		})
		if err != nil {
			return err
		}
		lastBalance = res.Balance.Remaining
		tracked = true
	}

	if !tracked {
		return nil
	}

	ourCents := CalculateUsageCostCents(usage)
	log.Printf("autumn-reporter: org %s bucket [%s,%s) our_cost=$%.4f autumn_remaining=$%.4f",
		org.ID, from.Format("15:04"), to.Format("15:04"), ourCents/100.0, lastBalance)

	if lastBalance <= 0 {
		if r.enforce && r.halt != nil {
			if err := r.halt(ctx, org.ID); err != nil {
				log.Printf("autumn-reporter: org %s halt failed: %v", org.ID, err)
			} else {
				log.Printf("autumn-reporter: org %s balance exhausted — halted", org.ID)
			}
		} else {
			log.Printf("autumn-reporter: org %s balance exhausted — WOULD halt (shadow)", org.ID)
		}
	}
	return nil
}
