package types

import (
	"encoding/json"
	"time"
)

// Sandbox lifecycle webhook event types (the public taxonomy). Wire values are
// the camelCase/namespaced public names; internal worker strings ("created",
// "running", "migrated") are mapped to these at the ingress.
const (
	WebhookEventCreated           = "sandbox.created"
	WebhookEventReady             = "sandbox.ready"
	WebhookEventHibernated        = "sandbox.hibernated"
	WebhookEventResumed           = "sandbox.resumed"
	WebhookEventStopped           = "sandbox.stopped"
	WebhookEventMigrated          = "sandbox.migrated"
	WebhookEventCheckpointCreated = "sandbox.checkpoint.created"
	WebhookEventForked            = "sandbox.forked"
	WebhookEventScaled            = "sandbox.scaled"
	WebhookEventPreviewURLChanged = "sandbox.preview_url.changed"
	WebhookEventTest              = "sandbox.test"
)

// Delivery statuses. failed = retryable (future next_attempt_at); dead_letter &
// canceled are terminal.
const (
	WebhookDeliveryPending    = "pending"
	WebhookDeliveryDelivering = "delivering"
	WebhookDeliveryDelivered  = "delivered"
	WebhookDeliveryFailed     = "failed"
	WebhookDeliveryDeadLetter = "dead_letter"
	WebhookDeliveryCanceled   = "canceled"
)

// WebhookDestination is the public (camelCase) representation of a subscription.
// Name and SandboxID are pointers so an unset value serializes as JSON null
// (matching the documented contract). Secret is present ONLY on the create
// response or a generated rotation — never on reads.
type WebhookDestination struct {
	ID         string    `json:"id"`
	Name       *string   `json:"name"`
	URL        string    `json:"url"`
	EventTypes []string  `json:"eventTypes"`
	SandboxID  *string   `json:"sandboxId"`
	Enabled    bool      `json:"enabled"`
	HasSecret  bool      `json:"hasSecret"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
	Secret     string    `json:"secret,omitempty"`
}

// CreateWebhookRequest is the POST /api/webhooks body.
type CreateWebhookRequest struct {
	URL        string   `json:"url"`
	Name       *string  `json:"name,omitempty"`
	Secret     string   `json:"secret,omitempty"`
	EventTypes []string `json:"eventTypes,omitempty"`
	SandboxID  *string  `json:"sandboxId,omitempty"`
	Enabled    *bool    `json:"enabled,omitempty"`
}

// WebhookDelivery is the public (camelCase) delivery record. Nullable fields are
// pointers so they serialize as JSON null rather than being omitted.
type WebhookDelivery struct {
	ID            string     `json:"id"`
	Destination   string     `json:"destination"`
	EventID       string     `json:"eventId"`
	EventType     string     `json:"eventType"`
	Status        string     `json:"status"`
	Attempts      int        `json:"attempts"`
	RetryCount    int        `json:"retryCount"`
	LastAttemptAt *time.Time `json:"lastAttemptAt"`
	ResponseCode  *int       `json:"responseCode"`
	Error         *string    `json:"error"`
	CreatedAt     time.Time  `json:"createdAt"`
	UpdatedAt     time.Time  `json:"updatedAt"`
	DeliveredAt   *time.Time `json:"deliveredAt"`
}

// WebhookDeliveryPage is a cursor-paginated list of deliveries.
type WebhookDeliveryPage struct {
	Data       []WebhookDelivery `json:"data"`
	NextCursor *string           `json:"nextCursor"`
	HasMore    bool              `json:"hasMore"`
}

// WebhookTestResult is the synchronous POST /api/webhooks/:id/test response.
type WebhookTestResult struct {
	Delivered    bool   `json:"delivered"`
	ResponseCode *int   `json:"responseCode"`
	Error        string `json:"error,omitempty"`
}

// SandboxLifecycleEvent is the lifecycle event nested under `event` in a
// delivery envelope.
type SandboxLifecycleEvent struct {
	ID        string          `json:"id"`
	Ts        time.Time       `json:"ts"`
	OrgID     string          `json:"orgId"`
	SandboxID string          `json:"sandboxId"`
	Type      string          `json:"type"`
	Data      json.RawMessage `json:"data"`
}

// SandboxWebhookEnvelope is the JSON body POSTed to a destination. webhook-id
// header == DeliveryID. Metadata is the sandbox's user-set metadata (verbatim,
// for routing without a second lookup); null if unset.
type SandboxWebhookEnvelope struct {
	Type       string                `json:"type"`
	SandboxID  string                `json:"sandboxId"`
	EventID    string                `json:"eventId"`
	DeliveryID string                `json:"deliveryId"`
	Metadata   map[string]string     `json:"metadata"`
	Event      SandboxLifecycleEvent `json:"event"`
}

// SandboxWebhookSpec is an inline webhook on POST /api/sandboxes — registered
// atomically with the sandbox and pinned to it, so it catches created/ready.
type SandboxWebhookSpec struct {
	URL        string   `json:"url"`
	Secret     string   `json:"secret,omitempty"`
	EventTypes []string `json:"eventTypes,omitempty"`
}

// SandboxWebhookResult echoes an inline-registered webhook on the create
// response. Secret is present once iff generated.
type SandboxWebhookResult struct {
	ID     string `json:"id"`
	URL    string `json:"url"`
	Secret string `json:"secret,omitempty"`
}
