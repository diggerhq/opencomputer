package autumn

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// DefaultBaseURL is the Autumn API root. The sandbox and live environments are
// selected by the API key (am_sk_test_… vs am_sk_…), not the URL.
const DefaultBaseURL = "https://api.useautumn.com/v1"

// RESTClient is the live Autumn API client.
type RESTClient struct {
	baseURL string
	apiKey  string
	http    *http.Client
}

// Option configures a RESTClient.
type Option func(*RESTClient)

// WithBaseURL overrides the API root (tests point this at an httptest server).
func WithBaseURL(u string) Option { return func(c *RESTClient) { c.baseURL = u } }

// WithHTTPClient overrides the underlying HTTP client.
func WithHTTPClient(h *http.Client) Option { return func(c *RESTClient) { c.http = h } }

// New builds a live client. apiKey is the Autumn secret key (am_sk_…).
func New(apiKey string, opts ...Option) *RESTClient {
	c := &RESTClient{
		baseURL: DefaultBaseURL,
		apiKey:  apiKey,
		http:    &http.Client{Timeout: 15 * time.Second},
	}
	for _, o := range opts {
		o(c)
	}
	return c
}

var _ Client = (*RESTClient)(nil)

// do executes a JSON request and decodes the response into out (if non-nil).
func (c *RESTClient) do(ctx context.Context, method, path string, body, out any) error {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("autumn: marshal %s: %w", path, err)
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, rdr)
	if err != nil {
		return fmt.Errorf("autumn: build request %s: %w", path, err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("autumn: %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	data, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &APIError{StatusCode: resp.StatusCode, Body: string(data)}
	}
	if out != nil {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("autumn: decode %s: %w", path, err)
		}
	}
	return nil
}

func (c *RESTClient) CreateCustomer(ctx context.Context, p CreateCustomerParams) (*Customer, error) {
	var cust Customer
	if err := c.do(ctx, http.MethodPost, "/customers", p, &cust); err != nil {
		return nil, err
	}
	return &cust, nil
}

func (c *RESTClient) GetCustomer(ctx context.Context, customerID string) (*Customer, error) {
	var cust Customer
	if err := c.do(ctx, http.MethodGet, "/customers/"+customerID, nil, &cust); err != nil {
		return nil, err
	}
	return &cust, nil
}

func (c *RESTClient) Track(ctx context.Context, p TrackParams) (*TrackResult, error) {
	var resp struct {
		Balance Balance `json:"balance"`
	}
	err := c.do(ctx, http.MethodPost, "/track", p, &resp)
	if err == nil {
		return &TrackResult{Balance: resp.Balance}, nil
	}
	// A duplicate idempotency_key means this usage was already applied (a retry
	// after the first call succeeded server-side). Not an error — re-fetch the
	// current balance so the caller can still act (e.g. halt on remaining <= 0).
	if isDuplicateIdempotency(err) {
		cust, gerr := c.GetCustomer(ctx, p.CustomerID)
		if gerr != nil {
			return &TrackResult{Duplicate: true}, nil
		}
		return &TrackResult{Balance: cust.Balances[CreditsFeatureID], Duplicate: true}, nil
	}
	return nil, err
}

// isDuplicateIdempotency reports whether err is Autumn's 409
// duplicate_idempotency_key response.
func isDuplicateIdempotency(err error) bool {
	var ae *APIError
	return errors.As(err, &ae) && ae.StatusCode == http.StatusConflict &&
		strings.Contains(ae.Body, "duplicate_idempotency_key")
}

func (c *RESTClient) Check(ctx context.Context, p CheckParams) (*CheckResult, error) {
	var resp struct {
		Allowed bool    `json:"allowed"`
		Balance Balance `json:"balance"`
	}
	if err := c.do(ctx, http.MethodPost, "/check", p, &resp); err != nil {
		return nil, err
	}
	return &CheckResult{Allowed: resp.Allowed, Balance: resp.Balance}, nil
}

func (c *RESTClient) Checkout(ctx context.Context, p CheckoutParams) (*CheckoutResult, error) {
	var res CheckoutResult
	if err := c.do(ctx, http.MethodPost, "/checkout", p, &res); err != nil {
		return nil, err
	}
	return &res, nil
}

// SetCreditBalance overwrites the `credits` balance via POST /customers/{id}/balances.
func (c *RESTClient) SetCreditBalance(ctx context.Context, customerID string, balance float64) error {
	body := map[string]any{
		"balances": []map[string]any{{"feature_id": CreditsFeatureID, "balance": balance}},
	}
	return c.do(ctx, http.MethodPost, "/customers/"+customerID+"/balances", body, nil)
}

func asAPIError(err error, target **APIError) bool {
	return errors.As(err, target)
}
