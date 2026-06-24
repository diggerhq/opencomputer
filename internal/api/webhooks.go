package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/opensandbox/opensandbox/internal/auth"
	"github.com/opensandbox/opensandbox/internal/db"
	"github.com/opensandbox/opensandbox/internal/webhook"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// Sandbox lifecycle webhooks — the org-scoped management API. Auth is the org
// API key (no granular scopes); ownership is enforced by org id on every query.
// See .agents/work/sandbox-lifecycle-webhooks.md.

const (
	webhookConnectTimeout = 10 * time.Second
	webhookSendTimeout    = 15 * time.Second
)

// webhookCtx resolves the store + org id, writing the appropriate error response
// and returning ok=false if either is unavailable.
func (s *Server) webhookCtx(c echo.Context) (*db.Store, uuid.UUID, bool) {
	if s.store == nil {
		_ = c.JSON(http.StatusServiceUnavailable, map[string]string{"error": "webhooks require the control-plane database"})
		return nil, uuid.Nil, false
	}
	orgID, ok := auth.GetOrgID(c)
	if !ok {
		_ = c.JSON(http.StatusUnauthorized, map[string]string{"error": "org context required"})
		return nil, uuid.Nil, false
	}
	return s.store, orgID, true
}

func webhookStoreError(c echo.Context, err error) error {
	switch {
	case errors.Is(err, db.ErrWebhookNotFound):
		return c.JSON(http.StatusNotFound, map[string]string{"error": "webhook not found"})
	case errors.Is(err, db.ErrWebhookNameConflict):
		return c.JSON(http.StatusConflict, map[string]string{"error": "a webhook with this name already exists with a different configuration"})
	case errors.Is(err, db.ErrWebhookIdempotencyConflict):
		return c.JSON(http.StatusConflict, map[string]string{"error": "Idempotency-Key reused with a different request"})
	case errors.Is(err, db.ErrEncryptionNotConfigured):
		return c.JSON(http.StatusServiceUnavailable, map[string]string{"error": "webhook secret encryption is not configured on this server"})
	default:
		return c.JSON(http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}
}

func toWireDestination(d *db.WebhookDestinationRow, secret string) types.WebhookDestination {
	et := d.EventTypes
	if et == nil {
		et = []string{}
	}
	return types.WebhookDestination{
		ID:         d.ID,
		Name:       d.Name,
		URL:        d.URL,
		EventTypes: et,
		SandboxID:  d.SandboxID,
		Enabled:    d.Enabled,
		HasSecret:  d.HasSecret,
		CreatedAt:  d.CreatedAt,
		UpdatedAt:  d.UpdatedAt,
		Secret:     secret,
	}
}

func toWireDelivery(d *db.WebhookDeliveryRow) types.WebhookDelivery {
	return types.WebhookDelivery{
		ID:            d.ID,
		Destination:   d.DestinationID,
		EventID:       d.EventID,
		EventType:     d.EventType,
		Status:        d.Status,
		Attempts:      d.Attempts,
		RetryCount:    d.RetryCount,
		LastAttemptAt: d.LastAttemptAt,
		ResponseCode:  d.ResponseCode,
		Error:         d.Error,
		CreatedAt:     d.CreatedAt,
		UpdatedAt:     d.UpdatedAt,
		DeliveredAt:   d.DeliveredAt,
	}
}

// webhookRequestHash fingerprints a create request for Idempotency-Key matching.
func webhookRequestHash(req types.CreateWebhookRequest) string {
	h := sha256.New()
	fmt.Fprintf(h, "url=%s\n", req.URL)
	fmt.Fprintf(h, "eventTypes=%v\n", req.EventTypes)
	sb := ""
	if req.SandboxID != nil {
		sb = *req.SandboxID
	}
	fmt.Fprintf(h, "sandboxId=%s\n", sb)
	nm := ""
	if req.Name != nil {
		nm = *req.Name
	}
	fmt.Fprintf(h, "name=%s\n", nm)
	// Include enabled + secret so the same key with a different paused state or
	// signing secret is a different request (→ 409), not a silent reuse.
	en := "unset"
	if req.Enabled != nil {
		en = fmt.Sprintf("%t", *req.Enabled)
	}
	fmt.Fprintf(h, "enabled=%s\n", en)
	fmt.Fprintf(h, "secret=%s\n", req.Secret)
	return hex.EncodeToString(h.Sum(nil))
}

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
// create time — the all-Svix-at-edge replacement for registerInlineWebhooks.
// Nil-safe + best-effort: returns nil (logging) if there's no edge client or the
// edge call fails, so a webhook hiccup never fails the sandbox create.
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

// registerInlineWebhooks registers webhooks supplied inline on sandbox create,
// each pinned to the sandbox with no watermark floor (created_after_event_seq=0
// → full lifecycle from `created`). Best-effort: a bad URL or register error is
// logged and skipped rather than failing an already-created sandbox. Returns the
// results to echo on the create response (secret included once when generated).
func (s *Server) registerInlineWebhooks(ctx context.Context, orgID uuid.UUID, sandboxID string, specs []types.SandboxWebhookSpec) []types.SandboxWebhookResult {
	if s.store == nil || len(specs) == 0 {
		return nil
	}
	out := make([]types.SandboxWebhookResult, 0, len(specs))
	for _, spec := range specs {
		if spec.URL == "" {
			continue
		}
		if err := webhook.ValidateURL(ctx, spec.URL); err != nil {
			log.Printf("sandbox %s: skipping inline webhook %q: %v", sandboxID, spec.URL, err)
			continue
		}
		secret := spec.Secret
		generated := false
		if secret == "" {
			gen, err := webhook.GenerateSecret()
			if err != nil {
				log.Printf("sandbox %s: inline webhook secret generation failed: %v", sandboxID, err)
				continue
			}
			secret = gen
			generated = true
		}
		sid := sandboxID
		row, _, err := s.store.CreateWebhookDestination(ctx, db.CreateDestinationParams{
			OrgID:                orgID,
			URL:                  spec.URL,
			EventTypes:           spec.EventTypes,
			SandboxID:            &sid,
			Enabled:              true,
			SecretPlain:          secret,
			CreatedAfterEventSeq: 0,
		})
		if err != nil {
			log.Printf("sandbox %s: inline webhook register failed: %v", sandboxID, err)
			continue
		}
		res := types.SandboxWebhookResult{ID: row.ID, URL: row.URL}
		if generated {
			res.Secret = secret
		}
		out = append(out, res)
	}
	return out
}

// POST /api/webhooks
func (s *Server) createWebhook(c echo.Context) error {
	store, orgID, ok := s.webhookCtx(c)
	if !ok {
		return nil
	}
	ctx := c.Request().Context()
	var req types.CreateWebhookRequest
	if err := c.Bind(&req); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "invalid request body: " + err.Error()})
	}
	if req.URL == "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "url is required"})
	}
	if err := webhook.ValidateURL(ctx, req.URL); err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "invalid webhook url: " + err.Error()})
	}
	if bad := firstInvalidEventType(req.EventTypes); bad != "" {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "unknown event type: " + bad})
	}
	if req.SandboxID != nil {
		owned, err := store.SandboxBelongsToOrg(ctx, orgID, *req.SandboxID)
		if err != nil {
			return webhookStoreError(c, err)
		}
		if !owned {
			return c.JSON(http.StatusBadRequest, map[string]string{"error": "sandboxId not found for this org"})
		}
	}

	idemKey := c.Request().Header.Get("Idempotency-Key")
	claimed := false
	if idemKey != "" {
		outcome, stored, err := store.ReserveIdempotencyKey(ctx, orgID, idemKey, webhookRequestHash(req))
		if err != nil {
			return webhookStoreError(c, err)
		}
		switch outcome {
		case db.WebhookIdemReplay:
			return c.JSONBlob(http.StatusCreated, stored)
		case db.WebhookIdemConflict:
			return c.JSON(http.StatusConflict, map[string]string{"error": "Idempotency-Key reused with a different request"})
		case db.WebhookIdemInProgress:
			// Transient: another request holds the claim. Signal retryability so
			// clients/agents don't treat it as fatal.
			c.Response().Header().Set("Retry-After", "1")
			return c.JSON(http.StatusConflict, map[string]string{
				"error": "a request with this Idempotency-Key is already in progress; retry shortly",
				"code":  "idempotency_in_progress",
			})
		case db.WebhookIdemClaimed:
			claimed = true
		}
	}
	// From here on, any early return must release the claim so a retry can proceed.
	release := func() {
		if claimed {
			_ = store.ReleaseIdempotencyKey(ctx, orgID, idemKey)
		}
	}

	secret := req.Secret
	generated := false
	if secret == "" {
		gen, err := webhook.GenerateSecret()
		if err != nil {
			release()
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": "failed to generate signing secret"})
		}
		secret = gen
		generated = true
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	seq, err := store.CurrentLifecycleSeq(ctx)
	if err != nil {
		release()
		return webhookStoreError(c, err)
	}

	row, reused, err := store.CreateWebhookDestination(ctx, db.CreateDestinationParams{
		OrgID:                orgID,
		Name:                 req.Name,
		URL:                  req.URL,
		EventTypes:           req.EventTypes,
		SandboxID:            req.SandboxID,
		Enabled:              enabled,
		SecretPlain:          secret,
		CreatedAfterEventSeq: seq,
	})
	if err != nil {
		release()
		return webhookStoreError(c, err)
	}

	echoSecret := ""
	status := http.StatusCreated
	if reused {
		status = http.StatusOK // existing destination matched by name — no secret echo
	} else if generated {
		echoSecret = secret
	}
	resp := toWireDestination(row, echoSecret)

	if claimed {
		body, _ := json.Marshal(resp)
		if ferr := store.FinalizeIdempotencyKey(ctx, orgID, idemKey, row.ID, body); ferr != nil {
			// The one-time secret would otherwise be unrecoverable — fail the
			// request and clean up so the client can safely retry.
			if !reused {
				_ = store.SoftDeleteWebhookDestination(ctx, orgID, row.ID)
			}
			_ = store.ReleaseIdempotencyKey(ctx, orgID, idemKey)
			return c.JSON(http.StatusInternalServerError, map[string]string{"error": "failed to persist idempotent response; please retry"})
		}
	}
	return c.JSON(status, resp)
}

// validateInlineWebhooks checks inline webhook specs up-front (URL + event
// types) so a bad spec fails sandbox creation rather than being silently skipped
// (P2 review). Returns nil if all are valid (or none supplied).
func validateInlineWebhooks(ctx context.Context, specs []types.SandboxWebhookSpec) error {
	for _, w := range specs {
		if w.URL == "" {
			return fmt.Errorf("webhooks[].url is required")
		}
		if err := webhook.ValidateURL(ctx, w.URL); err != nil {
			return fmt.Errorf("invalid webhook url: %w", err)
		}
		if bad := firstInvalidEventType(w.EventTypes); bad != "" {
			return fmt.Errorf("unknown event type: %s", bad)
		}
	}
	return nil
}

// firstInvalidEventType returns the first eventTypes entry that isn't a valid
// exact type or "prefix.*" wildcard, or "" if all are valid.
func firstInvalidEventType(ets []string) string {
	for _, e := range ets {
		if !types.ValidWebhookEventFilter(e) {
			return e
		}
	}
	return ""
}

// GET /api/webhooks
func (s *Server) listWebhooks(c echo.Context) error {
	store, orgID, ok := s.webhookCtx(c)
	if !ok {
		return nil
	}
	rows, err := store.ListWebhookDestinations(c.Request().Context(), orgID)
	if err != nil {
		return webhookStoreError(c, err)
	}
	out := make([]types.WebhookDestination, 0, len(rows))
	for _, r := range rows {
		out = append(out, toWireDestination(r, ""))
	}
	// Canonical shape: { "data": [...] } (matches the docs + deliveries list).
	return c.JSON(http.StatusOK, map[string][]types.WebhookDestination{"data": out})
}

// GET /api/webhooks/:id
func (s *Server) getWebhook(c echo.Context) error {
	store, orgID, ok := s.webhookCtx(c)
	if !ok {
		return nil
	}
	row, err := store.GetWebhookDestination(c.Request().Context(), orgID, c.Param("id"))
	if err != nil {
		return webhookStoreError(c, err)
	}
	return c.JSON(http.StatusOK, toWireDestination(row, ""))
}

// PATCH /api/webhooks/:id
func (s *Server) updateWebhook(c echo.Context) error {
	store, orgID, ok := s.webhookCtx(c)
	if !ok {
		return nil
	}
	ctx := c.Request().Context()
	id := c.Param("id")

	raw := map[string]json.RawMessage{}
	if err := json.NewDecoder(c.Request().Body).Decode(&raw); err != nil && !errors.Is(err, io.EOF) {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "invalid request body: " + err.Error()})
	}
	if _, present := raw["sandboxId"]; present {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "sandboxId (scope) is immutable and cannot be changed"})
	}

	var p db.UpdateDestinationParams
	badField := func(field string) error {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "invalid value for " + field})
	}
	if v, present := raw["url"]; present {
		var u string
		if err := json.Unmarshal(v, &u); err != nil {
			return badField("url")
		}
		if err := webhook.ValidateURL(ctx, u); err != nil {
			return c.JSON(http.StatusBadRequest, map[string]string{"error": "invalid webhook url: " + err.Error()})
		}
		p.URL = &u
	}
	if v, present := raw["eventTypes"]; present {
		if string(v) == "null" {
			p.ClearEventTypes = true
		} else {
			var et []string
			if err := json.Unmarshal(v, &et); err != nil {
				return badField("eventTypes")
			}
			if bad := firstInvalidEventType(et); bad != "" {
				return c.JSON(http.StatusBadRequest, map[string]string{"error": "unknown event type: " + bad})
			}
			if len(et) == 0 {
				p.ClearEventTypes = true
			} else {
				p.EventTypes = &et
			}
		}
	}
	if v, present := raw["enabled"]; present {
		var b bool
		if err := json.Unmarshal(v, &b); err != nil {
			return badField("enabled")
		}
		p.Enabled = &b
	}
	if v, present := raw["name"]; present {
		var n string
		if err := json.Unmarshal(v, &n); err != nil {
			return badField("name")
		}
		p.Name = &n
	}
	if v, present := raw["secret"]; present {
		var sec string
		if err := json.Unmarshal(v, &sec); err != nil {
			return badField("secret")
		}
		if sec != "" {
			p.NewSecretPlain = &sec
		}
	}
	generated := false
	if v, present := raw["rotateSecret"]; present {
		var rot bool
		if err := json.Unmarshal(v, &rot); err != nil {
			return badField("rotateSecret")
		}
		if rot {
			gen, err := webhook.GenerateSecret()
			if err != nil {
				return c.JSON(http.StatusInternalServerError, map[string]string{"error": "failed to generate signing secret"})
			}
			p.NewSecretPlain = &gen
			generated = true
		}
	}

	row, err := store.UpdateWebhookDestination(ctx, orgID, id, p)
	if err != nil {
		return webhookStoreError(c, err)
	}
	echoSecret := ""
	if generated && p.NewSecretPlain != nil {
		echoSecret = *p.NewSecretPlain
	}
	return c.JSON(http.StatusOK, toWireDestination(row, echoSecret))
}

// DELETE /api/webhooks/:id
func (s *Server) deleteWebhook(c echo.Context) error {
	store, orgID, ok := s.webhookCtx(c)
	if !ok {
		return nil
	}
	if err := store.SoftDeleteWebhookDestination(c.Request().Context(), orgID, c.Param("id")); err != nil {
		return webhookStoreError(c, err)
	}
	return c.NoContent(http.StatusNoContent)
}

// POST /api/webhooks/:id/test — synchronous connectivity check. Bypasses the
// event-type filter, creates no delivery row, and is not retried.
func (s *Server) testWebhook(c echo.Context) error {
	store, orgID, ok := s.webhookCtx(c)
	if !ok {
		return nil
	}
	ctx := c.Request().Context()
	id := c.Param("id")
	dest, err := store.GetWebhookDestination(ctx, orgID, id)
	if err != nil {
		return webhookStoreError(c, err)
	}
	secret, err := store.GetWebhookDestinationSecret(ctx, id)
	if err != nil {
		return webhookStoreError(c, err)
	}

	sandboxID := ""
	if dest.SandboxID != nil {
		sandboxID = *dest.SandboxID
	}
	deliveryID := "whd_test_" + uuid.NewString()
	now := time.Now().UTC()
	env := types.SandboxWebhookEnvelope{
		Type:       types.WebhookEventTest,
		SandboxID:  sandboxID,
		EventID:    "evt_test",
		DeliveryID: deliveryID,
		Event: types.SandboxLifecycleEvent{
			ID:        "evt_test",
			Ts:        now,
			OrgID:     orgID.String(),
			SandboxID: sandboxID,
			Type:      types.WebhookEventTest,
			Data:      json.RawMessage(`{"message":"Test event from OpenComputer."}`),
		},
	}
	body, _ := json.Marshal(env)

	headers := webhook.Headers(secret, deliveryID, sandboxID, now.Unix(), body)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, dest.URL, bytes.NewReader(body))
	if err != nil {
		return c.JSON(http.StatusBadRequest, map[string]string{"error": "invalid destination url"})
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	client := webhook.SafeClient(webhookConnectTimeout, webhookSendTimeout)
	resp, err := client.Do(req)
	result := types.WebhookTestResult{}
	if err != nil {
		result.Delivered = false
		result.Error = err.Error()
		return c.JSON(http.StatusOK, result)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64*1024))
	code := resp.StatusCode
	result.ResponseCode = &code
	result.Delivered = code >= 200 && code < 300
	if !result.Delivered {
		result.Error = fmt.Sprintf("non-2xx response: %d", code)
	}
	return c.JSON(http.StatusOK, result)
}

// GET /api/webhooks/:id/deliveries
func (s *Server) listWebhookDeliveries(c echo.Context) error {
	store, orgID, ok := s.webhookCtx(c)
	if !ok {
		return nil
	}
	limit, _ := strconv.Atoi(c.QueryParam("limit"))
	rows, next, hasMore, err := store.ListWebhookDeliveries(
		c.Request().Context(), orgID, c.Param("id"),
		c.QueryParam("status"), c.QueryParam("cursor"), limit)
	if err != nil {
		return webhookStoreError(c, err)
	}
	data := make([]types.WebhookDelivery, 0, len(rows))
	for _, r := range rows {
		data = append(data, toWireDelivery(r))
	}
	return c.JSON(http.StatusOK, types.WebhookDeliveryPage{Data: data, NextCursor: next, HasMore: hasMore})
}

// GET /api/webhooks/:id/deliveries/:deliveryId
func (s *Server) getWebhookDelivery(c echo.Context) error {
	store, orgID, ok := s.webhookCtx(c)
	if !ok {
		return nil
	}
	row, err := store.GetWebhookDelivery(c.Request().Context(), orgID, c.Param("id"), c.Param("deliveryId"))
	if err != nil {
		return webhookStoreError(c, err)
	}
	return c.JSON(http.StatusOK, toWireDelivery(row))
}

// POST /api/webhooks/:id/deliveries/:deliveryId/redeliver
func (s *Server) redeliverWebhookDelivery(c echo.Context) error {
	store, orgID, ok := s.webhookCtx(c)
	if !ok {
		return nil
	}
	row, err := store.RedeliverDelivery(c.Request().Context(), orgID, c.Param("id"), c.Param("deliveryId"))
	if err != nil {
		return webhookStoreError(c, err)
	}
	return c.JSON(http.StatusAccepted, toWireDelivery(row))
}
