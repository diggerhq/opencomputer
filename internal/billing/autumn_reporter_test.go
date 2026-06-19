package billing

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/opensandbox/opensandbox/internal/billing/autumn"
	"github.com/opensandbox/opensandbox/internal/db"
)

// fakeAutumnStore is an in-memory autumnUsageStore. Usage is keyed by the bucket
// start (Unix seconds), so GetOrgUsage returns exactly what the reporter's
// bucketing asks for — this tests the reporter's windowing/idempotency without
// reimplementing GetOrgUsage's SQL clipping.
type fakeAutumnStore struct {
	orgs        map[uuid.UUID]*db.Org
	usageByFrom map[int64][]db.OrgUsageSummary
}

func newFakeAutumnStore() *fakeAutumnStore {
	return &fakeAutumnStore{
		orgs:        map[uuid.UUID]*db.Org{},
		usageByFrom: map[int64][]db.OrgUsageSummary{},
	}
}

func (f *fakeAutumnStore) ListAutumnOrgIDsWithUsage(_ context.Context) ([]uuid.UUID, error) {
	var ids []uuid.UUID
	for id, o := range f.orgs {
		if o.BillingProvider == "autumn" {
			ids = append(ids, id)
		}
	}
	return ids, nil
}

func (f *fakeAutumnStore) GetOrg(_ context.Context, id uuid.UUID) (*db.Org, error) {
	return f.orgs[id], nil
}

func (f *fakeAutumnStore) GetOrgUsage(_ context.Context, _ string, from, _ time.Time) ([]db.OrgUsageSummary, error) {
	return f.usageByFrom[from.Unix()], nil
}

func (f *fakeAutumnStore) SetLastUsageSyncedAt(_ context.Context, orgID uuid.UUID, t time.Time) error {
	tc := t
	f.orgs[orgID].LastUsageSyncedAt = &tc
	return nil
}

func creditsRemaining(t *testing.T, fake *autumn.Fake, orgID string) float64 {
	t.Helper()
	c, err := fake.GetCustomer(context.Background(), orgID)
	if err != nil {
		t.Fatalf("GetCustomer: %v", err)
	}
	return c.CreditsRemaining()
}

// fixed base time so bucket math is exact and reproducible.
var baseT = time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC)

func newTestReporter(store autumnUsageStore, client autumn.Client, now time.Time) *AutumnReporter {
	r := NewAutumnReporter(store, client)
	r.now = func() time.Time { return now }
	return r
}

func TestAutumnReporter_seedsWatermarkWithoutBilling(t *testing.T) {
	store := newFakeAutumnStore()
	id := uuid.New()
	store.orgs[id] = &db.Org{ID: id, BillingProvider: "autumn", CreatedAt: baseT} // LastUsageSyncedAt nil

	fake := autumn.NewFake()
	fake.CreateCustomer(context.Background(), autumn.CreateCustomerParams{ID: id.String()})

	r := newTestReporter(store, fake, baseT.Add(time.Hour))
	r.reportAll(context.Background())

	if store.orgs[id].LastUsageSyncedAt == nil {
		t.Fatal("expected watermark seeded on first sight")
	}
	if got := *store.orgs[id].LastUsageSyncedAt; !got.Equal(baseT.Add(time.Hour)) {
		t.Fatalf("watermark = %v, want seed = now", got)
	}
	if bal := creditsRemaining(t, fake, id.String()); bal != 5 {
		t.Fatalf("balance = %v, want 5 (no retroactive billing on seed)", bal)
	}
}

func TestAutumnReporter_tracksCompleteBucketsOnly(t *testing.T) {
	store := newFakeAutumnStore()
	id := uuid.New()
	wm := baseT
	store.orgs[id] = &db.Org{ID: id, BillingProvider: "autumn", CreatedAt: baseT, LastUsageSyncedAt: &wm}

	// bucket 0: [baseT, +5m) — a 64GB box for the full 300s.
	store.usageByFrom[baseT.Unix()] = []db.OrgUsageSummary{{MemoryMB: 65536, TotalSeconds: 300}}
	// bucket 1: [+5m, +10m) — a 1GB box + 1GB disk overage for 300s.
	store.usageByFrom[baseT.Add(5*time.Minute).Unix()] = []db.OrgUsageSummary{
		{MemoryMB: 1024, TotalSeconds: 300, DiskMB: DiskFreeAllowanceMB + 1024},
	}

	fake := autumn.NewFake()
	fake.CreateCustomer(context.Background(), autumn.CreateCustomerParams{ID: id.String()})

	// now = +12m → buckets 0 and 1 are complete; [+10m,+15m) is not.
	r := newTestReporter(store, fake, baseT.Add(12*time.Minute))
	r.reportAll(context.Background())

	wantWM := baseT.Add(10 * time.Minute)
	if got := *store.orgs[id].LastUsageSyncedAt; !got.Equal(wantWM) {
		t.Fatalf("watermark = %v, want %v (partial bucket deferred)", got, wantWM)
	}

	// Expected deduction via the Fake's credit schema.
	cc := fake.CreditCosts
	want := 5.0 -
		300*cc["compute_64gb"] -
		300*cc["compute_1gb"] -
		300*cc["disk_overage"] // 1GB overage × 300s = 300 GB-seconds
	if bal := creditsRemaining(t, fake, id.String()); !almostEqual(bal, want) {
		t.Fatalf("balance = %v, want %v", bal, want)
	}
}

func TestAutumnReporter_idempotentReplay(t *testing.T) {
	store := newFakeAutumnStore()
	id := uuid.New()
	wm := baseT
	store.orgs[id] = &db.Org{ID: id, BillingProvider: "autumn", CreatedAt: baseT, LastUsageSyncedAt: &wm}
	store.usageByFrom[baseT.Unix()] = []db.OrgUsageSummary{{MemoryMB: 65536, TotalSeconds: 300}}

	fake := autumn.NewFake()
	fake.CreateCustomer(context.Background(), autumn.CreateCustomerParams{ID: id.String()})

	r := newTestReporter(store, fake, baseT.Add(7*time.Minute)) // 1 complete bucket
	r.reportAll(context.Background())
	afterFirst := creditsRemaining(t, fake, id.String())

	// Rewind the watermark to force a replay of the same bucket — the stable
	// idempotency keys must make Autumn dedupe, leaving the balance untouched.
	store.orgs[id].LastUsageSyncedAt = &wm
	r.reportAll(context.Background())
	afterReplay := creditsRemaining(t, fake, id.String())

	if !almostEqual(afterFirst, afterReplay) {
		t.Fatalf("replay double-charged: first=%v replay=%v", afterFirst, afterReplay)
	}
}

func TestAutumnReporter_skipsUnknownTierButAdvances(t *testing.T) {
	store := newFakeAutumnStore()
	id := uuid.New()
	wm := baseT
	store.orgs[id] = &db.Org{ID: id, BillingProvider: "autumn", CreatedAt: baseT, LastUsageSyncedAt: &wm}
	store.usageByFrom[baseT.Unix()] = []db.OrgUsageSummary{{MemoryMB: 2048, TotalSeconds: 300}} // unmapped tier

	fake := autumn.NewFake()
	fake.CreateCustomer(context.Background(), autumn.CreateCustomerParams{ID: id.String()})

	r := newTestReporter(store, fake, baseT.Add(7*time.Minute))
	r.reportAll(context.Background())

	if bal := creditsRemaining(t, fake, id.String()); bal != 5 {
		t.Fatalf("balance = %v, want 5 (unknown tier not charged)", bal)
	}
	if got := *store.orgs[id].LastUsageSyncedAt; !got.Equal(baseT.Add(5 * time.Minute)) {
		t.Fatalf("watermark = %v, want bucket advanced past unknown tier", got)
	}
}

func TestAutumnReporter_haltsOnExhaustionWhenEnforced(t *testing.T) {
	store := newFakeAutumnStore()
	id := uuid.New()
	wm := baseT
	store.orgs[id] = &db.Org{ID: id, BillingProvider: "autumn", CreatedAt: baseT, LastUsageSyncedAt: &wm}
	// A 64GB box for 10000s costs > $5 → drives the $5 grant negative.
	store.usageByFrom[baseT.Unix()] = []db.OrgUsageSummary{{MemoryMB: 65536, TotalSeconds: 10000}}

	fake := autumn.NewFake()
	fake.CreateCustomer(context.Background(), autumn.CreateCustomerParams{ID: id.String()})

	var halted []uuid.UUID
	r := newTestReporter(store, fake, baseT.Add(7*time.Minute))
	r.SetEnforce(true)
	r.SetHaltFunc(func(_ context.Context, orgID uuid.UUID) error {
		halted = append(halted, orgID)
		return nil
	})
	r.reportAll(context.Background())

	if len(halted) != 1 || halted[0] != id {
		t.Fatalf("expected halt(%s), got %v", id, halted)
	}
	if bal := creditsRemaining(t, fake, id.String()); bal >= 0 {
		t.Fatalf("balance = %v, want negative (exhausted)", bal)
	}
}

func TestAutumnReporter_shadowNeverHalts(t *testing.T) {
	store := newFakeAutumnStore()
	id := uuid.New()
	wm := baseT
	store.orgs[id] = &db.Org{ID: id, BillingProvider: "autumn", CreatedAt: baseT, LastUsageSyncedAt: &wm}
	store.usageByFrom[baseT.Unix()] = []db.OrgUsageSummary{{MemoryMB: 65536, TotalSeconds: 10000}}

	fake := autumn.NewFake()
	fake.CreateCustomer(context.Background(), autumn.CreateCustomerParams{ID: id.String()})

	var halted []uuid.UUID
	r := newTestReporter(store, fake, baseT.Add(7*time.Minute)) // enforce=false (default)
	r.SetHaltFunc(func(_ context.Context, orgID uuid.UUID) error {
		halted = append(halted, orgID)
		return nil
	})
	r.reportAll(context.Background())

	if len(halted) != 0 {
		t.Fatalf("shadow mode must not halt; got %v", halted)
	}
}

func almostEqual(a, b float64) bool {
	d := a - b
	if d < 0 {
		d = -d
	}
	return d < 1e-9
}
