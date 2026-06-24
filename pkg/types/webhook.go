package types

import "strings"

// Sandbox lifecycle webhook event types (the public taxonomy). The CP records
// these on the outbox; the edge delivers them via Svix. The delivery envelope +
// destination/delivery shapes live at the edge (TS) now, not here.
// See .agents/work/sandbox-webhooks-rearchitecture.md.
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

// WebhookEventTypes is the full set of subscribable lifecycle types (excludes the
// synthetic sandbox.test, which is only sent by /test).
var WebhookEventTypes = []string{
	WebhookEventCreated, WebhookEventReady, WebhookEventHibernated, WebhookEventResumed,
	WebhookEventStopped, WebhookEventMigrated, WebhookEventCheckpointCreated,
	WebhookEventForked, WebhookEventScaled, WebhookEventPreviewURLChanged,
}

// ValidWebhookEventFilter reports whether s is a valid eventTypes entry: an exact
// known type, or a "prefix.*" wildcard that matches at least one known type
// (e.g. "sandbox.*", "sandbox.checkpoint.*"). The edge expands wildcards to the
// concrete types before registering the Svix endpoint.
func ValidWebhookEventFilter(s string) bool {
	if strings.HasSuffix(s, ".*") {
		prefix := strings.TrimSuffix(s, "*") // keep the trailing dot, e.g. "sandbox."
		for _, t := range WebhookEventTypes {
			if strings.HasPrefix(t, prefix) {
				return true
			}
		}
		return false
	}
	for _, t := range WebhookEventTypes {
		if t == s {
			return true
		}
	}
	return false
}

// SandboxWebhookSpec is an inline webhook on POST /api/sandboxes — pinned to the
// sandbox and registered (via the edge) before it emits `created`. Best-effort: a
// registration failure is logged and the sandbox still creates; check the create
// response's `webhooks` for what actually registered.
type SandboxWebhookSpec struct {
	URL        string   `json:"url"`
	Secret     string   `json:"secret,omitempty"`
	EventTypes []string `json:"eventTypes,omitempty"`
}

// SandboxWebhookResult echoes an inline-registered webhook on the create response.
// Secret is present once iff the edge generated it.
type SandboxWebhookResult struct {
	ID     string `json:"id"`
	URL    string `json:"url"`
	Secret string `json:"secret,omitempty"`
}
