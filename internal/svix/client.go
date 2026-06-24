// Package svix is a thin REST client for the Svix managed-webhook API. OC uses
// Svix for webhook delivery (retries, signing, SSRF, logs); this client lets the
// /api/webhooks proxy manage the org's Svix Application + Endpoints and read its
// delivery (attempt) logs. The edge events-ingest Worker sends messages via its
// own (TS) client. See .agents/work/sandbox-webhooks-rearchitecture.md.
//
// Region is encoded in the token suffix (e.g. "sk_….us" → api.us.svix.com).
package svix

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

// Client talks to one Svix region (derived from the token suffix).
type Client struct {
	token   string
	baseURL string
	hc      *http.Client
}

// NewClient builds a Svix client. token is "sk_<base>.<region>"; the region after
// the final '.' selects the API host (us/eu/in → api.<region>.svix.com). A token
// with no region suffix falls back to api.svix.com.
func NewClient(token string) *Client {
	return &Client{
		token:   token,
		baseURL: baseURLForToken(token),
		hc:      &http.Client{Timeout: 15 * time.Second},
	}
}

func baseURLForToken(token string) string {
	if i := strings.LastIndex(token, "."); i >= 0 && i < len(token)-1 {
		region := token[i+1:]
		// Region codes are short alphanumerics (us, eu, in); guard against a
		// token that simply contains a '.' in its body.
		if region != "" && len(region) <= 4 {
			return "https://api." + region + ".svix.com"
		}
	}
	return "https://api.svix.com"
}

// Enabled reports whether the client has a token (webhooks are off otherwise).
func (c *Client) Enabled() bool { return c != nil && c.token != "" }

// Error is a classified Svix API error. Transient (5xx / 429 / network) callers
// should retry; permanent (4xx) callers should not.
type Error struct {
	StatusCode int
	Op         string
	Body       string
}

func (e *Error) Error() string {
	return fmt.Sprintf("svix %s: HTTP %d: %s", e.Op, e.StatusCode, e.Body)
}

// Transient reports whether the error is worth retrying (5xx, 429, or a
// transport error represented as StatusCode 0).
func (e *Error) Transient() bool {
	return e.StatusCode == 0 || e.StatusCode == http.StatusTooManyRequests || e.StatusCode >= 500
}

// IsTransient classifies any error (including a wrapped *Error) for retry.
func IsTransient(err error) bool {
	var se *Error
	if errors.As(err, &se) {
		return se.Transient()
	}
	return err != nil // unknown errors: treat as transient/retryable
}

// do performs one request. body (if non-nil) is JSON-encoded; out (if non-nil)
// is JSON-decoded from a 2xx response. extraHeaders are applied last (e.g.
// idempotency-key). Non-2xx returns a classified *Error.
func (c *Client) do(ctx context.Context, op, method, path string, body, out any, extraHeaders map[string]string) error {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("svix %s: marshal: %w", op, err)
		}
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, rdr)
	if err != nil {
		return fmt.Errorf("svix %s: new request: %w", op, err)
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range extraHeaders {
		req.Header.Set(k, v)
	}
	resp, err := c.hc.Do(req)
	if err != nil {
		return &Error{StatusCode: 0, Op: op, Body: err.Error()}
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &Error{StatusCode: resp.StatusCode, Op: op, Body: string(respBody)}
	}
	if out != nil && len(respBody) > 0 {
		if err := json.Unmarshal(respBody, out); err != nil {
			return fmt.Errorf("svix %s: decode response: %w", op, err)
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Applications (one per org, keyed by uid = org id)
// ---------------------------------------------------------------------------

// Application is the subset of a Svix app we use.
type Application struct {
	ID  string `json:"id"`
	UID string `json:"uid"`
}

// EnsureApplication creates (or returns, via get_if_exists) the org's app keyed
// by uid. Idempotent: safe to call on every webhook create.
func (c *Client) EnsureApplication(ctx context.Context, uid, name string) (*Application, error) {
	var app Application
	err := c.do(ctx, "ensure_application", http.MethodPost,
		"/api/v1/app/?get_if_exists=true",
		map[string]any{"uid": uid, "name": name}, &app, nil)
	if err != nil {
		return nil, err
	}
	return &app, nil
}

// ---------------------------------------------------------------------------
// Endpoints (destinations under an app)
// ---------------------------------------------------------------------------

// Endpoint is the subset of a Svix endpoint we surface.
type Endpoint struct {
	ID          string            `json:"id"`
	URL         string            `json:"url"`
	Description string            `json:"description"`
	Disabled    bool              `json:"disabled"`
	FilterTypes []string          `json:"filterTypes,omitempty"`
	Channels    []string          `json:"channels,omitempty"`
	Metadata    map[string]string `json:"metadata,omitempty"`
	CreatedAt   string            `json:"createdAt,omitempty"`
}

// EndpointParams is the create/update payload (fields left zero are omitted).
type EndpointParams struct {
	URL         string            `json:"url"`
	Description string            `json:"description,omitempty"`
	FilterTypes []string          `json:"filterTypes,omitempty"`
	Channels    []string          `json:"channels,omitempty"`
	Metadata    map[string]string `json:"metadata,omitempty"`
	Disabled    *bool             `json:"disabled,omitempty"`
}

// CreateEndpoint registers a destination under the org's app. The signing secret
// is generated by Svix; fetch it with GetEndpointSecret.
func (c *Client) CreateEndpoint(ctx context.Context, appID string, p EndpointParams) (*Endpoint, error) {
	var ep Endpoint
	if err := c.do(ctx, "create_endpoint", http.MethodPost,
		"/api/v1/app/"+appID+"/endpoint/", p, &ep, nil); err != nil {
		return nil, err
	}
	return &ep, nil
}

// UpdateEndpoint replaces an endpoint's config (PUT).
func (c *Client) UpdateEndpoint(ctx context.Context, appID, epID string, p EndpointParams) (*Endpoint, error) {
	var ep Endpoint
	if err := c.do(ctx, "update_endpoint", http.MethodPut,
		"/api/v1/app/"+appID+"/endpoint/"+epID+"/", p, &ep, nil); err != nil {
		return nil, err
	}
	return &ep, nil
}

// GetEndpoint fetches a single endpoint.
func (c *Client) GetEndpoint(ctx context.Context, appID, epID string) (*Endpoint, error) {
	var ep Endpoint
	if err := c.do(ctx, "get_endpoint", http.MethodGet,
		"/api/v1/app/"+appID+"/endpoint/"+epID+"/", nil, &ep, nil); err != nil {
		return nil, err
	}
	return &ep, nil
}

// ListEndpoints lists endpoints under an app (first page; iterate=false default).
func (c *Client) ListEndpoints(ctx context.Context, appID string) ([]Endpoint, error) {
	var out struct {
		Data []Endpoint `json:"data"`
	}
	if err := c.do(ctx, "list_endpoints", http.MethodGet,
		"/api/v1/app/"+appID+"/endpoint/?limit=250", nil, &out, nil); err != nil {
		return nil, err
	}
	return out.Data, nil
}

// DeleteEndpoint removes an endpoint (idempotent enough; 404 surfaces as *Error).
func (c *Client) DeleteEndpoint(ctx context.Context, appID, epID string) error {
	return c.do(ctx, "delete_endpoint", http.MethodDelete,
		"/api/v1/app/"+appID+"/endpoint/"+epID+"/", nil, nil, nil)
}

// GetEndpointSecret returns the endpoint's signing secret (whsec_…).
func (c *Client) GetEndpointSecret(ctx context.Context, appID, epID string) (string, error) {
	var out struct {
		Key string `json:"key"`
	}
	if err := c.do(ctx, "get_endpoint_secret", http.MethodGet,
		"/api/v1/app/"+appID+"/endpoint/"+epID+"/secret/", nil, &out, nil); err != nil {
		return "", err
	}
	return out.Key, nil
}

// SetEndpointHeaders sets custom HTTP headers delivered on every request to the
// endpoint — how per-destination registration metadata rides each delivery.
func (c *Client) SetEndpointHeaders(ctx context.Context, appID, epID string, headers map[string]string) error {
	return c.do(ctx, "set_endpoint_headers", http.MethodPut,
		"/api/v1/app/"+appID+"/endpoint/"+epID+"/headers/",
		map[string]any{"headers": headers}, nil, nil)
}

// SendExample sends Svix's example event of the given type to an endpoint. NOTE:
// Svix requires the event type to have a registered schema with examples, else it
// 400s (missing_schema). For POST /api/webhooks/:id/test we instead send a real
// CreateMessage with a synthetic payload, which has no schema dependency.
func (c *Client) SendExample(ctx context.Context, appID, epID, eventType string) error {
	return c.do(ctx, "send_example", http.MethodPost,
		"/api/v1/app/"+appID+"/endpoint/"+epID+"/send-example/",
		map[string]any{"eventType": eventType}, nil, nil)
}

// ---------------------------------------------------------------------------
// Messages (events sent to an app; Svix fans out to matching endpoints)
// ---------------------------------------------------------------------------

// Message is the subset of a created message we surface.
type Message struct {
	ID      string `json:"id"`
	EventID string `json:"eventId,omitempty"`
}

// MessageParams is the create-message payload.
type MessageParams struct {
	EventType string // public type, e.g. "sandbox.created"
	EventID   string // optional business id; sanitized to Svix's charset
	Payload   any    // the event envelope (camelCase)
	Channels  []string
	// IdempotencyKey dedupes retries (the raw OC event id — colons allowed in
	// the header). Distinct from EventID, which Svix restricts to [A-Za-z0-9-_.].
	IdempotencyKey string
}

// SanitizeEventID maps an OC event id (which uses ':', e.g.
// "sb-x:sandbox.stopped") into Svix's eventId charset [a-zA-Z0-9-_.] by
// replacing ':' with '.'. The raw id should still be passed as the
// Idempotency-Key (header, unrestricted) for dedup.
func SanitizeEventID(id string) string {
	return strings.ReplaceAll(id, ":", ".")
}

// CreateMessage sends an event to the org's app. Svix fans it out to endpoints
// whose filterTypes/channels match. IdempotencyKey makes retries safe (same key
// → same message, no duplicate).
func (c *Client) CreateMessage(ctx context.Context, appID string, m MessageParams) (*Message, error) {
	body := map[string]any{
		"eventType": m.EventType,
		"payload":   m.Payload,
	}
	if m.EventID != "" {
		body["eventId"] = SanitizeEventID(m.EventID)
	}
	if len(m.Channels) > 0 {
		body["channels"] = m.Channels
	}
	var hdrs map[string]string
	if m.IdempotencyKey != "" {
		hdrs = map[string]string{"idempotency-key": m.IdempotencyKey}
	}
	var out Message
	if err := c.do(ctx, "create_message", http.MethodPost,
		"/api/v1/app/"+appID+"/msg/", body, &out, hdrs); err != nil {
		return nil, err
	}
	return &out, nil
}
