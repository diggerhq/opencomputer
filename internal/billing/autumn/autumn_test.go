package autumn

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The REST client must send the snake_case wire format we validated against the
// sandbox — especially idempotency_key (the camelCase form is silently ignored).
func TestRESTClient_Track_WireFormat(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/track" || r.Method != http.MethodPost {
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer am_sk_test_x" {
			t.Errorf("bad auth header: %q", r.Header.Get("Authorization"))
		}
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &got)
		_, _ = w.Write([]byte(`{"balance":{"feature_id":"credits","remaining":4.46,"usage":0.54,"granted":5}}`))
	}))
	defer srv.Close()

	c := New("am_sk_test_x", WithBaseURL(srv.URL))
	res, err := c.Track(context.Background(), TrackParams{
		CustomerID: "org-1", FeatureID: "compute_64gb", Value: 1000, IdempotencyKey: "k1",
	})
	if err != nil {
		t.Fatalf("track: %v", err)
	}
	if got["customer_id"] != "org-1" || got["feature_id"] != "compute_64gb" {
		t.Fatalf("wrong body: %v", got)
	}
	if got["value"].(float64) != 1000 {
		t.Fatalf("wrong value: %v", got["value"])
	}
	if got["idempotency_key"] != "k1" {
		t.Fatalf("idempotency_key must be snake_case and present, got: %v", got["idempotency_key"])
	}
	if res.Balance.Remaining != 4.46 {
		t.Fatalf("decoded remaining = %v, want 4.46", res.Balance.Remaining)
	}
}

func TestRESTClient_GetCustomer_DecodesPlansAndBalance(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{
			"id":"org-1",
			"subscriptions":[
				{"plan_id":"base","add_on":false,"status":"active"},
				{"plan_id":"concurrency_pro","add_on":true,"status":"active"}
			],
			"balances":{"credits":{"feature_id":"credits","remaining":3.38,"granted":5,"usage":1.62}}
		}`))
	}))
	defer srv.Close()

	c := New("am_sk_test_x", WithBaseURL(srv.URL))
	cust, err := c.GetCustomer(context.Background(), "org-1")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	if cust.CreditsRemaining() != 3.38 {
		t.Fatalf("credits = %v, want 3.38", cust.CreditsRemaining())
	}
	if cust.MaxConcurrency() != 100 {
		t.Fatalf("concurrency = %d, want 100 (base+pro → max)", cust.MaxConcurrency())
	}
}

func TestRESTClient_APIError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"error":"not found"}`))
	}))
	defer srv.Close()
	c := New("am_sk_test_x", WithBaseURL(srv.URL))
	_, err := c.GetCustomer(context.Background(), "missing")
	if !IsNotFound(err) {
		t.Fatalf("expected IsNotFound, got %v", err)
	}
}

func TestMaxConcurrency_Mapping(t *testing.T) {
	cases := []struct {
		plans []string
		want  int
	}{
		{[]string{"base"}, 5},
		{[]string{"base", "concurrency_pro"}, 100},
		{[]string{"base", "concurrency_pro_plus"}, 600},
		{[]string{"base", "concurrency_pro_plus_plus"}, 1000},
		{[]string{"base", "concurrency_pro", "concurrency_pro_plus_plus"}, 1000}, // max wins
		{nil, 5}, // no plans → default
	}
	for _, tc := range cases {
		c := &Customer{}
		for _, p := range tc.plans {
			c.Subscriptions = append(c.Subscriptions, Subscription{PlanID: p, Status: "active"})
		}
		if got := c.MaxConcurrency(); got != tc.want {
			t.Errorf("plans %v → %d, want %d", tc.plans, got, tc.want)
		}
	}
}

func TestFake_TrackDeductsAndDedupes(t *testing.T) {
	f := NewFake()
	ctx := context.Background()
	if _, err := f.CreateCustomer(ctx, CreateCustomerParams{ID: "org-1"}); err != nil {
		t.Fatal(err)
	}
	// compute_64gb × 1000 = 0.54 credits.
	r, _ := f.Track(ctx, TrackParams{CustomerID: "org-1", FeatureID: "compute_64gb", Value: 1000, IdempotencyKey: "k1"})
	if d := 5 - r.Balance.Remaining; d < 0.539 || d > 0.541 {
		t.Fatalf("deducted %v, want ~0.54", d)
	}
	// same key again → no further deduction.
	r2, _ := f.Track(ctx, TrackParams{CustomerID: "org-1", FeatureID: "compute_64gb", Value: 1000, IdempotencyKey: "k1"})
	if r2.Balance.Remaining != r.Balance.Remaining {
		t.Fatalf("idempotency failed: %v → %v", r.Balance.Remaining, r2.Balance.Remaining)
	}
	// top-up restores balance.
	f.SimulateTopUp("org-1", 10)
	cust, _ := f.GetCustomer(ctx, "org-1")
	if cust.CreditsRemaining() < 14 {
		t.Fatalf("after top-up remaining = %v, want > 14", cust.CreditsRemaining())
	}
}
