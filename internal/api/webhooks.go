package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/url"
	"time"

	"github.com/google/uuid"

	"github.com/opensandbox/opensandbox/internal/db"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// CP-origin sandbox-webhook source layer. All-Svix-at-edge: webhook management +
// delivery live at the edge (api-edge → Svix, events-ingest → Svix). The CP only
// (1) captures CP-origin lifecycle events into the outbox (recordLifecycle*) and
// (2) forwards inline-on-create specs to the edge (registerInlineWebhooksEdge).
// See .agents/work/sandbox-webhooks-rearchitecture.md.

// recordLifecycleID records a CP-origin lifecycle event with an explicit,
// caller-supplied event id (use a deterministic id for once-per-entity events so
// ON CONFLICT dedups replays). Own transaction; best-effort (logged, never fails
// the request).
func (s *Server) recordLifecycleID(ctx context.Context, orgID uuid.UUID, sandboxID, evType, id string, data map[string]any) {
	if s.store == nil || orgID == uuid.Nil || sandboxID == "" {
		return
	}
	var raw json.RawMessage
	if len(data) > 0 {
		raw, _ = json.Marshal(data)
	}
	if err := s.store.RecordLifecycleEvent(ctx, db.LifecycleEvent{
		ID:        id,
		OrgID:     orgID,
		SandboxID: sandboxID,
		Type:      evType,
		Data:      raw,
	}); err != nil {
		log.Printf("recordLifecycle %s for %s: %v", evType, sandboxID, err)
	}
}

// recordLifecycle records a recurring CP-origin event (scaled, preview_url.changed)
// — each occurrence is a distinct delivery, so the id is made unique per call.
// (Once-per-entity events use recordLifecycleID with a deterministic id.)
func (s *Server) recordLifecycle(ctx context.Context, orgID uuid.UUID, sandboxID, evType string, data map[string]any) {
	s.recordLifecycleID(ctx, orgID, sandboxID, evType,
		fmt.Sprintf("%s:%s:%d", sandboxID, evType, time.Now().UnixNano()), data)
}

// registerInlineWebhooksEdge registers inline webhooks via the edge (Svix) at
// create time. Nil-safe + best-effort: returns nil (logging) if there's no edge
// client or the edge call fails, so a webhook hiccup never fails the sandbox
// create. The CP never talks to Svix directly.
func (s *Server) registerInlineWebhooksEdge(ctx context.Context, orgID uuid.UUID, sandboxID string, specs []types.SandboxWebhookSpec) []types.SandboxWebhookResult {
	if s.edge == nil || len(specs) == 0 {
		return nil
	}
	res, err := s.edge.RegisterInlineWebhooks(ctx, orgID, sandboxID, specs)
	if err != nil {
		log.Printf("sandbox %s: inline webhook edge register failed: %v", sandboxID, err)
		return nil
	}
	return res
}

// validateInlineWebhooks validates inline webhook specs up-front so a bad URL or
// event-type fails the create with a 400 (rather than being silently skipped at
// the edge). Returns the first error found.
func validateInlineWebhooks(_ context.Context, specs []types.SandboxWebhookSpec) error {
	for _, spec := range specs {
		u, err := url.Parse(spec.URL)
		if err != nil || u.Scheme != "https" || u.Host == "" {
			return fmt.Errorf("webhook url must be a valid https URL: %q", spec.URL)
		}
		for _, et := range spec.EventTypes {
			if !types.ValidWebhookEventFilter(et) {
				return fmt.Errorf("invalid webhook event type filter: %q", et)
			}
		}
	}
	return nil
}
