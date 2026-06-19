package autumn

import (
	"context"
	"os"
	"testing"
	"time"
)

// Live smoke test against the Autumn sandbox. Skipped unless AUTUMN_SANDBOX_KEY
// is set, so normal `go test` stays offline. Run with:
//
//	AUTUMN_SANDBOX_KEY=am_sk_test_… go test ./internal/billing/autumn/ -run TestLive -v
func TestLive_CustomerTrackFlow(t *testing.T) {
	key := os.Getenv("AUTUMN_SANDBOX_KEY")
	if key == "" {
		t.Skip("set AUTUMN_SANDBOX_KEY to run the live sandbox smoke test")
	}
	c := New(key)
	ctx := context.Background()
	id := "oc-itest-" + time.Now().Format("20060102150405")

	cust, err := c.CreateCustomer(ctx, CreateCustomerParams{ID: id, Name: "oc integration test"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if cust.CreditsRemaining() != 5 {
		t.Fatalf("signup grant = %v, want 5", cust.CreditsRemaining())
	}
	if cust.MaxConcurrency() != 5 {
		t.Fatalf("base concurrency = %d, want 5", cust.MaxConcurrency())
	}

	// Track 1000s of compute_64gb (× 0.00054 = 0.54 credits). The idempotency key
	// is GLOBAL, so make it unique per run.
	idemKey := id + ":compute_64gb:1"
	r, err := c.Track(ctx, TrackParams{CustomerID: id, FeatureID: "compute_64gb", Value: 1000, IdempotencyKey: idemKey})
	if err != nil {
		t.Fatalf("track: %v", err)
	}
	if d := 5 - r.Balance.Remaining; d < 0.539 || d > 0.541 {
		t.Fatalf("deducted %v, want ~0.54", d)
	}

	// Same key → no further deduction (live idempotency).
	r2, err := c.Track(ctx, TrackParams{CustomerID: id, FeatureID: "compute_64gb", Value: 1000, IdempotencyKey: idemKey})
	if err != nil {
		t.Fatalf("track 2: %v", err)
	}
	if !r2.Duplicate {
		t.Fatalf("expected Duplicate=true on repeated idempotency_key")
	}
	if r2.Balance.Remaining != r.Balance.Remaining {
		t.Fatalf("live idempotency failed: %v → %v", r.Balance.Remaining, r2.Balance.Remaining)
	}

	// Checkout a top-up → must return a Stripe URL.
	co, err := c.Checkout(ctx, CheckoutParams{
		CustomerID: id, ProductID: "top_up",
		Options:    []CheckoutOption{{FeatureID: "credits", Quantity: 10}},
		SuccessURL: "https://app.opencomputer.dev/billing",
	})
	if err != nil {
		t.Fatalf("checkout: %v", err)
	}
	if co.URL == "" {
		t.Fatalf("checkout returned no url")
	}
	t.Logf("live OK: remaining=%.4f checkout=%s", r2.Balance.Remaining, co.URL[:40])
}
