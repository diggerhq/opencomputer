package sandbox

import (
	"testing"
	"time"
)

// TestGenerationStableAcrossReopens verifies that re-opening the same SQLite
// file returns the same generation. Required for retry-dedup of envelope IDs
// during the XADD-succeeded-but-MarkSynced-failed window.
func TestGenerationStableAcrossReopens(t *testing.T) {
	dir := t.TempDir()

	first, err := OpenSandboxDB(dir, "sb-test")
	if err != nil {
		t.Fatalf("first open: %v", err)
	}
	gen1 := first.Generation()
	if gen1 == 0 {
		t.Fatalf("generation should be non-zero on first open")
	}
	first.Close()

	second, err := OpenSandboxDB(dir, "sb-test")
	if err != nil {
		t.Fatalf("re-open: %v", err)
	}
	defer second.Close()

	if got := second.Generation(); got != gen1 {
		t.Fatalf("generation must be stable across reopens; first=%d second=%d", gen1, got)
	}
}

// TestGenerationChangesAfterRemove pins the fix for the post-wake event-loss
// bug. Hibernate calls SandboxDBManager.Remove which deletes the SQLite file;
// wake calls Get which recreates it. Without a per-DB generation, the fresh
// AUTOINCREMENT would produce envelope IDs that collide with pre-hibernate
// IDs and get silently dropped by events-ingest's ON CONFLICT(id) DO NOTHING.
// A different generation post-Remove is what breaks that collision.
func TestGenerationChangesAfterRemove(t *testing.T) {
	mgr := NewSandboxDBManager(t.TempDir())

	db1, err := mgr.Get("sb-test")
	if err != nil {
		t.Fatalf("first Get: %v", err)
	}
	gen1 := db1.Generation()

	// Sleep a hair so UnixNano differs even on coarse-resolution clocks.
	time.Sleep(time.Millisecond)

	if err := mgr.Remove("sb-test"); err != nil {
		t.Fatalf("Remove: %v", err)
	}

	db2, err := mgr.Get("sb-test")
	if err != nil {
		t.Fatalf("post-Remove Get: %v", err)
	}
	if gen2 := db2.Generation(); gen2 == gen1 {
		t.Fatalf("generation must differ after Remove+Get (post-wake collision regression): both = %d", gen1)
	}
}

// TestGetAllUnsyncedEventsFlatCarriesGeneration verifies the publisher path
// receives the generation it needs to build the namespaced envelope ID.
func TestGetAllUnsyncedEventsFlatCarriesGeneration(t *testing.T) {
	mgr := NewSandboxDBManager(t.TempDir())
	db, err := mgr.Get("sb-test")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if err := db.LogEvent("usage_tick", map[string]string{"sandbox_id": "sb-test"}); err != nil {
		t.Fatalf("LogEvent: %v", err)
	}

	flat, err := mgr.GetAllUnsyncedEventsFlat(10)
	if err != nil {
		t.Fatalf("GetAllUnsyncedEventsFlat: %v", err)
	}
	if len(flat) != 1 {
		t.Fatalf("want 1 event, got %d", len(flat))
	}
	if flat[0].Generation != db.Generation() {
		t.Fatalf("flat.Generation=%d, want %d", flat[0].Generation, db.Generation())
	}
	if flat[0].Generation == 0 {
		t.Fatalf("Generation should be non-zero")
	}
}
