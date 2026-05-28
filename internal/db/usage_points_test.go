package db

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// Pure-Go tests for the per-sandbox usage points query. SQL shape and
// validation only — the load-bearing math is exercised by the
// pgfixture suite (build tag `pgfixture`) which runs the query against
// real Postgres and reconciles totals against GetOrgUsage.

func TestBuildSandboxUsagePointsQuery_Shape(t *testing.T) {
	from := time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC)
	to := from.Add(24 * time.Hour)
	sql, args := buildSandboxUsagePointsQuery(uuid.New(), "sbx-1", from, to)

	checks := map[string]string{
		"minute-bucket generate_series":       "generate_series(",
		"date_trunc minute alignment":         "date_trunc('minute',",
		"sub-microsecond upper bound":         "$4::timestamptz - interval '1 microsecond'",
		"samples CTE filter on org":           "WHERE org_id = $1",
		"samples CTE filter on sandbox":       "AND sandbox_id = $2",
		"samples CTE bucket grouping":         "GROUP BY date_trunc('minute', sampled_at)",
		"open-event clamp matches aggregator": "COALESCE(e.ended_at, LEAST(now(), $4::timestamptz))",
		"upper-bound window clamp":            "b.ts_end, $4::timestamptz",
		"lower-bound window clamp":            "GREATEST(e.started_at, b.ts, $3::timestamptz)",
		"negative-overlap guard":              "GREATEST(EXTRACT(EPOCH FROM (",
		"scale-event filter org-scoped":       "e.org_id    = $1",
		"scale-event filter sandbox-scoped":   "e.sandbox_id = $2",
		"weighted memory_mb computation":      "weighted_memory_mb",
		"peak memory_mb computation":          "peak_memory_mb",
		"gb-seconds integration":              "memory_mb::float / 1024.0",
		"used GiB-seconds from memory_bytes":  "memory_bytes_avg::float / 1073741824.0",
		"uptime derived from overlap":         "a.uptime_seconds",
		"ordered by bucket timestamp":         "ORDER BY b.ts",
	}
	for label, frag := range checks {
		if !strings.Contains(sql, frag) {
			t.Errorf("expected SQL to contain %q (%s)\n--- SQL ---\n%s", frag, label, sql)
		}
	}

	// Args order is load-bearing — handler and SQL must agree.
	if len(args) != 4 {
		t.Fatalf("expected 4 args ($1..$4), got %d", len(args))
	}
	if _, ok := args[0].(uuid.UUID); !ok {
		t.Errorf("arg[0] should be uuid.UUID (orgID), got %T", args[0])
	}
	if args[1] != "sbx-1" {
		t.Errorf("arg[1] should be sandbox ID, got %v", args[1])
	}
	if args[2] != from {
		t.Errorf("arg[2] should be `from`, got %v", args[2])
	}
	if args[3] != to {
		t.Errorf("arg[3] should be `to`, got %v", args[3])
	}
}

func TestValidateSandboxUsageWindow(t *testing.T) {
	base := time.Date(2026, 4, 1, 0, 0, 0, 0, time.UTC)
	tests := []struct {
		name    string
		from    time.Time
		to      time.Time
		wantErr string
	}{
		{
			name: "ok 1h window",
			from: base, to: base.Add(time.Hour),
		},
		{
			name: "ok exactly 30d",
			from: base, to: base.Add(30 * 24 * time.Hour),
		},
		{
			name:    "to equals from",
			from:    base,
			to:      base,
			wantErr: "`to` must be after `from`",
		},
		{
			name:    "to before from",
			from:    base.Add(time.Hour),
			to:      base,
			wantErr: "`to` must be after `from`",
		},
		{
			name:    "window > 30d",
			from:    base,
			to:      base.Add(30*24*time.Hour + time.Second),
			wantErr: "query window must be <= 30 days",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateSandboxUsageWindow(tt.from, tt.to)
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("expected error %q, got nil", tt.wantErr)
			}
			if !strings.Contains(err.Error(), tt.wantErr) {
				t.Errorf("expected error containing %q, got %q", tt.wantErr, err.Error())
			}
		})
	}
}
