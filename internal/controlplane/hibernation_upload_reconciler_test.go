package controlplane

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/opensandbox/opensandbox/internal/db"
)

// --- Mocks ---

type fakeHibStore struct {
	stuck    []db.StuckHibernationUpload
	uploaded map[string]int64  // key -> size recorded via MarkHibernationUploaded
	failed   map[string]string // key -> errMsg recorded via MarkHibernationUploadFailed
	listErr  error
	markErr  error
}

func newFakeHibStore(stuck ...db.StuckHibernationUpload) *fakeHibStore {
	return &fakeHibStore{stuck: stuck, uploaded: map[string]int64{}, failed: map[string]string{}}
}

func (f *fakeHibStore) ListStuckHibernationUploads(_ context.Context, _ time.Time, _ int) ([]db.StuckHibernationUpload, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	return f.stuck, nil
}

func (f *fakeHibStore) MarkHibernationUploaded(_ context.Context, key string, size int64) error {
	if f.markErr != nil {
		return f.markErr
	}
	f.uploaded[key] = size
	return nil
}

func (f *fakeHibStore) MarkHibernationUploadFailed(_ context.Context, key, msg string) error {
	if f.markErr != nil {
		return f.markErr
	}
	f.failed[key] = msg
	return nil
}

type fakeBlobStat struct {
	present map[string]int64 // key -> size (blob exists)
	statErr map[string]error // key -> transient stat error
}

func (f *fakeBlobStat) Stat(_ context.Context, key string) (int64, bool, error) {
	if e := f.statErr[key]; e != nil {
		return 0, false, e
	}
	if sz, ok := f.present[key]; ok {
		return sz, true, nil
	}
	return 0, false, nil
}

func stuckRow(key string) db.StuckHibernationUpload {
	return db.StuckHibernationUpload{SandboxID: "sb-" + key, HibernationKey: "checkpoints/sb-" + key + "/1.tar.zst", HibernatedAt: time.Unix(1, 0)}
}

func newRec(store hibUploadReconcilerStore, blobs hibUploadBlobStat) *HibernationUploadReconciler {
	return NewHibernationUploadReconciler(HibernationUploadReconcilerConfig{Store: store, Blobs: blobs})
}

// --- Tests ---

// Blob present -> the lost write is recovered by stamping uploaded_at with the real size.
func TestHibReconciler_RecoversWhenBlobPresent(t *testing.T) {
	row := stuckRow("aaa")
	store := newFakeHibStore(row)
	blobs := &fakeBlobStat{present: map[string]int64{row.HibernationKey: 4096}}

	newRec(store, blobs).tick(context.Background())

	if got, ok := store.uploaded[row.HibernationKey]; !ok || got != 4096 {
		t.Fatalf("expected MarkHibernationUploaded(%s, 4096), got size=%d ok=%v", row.HibernationKey, got, ok)
	}
	if _, ok := store.failed[row.HibernationKey]; ok {
		t.Fatalf("a present blob must not be marked failed")
	}
}

// Blob absent after the grace window -> record the loss so the drain proceeds.
func TestHibReconciler_MarksFailedWhenBlobAbsent(t *testing.T) {
	row := stuckRow("bbb")
	store := newFakeHibStore(row)
	blobs := &fakeBlobStat{} // nothing present

	newRec(store, blobs).tick(context.Background())

	if msg, ok := store.failed[row.HibernationKey]; !ok || msg == "" {
		t.Fatalf("expected MarkHibernationUploadFailed for absent blob, ok=%v msg=%q", ok, msg)
	}
	if _, ok := store.uploaded[row.HibernationKey]; ok {
		t.Fatalf("an absent blob must not be marked uploaded")
	}
}

// A transient Stat error must leave the row untouched for the next tick — never
// mark a row failed just because S3 hiccuped (that would strand a recoverable box).
func TestHibReconciler_LeavesRowOnStatError(t *testing.T) {
	row := stuckRow("ccc")
	store := newFakeHibStore(row)
	blobs := &fakeBlobStat{statErr: map[string]error{row.HibernationKey: errors.New("s3 timeout")}}

	newRec(store, blobs).tick(context.Background())

	if _, ok := store.uploaded[row.HibernationKey]; ok {
		t.Fatalf("stat error must not mark uploaded")
	}
	if _, ok := store.failed[row.HibernationKey]; ok {
		t.Fatalf("stat error must not mark failed — row is left for retry")
	}
}

// A mixed batch routes each row independently: present->uploaded, absent->failed,
// error->untouched.
func TestHibReconciler_MixedBatch(t *testing.T) {
	ok, gone, flaky := stuckRow("ok"), stuckRow("gone"), stuckRow("flaky")
	store := newFakeHibStore(ok, gone, flaky)
	blobs := &fakeBlobStat{
		present: map[string]int64{ok.HibernationKey: 123},
		statErr: map[string]error{flaky.HibernationKey: errors.New("net")},
	}

	newRec(store, blobs).tick(context.Background())

	if store.uploaded[ok.HibernationKey] != 123 {
		t.Errorf("present row not recovered: %v", store.uploaded)
	}
	if _, ok := store.failed[gone.HibernationKey]; !ok {
		t.Errorf("absent row not marked failed: %v", store.failed)
	}
	if _, up := store.uploaded[flaky.HibernationKey]; up {
		t.Errorf("flaky row should be untouched")
	}
	if _, fl := store.failed[flaky.HibernationKey]; fl {
		t.Errorf("flaky row should be untouched")
	}
}

// Empty stuck list is a clean no-op (no store writes).
func TestHibReconciler_EmptyListNoOp(t *testing.T) {
	store := newFakeHibStore()
	newRec(store, &fakeBlobStat{}).tick(context.Background())
	if len(store.uploaded)+len(store.failed) != 0 {
		t.Fatalf("empty list must not write to store")
	}
}

// A list error is swallowed (logged) — the tick returns without touching the store.
func TestHibReconciler_ListErrorNoOp(t *testing.T) {
	store := newFakeHibStore(stuckRow("x"))
	store.listErr = errors.New("db down")
	newRec(store, &fakeBlobStat{}).tick(context.Background())
	if len(store.uploaded)+len(store.failed) != 0 {
		t.Fatalf("list error must not write to store")
	}
}

// Constructor returns nil when a dependency is missing, so callers can Start() it
// unconditionally (nil receiver is a no-op).
func TestHibReconciler_NilWhenDepsMissing(t *testing.T) {
	if NewHibernationUploadReconciler(HibernationUploadReconcilerConfig{Blobs: &fakeBlobStat{}}) != nil {
		t.Error("expected nil reconciler when Store is nil")
	}
	if NewHibernationUploadReconciler(HibernationUploadReconcilerConfig{Store: newFakeHibStore()}) != nil {
		t.Error("expected nil reconciler when Blobs is nil")
	}
	// nil receiver Start/Stop must not panic.
	var r *HibernationUploadReconciler
	r.Start(context.Background())
	if err := r.Stop(context.Background()); err != nil {
		t.Errorf("nil Stop returned %v", err)
	}
}
