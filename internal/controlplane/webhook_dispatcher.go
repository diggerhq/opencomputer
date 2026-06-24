package controlplane

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/opensandbox/opensandbox/internal/db"
	"github.com/opensandbox/opensandbox/internal/webhook"
)

// WebhookDispatcher delivers due webhook_deliveries rows: it claims a batch
// (FOR UPDATE SKIP LOCKED, so multiple CP instances are safe), sends them
// concurrently through a bounded pool, classifies the outcome, and records it
// with the right backoff / dead-letter. A slower sweep reclaims senders that
// crashed mid-flight. Mirrors billing.BillableEventsSender's lifecycle.
//
// See .agents/work/sandbox-lifecycle-webhooks.md §6/§9.
type WebhookDispatcher struct {
	store    *db.Store
	client   *http.Client
	id       string // locked_by — identifies this dispatcher instance
	interval time.Duration
	batch    int
	pool     int
	lockFor  time.Duration
	stop     chan struct{}
	stopped  chan struct{}
}

const (
	webhookMaxAttempts    = 12 // retry budget before dead-letter (~a few hours)
	webhookConnectTimeout = 10 * time.Second
	webhookSendTimeout    = 15 * time.Second
	webhookLockFor        = 2 * time.Minute
	webhookErrCap         = 400 // max chars stored in deliveries.error
)

// webhookBackoff is the retry schedule, indexed by (retry_count-1); capped at
// the last entry. Mirrors the documented 10s/30s/60s/5m/15m.
var webhookBackoff = []time.Duration{
	10 * time.Second, 30 * time.Second, 60 * time.Second, 5 * time.Minute, 15 * time.Minute,
}

func backoffFor(retryCount int) time.Duration {
	idx := retryCount - 1
	if idx < 0 {
		idx = 0
	}
	if idx >= len(webhookBackoff) {
		idx = len(webhookBackoff) - 1
	}
	return webhookBackoff[idx]
}

// NewWebhookDispatcher builds a dispatcher. instanceID identifies the lock owner
// (use the cell id / hostname).
func NewWebhookDispatcher(store *db.Store, instanceID string) *WebhookDispatcher {
	if instanceID == "" {
		instanceID = "webhook-dispatcher"
	}
	return &WebhookDispatcher{
		store:    store,
		client:   webhook.SafeClient(webhookConnectTimeout, webhookSendTimeout),
		id:       instanceID,
		interval: 1 * time.Second,
		batch:    20,
		pool:     8,
		lockFor:  webhookLockFor,
		stop:     make(chan struct{}),
		stopped:  make(chan struct{}),
	}
}

func (d *WebhookDispatcher) Start() { go d.loop() }

func (d *WebhookDispatcher) Stop() {
	close(d.stop)
	<-d.stopped
}

func (d *WebhookDispatcher) loop() {
	defer close(d.stopped)
	tick := time.NewTicker(d.interval)
	defer tick.Stop()
	reconcile := time.NewTicker(30 * time.Second)
	defer reconcile.Stop()
	for {
		select {
		case <-d.stop:
			return
		case <-tick.C:
			d.runSafe(d.dispatch)
		case <-reconcile.C:
			d.runSafe(d.reconcile)
		}
	}
}

func (d *WebhookDispatcher) runSafe(fn func()) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("webhook_dispatcher: recovered from panic: %v", r)
		}
	}()
	fn()
}

// dispatch claims and sends due deliveries until the queue is drained for now.
func (d *WebhookDispatcher) dispatch() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	for {
		claims, err := d.store.ClaimDueDeliveries(ctx, d.id, d.batch, d.lockFor)
		if err != nil {
			log.Printf("webhook_dispatcher: claim: %v", err)
			return
		}
		if len(claims) == 0 {
			return
		}
		sem := make(chan struct{}, d.pool)
		var wg sync.WaitGroup
		for _, dd := range claims {
			wg.Add(1)
			sem <- struct{}{}
			go func(dd db.DueDelivery) {
				defer wg.Done()
				defer func() { <-sem }()
				d.runSafe(func() { d.sendOne(ctx, dd) })
			}(dd)
		}
		wg.Wait()
		if len(claims) < d.batch {
			return
		}
	}
}

func (d *WebhookDispatcher) reconcile() {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	n, err := d.store.ReclaimStaleDeliveries(ctx)
	if err != nil {
		log.Printf("webhook_dispatcher: reclaim: %v", err)
		return
	}
	if n > 0 {
		log.Printf("webhook_dispatcher: reclaimed %d stale delivering row(s)", n)
	}
}

func (d *WebhookDispatcher) sendOne(ctx context.Context, dd db.DueDelivery) {
	sandboxID := extractSandboxID(dd.Payload)
	headers := webhook.Headers(dd.Secret, dd.ID, sandboxID, time.Now().Unix(), dd.Payload)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, dd.URL, bytes.NewReader(dd.Payload))
	if err != nil {
		d.recordTerminal(ctx, dd, nil, "invalid url: "+err.Error())
		return
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	resp, err := d.client.Do(req)
	if err != nil {
		// A blocked address (SSRF) is permanent; transport/timeout is retryable.
		if webhook.IsSSRFError(err) {
			d.recordTerminal(ctx, dd, nil, "blocked: "+err.Error())
			return
		}
		d.recordRetryable(ctx, dd, nil, 0, err.Error())
		return
	}
	defer resp.Body.Close()
	snippet := readSnippet(resp.Body)
	code := resp.StatusCode
	switch {
	case code >= 200 && code < 300:
		if _, err := d.store.RecordDeliveryResult(ctx, dd.ID, dd.LockedBy, db.DeliveryResult{
			Status: "delivered", ResponseCode: &code,
		}); err != nil {
			log.Printf("webhook_dispatcher: record delivered %s: %v", dd.ID, err)
		}
	case code == http.StatusTooManyRequests:
		d.recordRetryable(ctx, dd, &code, parseRetryAfter(resp.Header.Get("Retry-After")), "429 rate limited"+snippet)
	case code >= 500:
		d.recordRetryable(ctx, dd, &code, 0, fmt.Sprintf("server error %d%s", code, snippet))
	default: // 3xx (redirects not followed) and 4xx (non-429) are permanent
		d.recordTerminalCode(ctx, dd, &code, fmt.Sprintf("non-retryable response %d%s", code, snippet))
	}
}

// recordRetryable schedules a retry, or dead-letters if the budget is spent.
func (d *WebhookDispatcher) recordRetryable(ctx context.Context, dd db.DueDelivery, code *int, retryAfter time.Duration, msg string) {
	if dd.RetryCount >= webhookMaxAttempts {
		d.recordTerminalCode(ctx, dd, code, "retry budget exhausted: "+msg)
		return
	}
	wait := backoffFor(dd.RetryCount)
	if retryAfter > wait {
		wait = retryAfter
	}
	next := time.Now().Add(wait)
	e := capErr(msg)
	if _, err := d.store.RecordDeliveryResult(ctx, dd.ID, dd.LockedBy, db.DeliveryResult{
		Status: "failed", ResponseCode: code, Error: &e, NextAttemptAt: &next,
	}); err != nil {
		log.Printf("webhook_dispatcher: record failed %s: %v", dd.ID, err)
	}
}

func (d *WebhookDispatcher) recordTerminal(ctx context.Context, dd db.DueDelivery, code *int, msg string) {
	d.recordTerminalCode(ctx, dd, code, msg)
}

func (d *WebhookDispatcher) recordTerminalCode(ctx context.Context, dd db.DueDelivery, code *int, msg string) {
	e := capErr(msg)
	if _, err := d.store.RecordDeliveryResult(ctx, dd.ID, dd.LockedBy, db.DeliveryResult{
		Status: "dead_letter", ResponseCode: code, Error: &e,
	}); err != nil {
		log.Printf("webhook_dispatcher: record dead_letter %s: %v", dd.ID, err)
	}
}

// extractSandboxID pulls sandboxId out of the rendered envelope for the
// X-OC-Sandbox-ID header (the field is always present on lifecycle envelopes).
func extractSandboxID(payload []byte) string {
	var env struct {
		SandboxID string `json:"sandboxId"`
	}
	_ = json.Unmarshal(payload, &env)
	return env.SandboxID
}

func readSnippet(body io.Reader) string {
	b, _ := io.ReadAll(io.LimitReader(body, 64*1024))
	if len(b) == 0 {
		return ""
	}
	s := string(b)
	if len(s) > 200 {
		s = s[:200]
	}
	return ": " + s
}

func parseRetryAfter(h string) time.Duration {
	if h == "" {
		return 0
	}
	if secs, err := strconv.Atoi(h); err == nil && secs > 0 {
		return time.Duration(secs) * time.Second
	}
	if t, err := http.ParseTime(h); err == nil {
		if d := time.Until(t); d > 0 {
			return d
		}
	}
	return 0
}

func capErr(s string) string {
	if len(s) > webhookErrCap {
		return s[:webhookErrCap]
	}
	return s
}
