package worker

import (
	"os"
	"testing"
)

// diskPercent must measure the filesystem containing the given path (the data
// mount), NOT a hardcoded "/". This guards against regressing to the old
// behavior that keyed disk pressure off the OS root's static install footprint.
func TestDiskPercent_MeasuresGivenPath(t *testing.T) {
	// A real, existing path resolves to its filesystem and yields a sane %.
	dir := os.TempDir()
	pct := diskPercent(dir)
	if pct <= 0 || pct > 100 {
		t.Fatalf("diskPercent(%q) = %.2f, want in (0,100]", dir, pct)
	}
}

// A non-existent path can't be statfs'd — return 0 rather than panicking or
// falling back to another filesystem.
func TestDiskPercent_BadPathZero(t *testing.T) {
	if pct := diskPercent("/no/such/path/xyzzy-does-not-exist"); pct != 0 {
		t.Fatalf("diskPercent(bad) = %.2f, want 0", pct)
	}
}

// SystemStats threads the data dir through to the disk metric.
func TestSystemStats_UsesDataDir(t *testing.T) {
	_, _, disk := SystemStats(os.TempDir())
	if disk <= 0 || disk > 100 {
		t.Fatalf("SystemStats disk = %.2f, want in (0,100]", disk)
	}
	// A bad data dir yields 0 disk (never a stale root-fs reading).
	if _, _, disk := SystemStats("/no/such/path/xyzzy"); disk != 0 {
		t.Fatalf("SystemStats(bad) disk = %.2f, want 0", disk)
	}
}
