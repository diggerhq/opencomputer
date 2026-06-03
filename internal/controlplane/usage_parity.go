package controlplane

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/opensandbox/opensandbox/internal/db"
)

// UsageParityChecker is the Pro-tier shadow-parity gate for the billing
// cutover. Every period it picks the most-recently-settled hour bucket and
// compares, per org, the GB-seconds the EDGE measured (from tick samples, via
// the api-edge /internal/usage-parity endpoint) against the GB-seconds the
// CELL measured (from authoritative sandbox_scale_events). It only logs/alerts
// drift — it never changes billing. This is the evidence that lets an operator
// flip the edge rollup cron from shadow to live (runbook: parity clean 24h+).
//
// GB-seconds is the comparison metric because it's billing_mode-independent:
// legacy (per-tier) and unified (flat) both reduce to the same compute-seconds,
// so one scalar validates both. It compares raw measurement sources (ticks vs
// intervals) on purpose — pricing is preserved by design, so measurement is the
// risky part of the cutover.
//
// Expected, benign drift sources (don't alarm on these alone):
//   - ±1 tick interval (≤20s) per sandbox lifetime: sampling vs exact wall-time.
//   - Managed-agent sandboxes: the cell EXCLUDES sandboxes under an active
//     agent_subscription from GetOrgUsage (the sub covers compute), but the
//     worker's usage ticker currently emits ticks for them. So orgs with
//     managed agents will show edge > cell. That's a real edge-side gap to
//     close later (the edge has no agent-subscription awareness yet) — the
//     checker surfaces it rather than hiding it.
type UsageParityChecker struct {
	store     usageParitySource
	parityURL string // full api-edge /internal/usage-parity URL
	path      string // parsed path of parityURL, for the HMAC (path+query)
	secret    string // shared HMAC secret with the edge (EVENT_SECRET)

	period    time.Duration
	grace     time.Duration // wait this long past a bucket's end before checking
	tolerance float64       // fractional drift to tolerate before flagging (e.g. 0.02)

	client *http.Client
	stopCh chan struct{}
	doneCh chan struct{}
}

// usageParitySource is the slice of *db.Store the checker needs (interface for
// testability).
type usageParitySource interface {
	GetOrgUsage(ctx context.Context, orgID string, from, to time.Time) ([]db.OrgUsageSummary, error)
	ListOrgIDsWithScaleEvents(ctx context.Context, from, to time.Time) ([]string, error)
}

// UsageParityConfig configures the checker. ParityURL empty => disabled.
type UsageParityConfig struct {
	Store     usageParitySource
	ParityURL string
	Secret    string
	Period    time.Duration // default 1h (one closed bucket per run)
	Grace     time.Duration // default 10m, must match the rollup cron's GRACE_SECONDS
	Tolerance float64       // default 0.02 (2%)
}

// NewUsageParityChecker returns nil if ParityURL/Secret/Store are unset.
func NewUsageParityChecker(cfg UsageParityConfig) *UsageParityChecker {
	if cfg.ParityURL == "" || cfg.Secret == "" || cfg.Store == nil {
		return nil
	}
	u, err := url.Parse(cfg.ParityURL)
	if err != nil {
		log.Printf("usage_parity: bad ParityURL %q: %v — disabled", cfg.ParityURL, err)
		return nil
	}
	if cfg.Period <= 0 {
		cfg.Period = time.Hour
	}
	if cfg.Grace <= 0 {
		cfg.Grace = 10 * time.Minute
	}
	if cfg.Tolerance <= 0 {
		cfg.Tolerance = 0.02
	}
	return &UsageParityChecker{
		store:     cfg.Store,
		parityURL: cfg.ParityURL,
		path:      u.Path,
		secret:    cfg.Secret,
		period:    cfg.Period,
		grace:     cfg.Grace,
		tolerance: cfg.Tolerance,
		client:    &http.Client{Timeout: 20 * time.Second},
		stopCh:    make(chan struct{}),
		doneCh:    make(chan struct{}),
	}
}

func (c *UsageParityChecker) Start(ctx context.Context) { go c.run(ctx) }

func (c *UsageParityChecker) Stop(ctx context.Context) error {
	close(c.stopCh)
	select {
	case <-c.doneCh:
	case <-ctx.Done():
		return ctx.Err()
	}
	return nil
}

func (c *UsageParityChecker) run(ctx context.Context) {
	defer close(c.doneCh)
	ticker := time.NewTicker(c.period)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-c.stopCh:
			return
		case <-ticker.C:
			c.tickSafe(ctx)
		}
	}
}

func (c *UsageParityChecker) tickSafe(ctx context.Context) {
	defer func() {
		if v := recover(); v != nil {
			log.Printf("usage_parity: recovered from panic: %v", v)
		}
	}()
	tCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	if err := c.tick(tCtx); err != nil {
		log.Printf("usage_parity: tick failed: %v", err)
	}
}

const bucketSeconds = int64(3600)

// tick compares the most-recently-settled hour bucket and logs per-org drift.
func (c *UsageParityChecker) tick(ctx context.Context) error {
	// Most recent fully-settled hour boundary: round (now-grace) down to the hour.
	end := ((time.Now().Unix() - int64(c.grace.Seconds())) / bucketSeconds) * bucketSeconds
	start := end - bucketSeconds
	from := time.Unix(start, 0).UTC()
	to := time.Unix(end, 0).UTC()

	edge, err := c.fetchEdge(ctx, start, end)
	if err != nil {
		return fmt.Errorf("fetch edge: %w", err)
	}

	// Union of org_ids: cell-side (scale events) ∪ edge-side (samples). An org
	// on only one side is a parity failure we want to see.
	cellOrgs, err := c.store.ListOrgIDsWithScaleEvents(ctx, from, to)
	if err != nil {
		return fmt.Errorf("list cell orgs: %w", err)
	}
	union := map[string]struct{}{}
	for _, id := range cellOrgs {
		union[id] = struct{}{}
	}
	for id := range edge {
		union[id] = struct{}{}
	}

	checked, flagged := 0, 0
	var worstPct float64
	var worstOrg string
	for org := range union {
		cellGB, err := c.cellGBSeconds(ctx, org, from, to)
		if err != nil {
			log.Printf("usage_parity: org=%s cell usage: %v", org, err)
			continue
		}
		edgeGB := edge[org]
		checked++
		drift := edgeGB - cellGB
		pct := driftPct(cellGB, edgeGB)
		if math.Abs(pct) > c.tolerance {
			flagged++
			log.Printf("usage_parity: DRIFT org=%s bucket=%s cell=%.3f edge=%.3f gb·s drift=%+.3f (%+.1f%%)",
				org, from.Format(time.RFC3339), cellGB, edgeGB, drift, pct*100)
		}
		if math.Abs(pct) > math.Abs(worstPct) {
			worstPct = pct
			worstOrg = org
		}
	}

	log.Printf("usage_parity: bucket=%s checked=%d flagged=%d (tolerance=%.1f%%) worst=%s (%+.1f%%)",
		from.Format(time.RFC3339), checked, flagged, c.tolerance*100, worstOrg, worstPct*100)
	return nil
}

// cellGBSeconds sums the cell's authoritative GB-seconds for an org over the
// window from sandbox_scale_events (via GetOrgUsage, which already clips to the
// window and excludes agent-subscription sandboxes).
func (c *UsageParityChecker) cellGBSeconds(ctx context.Context, org string, from, to time.Time) (float64, error) {
	rows, err := c.store.GetOrgUsage(ctx, org, from, to)
	if err != nil {
		return 0, err
	}
	var gb float64
	for _, r := range rows {
		gb += (float64(r.MemoryMB) / 1024.0) * r.TotalSeconds
	}
	return gb, nil
}

// driftPct returns the signed fractional difference of edge vs cell. When cell
// is ~0 it returns +1 (100%) if edge has any usage, else 0 — so a one-sided
// org is always flagged rather than dividing by zero.
func driftPct(cell, edge float64) float64 {
	const eps = 1e-6
	if math.Abs(cell) < eps {
		if math.Abs(edge) < eps {
			return 0
		}
		return 1
	}
	return (edge - cell) / cell
}

type usageParityResponse struct {
	Orgs []struct {
		OrgID     string  `json:"org_id"`
		GBSeconds float64 `json:"gb_seconds"`
		Samples   int64   `json:"samples"`
	} `json:"orgs"`
	AsOf int64 `json:"as_of"`
}

// fetchEdge calls the api-edge /internal/usage-parity endpoint and returns a
// map of org_id → edge GB-seconds for the window. Same HMAC scheme as the
// halt_reconciler: sign "{ts}.{path+query}" with the shared EVENT_SECRET.
func (c *UsageParityChecker) fetchEdge(ctx context.Context, fromSec, toSec int64) (map[string]float64, error) {
	q := fmt.Sprintf("from=%d&to=%d", fromSec, toSec)
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	sig := signGet(c.secret, ts, c.path+"?"+q)

	req, err := http.NewRequestWithContext(ctx, "GET", c.parityURL+"?"+q, nil)
	if err != nil {
		return nil, fmt.Errorf("build request: %w", err)
	}
	req.Header.Set("X-Timestamp", ts)
	req.Header.Set("X-Signature", sig)

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("status %d: %s", resp.StatusCode, string(body))
	}
	var parsed usageParityResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil, fmt.Errorf("decode body: %w", err)
	}
	out := make(map[string]float64, len(parsed.Orgs))
	for _, o := range parsed.Orgs {
		out[o.OrgID] = o.GBSeconds
	}
	return out, nil
}
