package autumn

import "testing"

func TestFeatureForMemoryMB(t *testing.T) {
	cases := map[int]string{
		1024:  "compute_1gb",
		4096:  "compute_4gb",
		8192:  "compute_8gb",
		16384: "compute_16gb",
		32768: "compute_32gb",
		65536: "compute_64gb",
	}
	for mb, want := range cases {
		if got, ok := FeatureForMemoryMB(mb); !ok || got != want {
			t.Errorf("FeatureForMemoryMB(%d) = (%q,%v), want (%q,true)", mb, got, ok, want)
		}
	}
	if got, ok := FeatureForMemoryMB(2048); ok {
		t.Errorf("FeatureForMemoryMB(2048) = (%q,true), want unknown", got)
	}
}

func TestUsageIdempotencyKey(t *testing.T) {
	// Stable across calls (retry-safe) and namespaced by org+bucket+feature so
	// it's globally unique under Autumn's bare-key dedupe.
	a := UsageIdempotencyKey("org-1", 1000, "compute_8gb")
	if a != "usage:org-1:1000:compute_8gb" {
		t.Fatalf("unexpected key %q", a)
	}
	if UsageIdempotencyKey("org-1", 1000, "compute_8gb") != a {
		t.Fatal("key not deterministic")
	}
	// Any axis change must produce a distinct key.
	for _, other := range []string{
		UsageIdempotencyKey("org-2", 1000, "compute_8gb"),
		UsageIdempotencyKey("org-1", 1001, "compute_8gb"),
		UsageIdempotencyKey("org-1", 1000, "compute_4gb"),
	} {
		if other == a {
			t.Fatalf("key collision: %q", other)
		}
	}
}
