// Package autumn is a thin Go client for the Autumn billing API
// (useautumn.com). Autumn is the source of truth for credit balances and the
// customer's active plans; this package is how the cell creates customers,
// reports usage (track), reads balances/plans, and starts checkouts.
//
// The shapes here were validated against the live sandbox API:
//
//	POST /v1/customers     {id,name,email}                          -> Customer
//	GET  /v1/customers/{id}                                         -> Customer
//	POST /v1/track         {customer_id,feature_id,value,idempotency_key} -> {balance}
//	POST /v1/check         {customer_id,feature_id}                 -> {allowed,balance}
//	POST /v1/checkout      {customer_id,product_id,options,success_url}   -> {url,total}
//
// Auth: Authorization: Bearer am_sk_…   JSON bodies are snake_case. Notably the
// idempotency field is `idempotency_key` (snake_case) — the camelCase form in
// Autumn's docs is silently ignored and will NOT dedupe.
package autumn

import (
	"context"
	"fmt"
)

// CreditsFeatureID is the monetary credit-balance feature.
const CreditsFeatureID = "credits"

// Client is the Autumn API surface the platform depends on. A fake
// implementation (see fake.go) backs tests and lets the rest of the billing
// system be built before pointing at the live API.
type Client interface {
	// CreateCustomer registers an org as an Autumn customer. Autumn auto-attaches
	// the default plan (base) and its one-time credit grant.
	CreateCustomer(ctx context.Context, p CreateCustomerParams) (*Customer, error)
	// GetCustomer returns the customer's active subscriptions + feature balances.
	// This is the authoritative read used to sync the is_halted / max_concurrent
	// projections and to re-check on resume.
	GetCustomer(ctx context.Context, customerID string) (*Customer, error)
	// Track reports usage of a feature, deducting from the credit balance. The
	// returned balance is the post-deduction state, so callers can halt inline
	// when Remaining <= 0. IdempotencyKey makes retries safe.
	Track(ctx context.Context, p TrackParams) (*TrackResult, error)
	// Check reports whether the customer has access/balance for a feature.
	Check(ctx context.Context, p CheckParams) (*CheckResult, error)
	// Checkout starts a Stripe checkout for a product — a one-off top-up or a
	// recurring plan subscription — and returns the URL to redirect the user to.
	Checkout(ctx context.Context, p CheckoutParams) (*CheckoutResult, error)
	// SetCreditBalance overwrites the customer's `credits` balance to the given
	// dollar amount. Used by the migration backfill to carry an org's legacy
	// balance over to Autumn (Autumn floors at 0 when overage isn't allowed).
	SetCreditBalance(ctx context.Context, customerID string, balance float64) error
}

// CreateCustomerParams identifies a new customer (we use the org UUID as the id).
type CreateCustomerParams struct {
	ID    string `json:"id"`
	Name  string `json:"name,omitempty"`
	Email string `json:"email,omitempty"`
	// StripeID links an existing Stripe customer (confirmed accepted live) so a
	// migrated card-on-file org keeps its saved payment method — no re-entry.
	StripeID string `json:"stripe_id,omitempty"`
}

// TrackParams reports `Value` units of `FeatureID` for a customer.
//
// IdempotencyKey is GLOBAL across all customers (Autumn dedupes on the bare key,
// not customer+key), so it must be globally unique — use e.g.
// "<org_id>:<bucket_start>:<feature_id>". A repeat returns 409, surfaced as
// TrackResult.Duplicate.
type TrackParams struct {
	CustomerID     string  `json:"customer_id"`
	FeatureID      string  `json:"feature_id"`
	Value          float64 `json:"value"`
	IdempotencyKey string  `json:"idempotency_key,omitempty"`
}

// TrackResult carries the post-deduction balance. Duplicate is true when the
// idempotency_key had already been seen (Autumn returns 409
// duplicate_idempotency_key) — the usage was applied by the earlier call, and
// Balance reflects the current re-fetched state so callers can still act on it.
type TrackResult struct {
	Balance   Balance
	Duplicate bool
}

// CheckParams asks whether a customer can use a feature.
type CheckParams struct {
	CustomerID string `json:"customer_id"`
	FeatureID  string `json:"feature_id"`
}

// CheckResult is the access decision + current balance.
type CheckResult struct {
	Allowed bool
	Balance Balance
}

// CheckoutParams starts a checkout for a product. Options sets per-feature
// quantities (e.g. credits=10 for a $10 top-up). SuccessURL is where Stripe
// redirects after payment — our handler re-checks the balance there to resume.
type CheckoutParams struct {
	CustomerID string           `json:"customer_id"`
	ProductID  string           `json:"product_id"`
	Options    []CheckoutOption `json:"options,omitempty"`
	SuccessURL string           `json:"success_url,omitempty"`
}

// CheckoutOption sets a quantity for a priced feature in the product.
type CheckoutOption struct {
	FeatureID string `json:"feature_id"`
	Quantity  int    `json:"quantity"`
}

// CheckoutResult is the Stripe checkout to redirect the user to.
type CheckoutResult struct {
	URL      string  `json:"url"`
	Total    float64 `json:"total"`
	Currency string  `json:"currency"`
}

// Customer is the Autumn customer record: who they are, their active plans, and
// their feature balances.
type Customer struct {
	ID            string             `json:"id"`
	Name          string             `json:"name"`
	Email         string             `json:"email"`
	Subscriptions []Subscription     `json:"subscriptions"`
	Balances      map[string]Balance `json:"balances"`
}

// Subscription is one active plan the customer holds (base, a concurrency tier,
// etc.). AddOn distinguishes a stacking add-on (concurrency) from the default.
type Subscription struct {
	PlanID string `json:"plan_id"`
	AddOn  bool   `json:"add_on"`
	Status string `json:"status"`
}

// Balance is a feature balance (for `credits`: the prepaid $ balance).
type Balance struct {
	FeatureID string  `json:"feature_id"`
	Granted   float64 `json:"granted"`
	Remaining float64 `json:"remaining"`
	Usage     float64 `json:"usage"`
	Unlimited bool    `json:"unlimited"`
}

// CreditsRemaining returns the customer's prepaid credit balance ($). Drives the
// is_halted projection: <= 0 means halt.
func (c *Customer) CreditsRemaining() float64 {
	return c.Balances[CreditsFeatureID].Remaining
}

// ConcurrencyByPlan maps a plan id to the concurrent-sandbox limit it grants.
// Concurrency is enforced from our DB; Autumn only tells us which plan the org
// is on. Keep in sync with the Autumn concurrency products.
var ConcurrencyByPlan = map[string]int{
	"base":                      5,
	"concurrency_pro":           100,
	"concurrency_pro_plus":      600,
	"concurrency_pro_plus_plus": 1000,
}

// DefaultConcurrency applies when no known concurrency plan is active.
const DefaultConcurrency = 5

// MaxConcurrency resolves the customer's concurrency limit from their active
// plans — the highest limit among them (so an add-on tier wins over base).
func (c *Customer) MaxConcurrency() int {
	limit := DefaultConcurrency
	for _, s := range c.Subscriptions {
		if s.Status != "" && s.Status != "active" {
			continue
		}
		if v, ok := ConcurrencyByPlan[s.PlanID]; ok && v > limit {
			limit = v
		}
	}
	return limit
}

// APIError is a non-2xx response from Autumn.
type APIError struct {
	StatusCode int
	Body       string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("autumn: http %d: %s", e.StatusCode, e.Body)
}

// IsNotFound reports whether err is a 404 from Autumn (e.g. unknown customer).
func IsNotFound(err error) bool {
	var ae *APIError
	return asAPIError(err, &ae) && ae.StatusCode == 404
}
