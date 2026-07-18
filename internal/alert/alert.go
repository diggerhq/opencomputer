// Package alert delivers operational alerts to an external sink (currently a
// Slack incoming webhook). It is deliberately tiny and dependency-free so any
// producer — the scaler's roll-health monitor today, reconcilers or CI-driven
// pings later — can fire alerts through one call site:
//
//	alerter.Send(ctx, alert.Alert{Severity: alert.Critical, Title: "...", Detail: "...", DedupKey: "..."})
//
// A Slack sink is used when a webhook URL is configured; otherwise Send is a
// no-op, so callers never have to nil-check and dev/local stays quiet.
package alert

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"
)

// Severity ranks an alert. Slack shows all; a future PagerDuty sink can gate
// paging on Critical without changing any producer.
type Severity int

const (
	Info Severity = iota
	Warning
	Critical
)

func (s Severity) String() string {
	switch s {
	case Critical:
		return "critical"
	case Warning:
		return "warning"
	default:
		return "info"
	}
}

func (s Severity) emoji() string {
	switch s {
	case Critical:
		return ":rotating_light:"
	case Warning:
		return ":warning:"
	default:
		return ":information_source:"
	}
}

// Alert is one operational notification.
type Alert struct {
	Severity Severity
	Title    string
	Detail   string
	// DedupKey collapses repeats for the same underlying condition: an alert
	// with a non-empty key won't re-fire within the sink's cooldown window.
	// Empty = always send (use for one-shot events).
	DedupKey string
}

// Alerter delivers alerts. Implementations are safe for concurrent use and
// never block the caller on delivery failure (they log and move on).
type Alerter interface {
	Send(ctx context.Context, a Alert)
}

// Nop drops all alerts. Returned by New when no sink is configured.
type Nop struct{}

// Send implements Alerter.
func (Nop) Send(context.Context, Alert) {}

// DefaultCooldown is how long a given DedupKey is suppressed after firing, so a
// persistent condition re-pings periodically rather than every tick.
const DefaultCooldown = 30 * time.Minute

// New returns a Slack-webhook Alerter when webhookURL is set, otherwise a Nop.
// envLabel (e.g. "prod-eastus2") is prefixed to every message so a shared
// channel can tell clusters apart.
func New(webhookURL, envLabel string) Alerter {
	if webhookURL == "" {
		return Nop{}
	}
	return &slackAlerter{
		url:      webhookURL,
		env:      envLabel,
		client:   &http.Client{Timeout: 10 * time.Second},
		cooldown: DefaultCooldown,
		lastSent: map[string]time.Time{},
		now:      time.Now,
	}
}

type slackAlerter struct {
	url      string
	env      string
	client   *http.Client
	cooldown time.Duration

	mu       sync.Mutex
	lastSent map[string]time.Time
	now      func() time.Time // injectable for tests
}

// Send posts to the Slack webhook, honoring the per-DedupKey cooldown. Delivery
// errors are logged, never returned — alerting must not break the caller.
func (s *slackAlerter) Send(ctx context.Context, a Alert) {
	if a.DedupKey != "" && !s.allow(a.DedupKey) {
		return
	}
	title := a.Title
	if s.env != "" {
		title = "[" + s.env + "] " + title
	}
	text := fmt.Sprintf("%s *%s*", a.Severity.emoji(), title)
	if a.Detail != "" {
		text += "\n" + a.Detail
	}
	body, _ := json.Marshal(map[string]string{"text": text})

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.url, bytes.NewReader(body))
	if err != nil {
		log.Printf("alert: build request: %v", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		log.Printf("alert: slack post failed: %v", err)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		log.Printf("alert: slack returned status %d", resp.StatusCode)
	}
}

// allow reports whether key may fire now (outside its cooldown) and records the
// send. The first call for a key always allows.
func (s *slackAlerter) allow(key string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	if last, ok := s.lastSent[key]; ok && now.Sub(last) < s.cooldown {
		return false
	}
	s.lastSent[key] = now
	return true
}
