package api

import (
	"strings"
	"testing"
	"time"
)

func TestParseUsageTimestamp(t *testing.T) {
	tests := []struct {
		name    string
		in      string
		want    time.Time
		wantErr string
	}{
		{
			name: "RFC3339 with Z",
			in:   "2026-05-27T15:30:00Z",
			want: time.Date(2026, 5, 27, 15, 30, 0, 0, time.UTC),
		},
		{
			name: "RFC3339 with offset",
			in:   "2026-05-27T15:30:00+02:00",
			want: time.Date(2026, 5, 27, 13, 30, 0, 0, time.UTC),
		},
		{
			name: "date only — UTC midnight",
			in:   "2026-05-27",
			want: time.Date(2026, 5, 27, 0, 0, 0, 0, time.UTC),
		},
		{
			name:    "date + time without timezone — rejected",
			in:      "2026-05-27T15:30:00",
			wantErr: "must be an ISO date",
		},
		{
			name:    "free-form string",
			in:      "yesterday",
			wantErr: "must be an ISO date",
		},
		{
			name:    "empty string",
			in:      "",
			wantErr: "must be an ISO date",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseUsageTimestamp(tt.in)
			if tt.wantErr != "" {
				if err == nil {
					t.Fatalf("expected error containing %q, got nil", tt.wantErr)
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Errorf("error = %q, want substring %q", err.Error(), tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !got.Equal(tt.want) {
				t.Errorf("got %v, want %v", got, tt.want)
			}
		})
	}
}
