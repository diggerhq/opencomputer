package controlplane

import (
	"context"
	"strings"
	"testing"

	"github.com/opensandbox/opensandbox/internal/alert"
)

func newTestParity(fa alert.Alerter) *UsageParityChecker {
	return &UsageParityChecker{
		alerter:          fa,
		cellID:           "eastus2",
		alertPct:         0.10,
		alertMinGBs:      100,
		alertMinOrgs:     3,
		alertConsecutive: 2,
	}
}

// Systemic drift (≥3 material orgs) must alert — but only once it has persisted
// across the required number of consecutive buckets, not on the first.
func TestBillingAlert_SystemicSustained(t *testing.T) {
	fa := &fakeAlerter{}
	p := newTestParity(fa)
	// 3 material breaches, cell aggregate +25%.
	p.evaluateBillingAlert(context.Background(), 3, "org-abc", 0.25, 1000, 1250)
	if fa.count() != 0 {
		t.Fatalf("one bucket must not alert, got %d", fa.count())
	}
	p.evaluateBillingAlert(context.Background(), 3, "org-abc", 0.25, 1000, 1250)
	if fa.count() != 1 {
		t.Fatalf("second consecutive bucket must alert, got %d", fa.count())
	}
	a := fa.last()
	if a.Severity != alert.Warning || !strings.Contains(a.Title, "billing drift") || a.DedupKey != "billing_drift:eastus2" {
		t.Errorf("unexpected alert: %+v", a)
	}
}

// A clean bucket between two breaching ones resets the counter, so a transient
// single-bucket blip never reaches the consecutive threshold.
func TestBillingAlert_TransientResets(t *testing.T) {
	fa := &fakeAlerter{}
	p := newTestParity(fa)
	p.evaluateBillingAlert(context.Background(), 3, "x", 0.2, 1000, 1200) // breach, streak=1
	p.evaluateBillingAlert(context.Background(), 0, "", 0, 1000, 1005)    // clean (0.5% agg), reset
	p.evaluateBillingAlert(context.Background(), 3, "x", 0.2, 1000, 1200) // breach again, streak=1
	if fa.count() != 0 {
		t.Fatalf("transient blips must not alert, got %d", fa.count())
	}
}

// Fewer than minOrgs breaches but a material cell-wide aggregate over threshold
// is still systemic (a couple of big orgs badly off).
func TestBillingAlert_AggregatePath(t *testing.T) {
	fa := &fakeAlerter{}
	p := newTestParity(fa)
	// Only 2 breaching orgs (< 3) but aggregate is +20% on a material cell.
	p.evaluateBillingAlert(context.Background(), 2, "x", 0.30, 1000, 1200)
	p.evaluateBillingAlert(context.Background(), 2, "x", 0.30, 1000, 1200)
	if fa.count() != 1 {
		t.Fatalf("material aggregate over threshold must alert after 2 buckets, got %d", fa.count())
	}
}

// Tiny totals with no material breaches (all small-org rounding) never alert,
// no matter how many buckets — the floors keep noise out.
func TestBillingAlert_SmallOrgNoiseNeverAlerts(t *testing.T) {
	fa := &fakeAlerter{}
	p := newTestParity(fa)
	for i := 0; i < 5; i++ {
		p.evaluateBillingAlert(context.Background(), 0, "", 0, 5, 9) // below the 300 GB·s aggregate floor
	}
	if fa.count() != 0 {
		t.Fatalf("small-org noise must never alert, got %d", fa.count())
	}
}
