package autumn

import (
	"context"
	"sync"
)

// Fake is an in-memory Client for tests. It mirrors Autumn's behavior: customers
// get the base plan + a signup grant, track() deducts per the credit schema and
// dedupes on idempotency_key, and checkout() returns a stub URL (call
// SimulateTopUp/SimulatePlanChange to model payment completing).
type Fake struct {
	mu        sync.Mutex
	customers map[string]*Customer
	seenKeys  map[string]bool

	// CreditCosts maps a metered feature to its per-unit credit cost (mirrors the
	// Autumn credit schema). SignupGrant is the one-time base grant.
	CreditCosts map[string]float64
	SignupGrant float64
}

// NewFake builds a Fake seeded with the production credit schema + $5 grant.
func NewFake() *Fake {
	return &Fake{
		customers: map[string]*Customer{},
		seenKeys:  map[string]bool{},
		CreditCosts: map[string]float64{
			"compute_1gb":  0.00000108,
			"compute_4gb":  0.00000579,
			"compute_8gb":  0.0000135,
			"compute_16gb": 0.0000270,
			"compute_32gb": 0.000193,
			"compute_64gb": 0.000540,
			"disk_overage": 0.0000001,
		},
		SignupGrant: 5,
	}
}

var _ Client = (*Fake)(nil)

func (f *Fake) CreateCustomer(_ context.Context, p CreateCustomerParams) (*Customer, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if c, ok := f.customers[p.ID]; ok {
		return clone(c), nil
	}
	c := &Customer{
		ID:    p.ID,
		Name:  p.Name,
		Email: p.Email,
		Subscriptions: []Subscription{
			{PlanID: "base", AddOn: false, Status: "active"},
		},
		Balances: map[string]Balance{
			CreditsFeatureID: {FeatureID: CreditsFeatureID, Granted: f.SignupGrant, Remaining: f.SignupGrant},
		},
	}
	f.customers[p.ID] = c
	return clone(c), nil
}

func (f *Fake) GetCustomer(_ context.Context, customerID string) (*Customer, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.customers[customerID]
	if !ok {
		return nil, &APIError{StatusCode: 404, Body: "customer not found"}
	}
	return clone(c), nil
}

func (f *Fake) Track(_ context.Context, p TrackParams) (*TrackResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.customers[p.CustomerID]
	if !ok {
		return nil, &APIError{StatusCode: 404, Body: "customer not found"}
	}
	if p.IdempotencyKey != "" {
		dk := p.IdempotencyKey // global dedupe, mirroring Autumn
		if f.seenKeys[dk] {
			return &TrackResult{Balance: c.Balances[CreditsFeatureID], Duplicate: true}, nil // deduped
		}
		f.seenKeys[dk] = true
	}
	cost := p.Value * f.CreditCosts[p.FeatureID]
	b := c.Balances[CreditsFeatureID]
	b.Remaining -= cost
	b.Usage += cost
	c.Balances[CreditsFeatureID] = b
	return &TrackResult{Balance: b}, nil
}

func (f *Fake) Check(_ context.Context, p CheckParams) (*CheckResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.customers[p.CustomerID]
	if !ok {
		return nil, &APIError{StatusCode: 404, Body: "customer not found"}
	}
	b := c.Balances[p.FeatureID]
	return &CheckResult{Allowed: b.Unlimited || b.Remaining > 0, Balance: b}, nil
}

func (f *Fake) Checkout(_ context.Context, p CheckoutParams) (*CheckoutResult, error) {
	return &CheckoutResult{
		URL:      "https://checkout.stripe.test/" + p.ProductID,
		Currency: "usd",
	}, nil
}

// SetCreditBalance overwrites the credits balance (migration carry-over).
func (f *Fake) SetCreditBalance(_ context.Context, customerID string, balance float64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	c, ok := f.customers[customerID]
	if !ok {
		return &APIError{StatusCode: 404, Body: "customer not found"}
	}
	b := c.Balances[CreditsFeatureID]
	b.Remaining = balance
	c.Balances[CreditsFeatureID] = b
	return nil
}

// SimulateTopUp models a completed credit purchase (manual or auto-recharge).
func (f *Fake) SimulateTopUp(customerID string, credits float64) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if c, ok := f.customers[customerID]; ok {
		b := c.Balances[CreditsFeatureID]
		b.Remaining += credits
		b.Granted += credits
		c.Balances[CreditsFeatureID] = b
	}
}

// SimulatePlanChange models subscribing to / changing a concurrency plan.
func (f *Fake) SimulatePlanChange(customerID, planID string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if c, ok := f.customers[customerID]; ok {
		c.Subscriptions = append(c.Subscriptions, Subscription{PlanID: planID, AddOn: true, Status: "active"})
	}
}

func clone(c *Customer) *Customer {
	cp := *c
	cp.Subscriptions = append([]Subscription(nil), c.Subscriptions...)
	cp.Balances = make(map[string]Balance, len(c.Balances))
	for k, v := range c.Balances {
		cp.Balances[k] = v
	}
	return &cp
}
