package worker

import (
	"context"
	"fmt"
	"io"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/opensandbox/opensandbox/internal/blobstore"
	"github.com/opensandbox/opensandbox/internal/sandbox"
	"github.com/opensandbox/opensandbox/internal/storage"
)

// fakeManager satisfies sandbox.Manager by embedding the interface (all methods
// present as nil-panic stubs) and overriding only DataDir, the one method
// downloadFullCheckpoint touches. Calling any other method would panic — the
// tests never do.
type fakeManager struct {
	sandbox.Manager
	dataDir string
}

func (m *fakeManager) DataDir() string { return m.dataDir }

// blockingBlob is a blobstore.Store whose Get blocks on a release channel after
// recording that it ran. It lets a test freeze every in-flight download at once
// and measure how many actually started for a given key. Get returns an error
// after unblocking so downloadFullCheckpoint short-circuits before tar/extract —
// the tests assert on how many Gets ran, not on a successful extract.
type blockingBlob struct {
	release chan struct{}

	mu       sync.Mutex
	getCount map[string]int // per-key number of Get invocations

	inflight    int32 // Gets currently blocked in release
	maxInflight int32 // high-water mark of inflight
}

func newBlockingBlob() *blockingBlob {
	return &blockingBlob{release: make(chan struct{}), getCount: map[string]int{}}
}

func (b *blockingBlob) Get(ctx context.Context, bucket, key string) (io.ReadCloser, error) {
	b.mu.Lock()
	b.getCount[key]++
	b.mu.Unlock()

	n := atomic.AddInt32(&b.inflight, 1)
	for {
		m := atomic.LoadInt32(&b.maxInflight)
		if n <= m || atomic.CompareAndSwapInt32(&b.maxInflight, m, n) {
			break
		}
	}
	<-b.release
	atomic.AddInt32(&b.inflight, -1)
	return nil, fmt.Errorf("blockingBlob: intentional error after counting")
}

func (b *blockingBlob) totalGets() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	total := 0
	for _, c := range b.getCount {
		total += c
	}
	return total
}

// Unused Store methods — stubs.
func (b *blockingBlob) GetRange(ctx context.Context, bucket, key string, off, length int64) (io.ReadCloser, error) {
	return nil, fmt.Errorf("unused")
}
func (b *blockingBlob) Put(ctx context.Context, bucket, key string, body io.Reader, n int64) error {
	return fmt.Errorf("unused")
}
func (b *blockingBlob) Head(ctx context.Context, bucket, key string) (int64, error) {
	return 0, fmt.Errorf("unused")
}
func (b *blockingBlob) Exists(ctx context.Context, bucket, key string) (bool, error) {
	return false, nil
}
func (b *blockingBlob) Delete(ctx context.Context, bucket, key string) error { return nil }
func (b *blockingBlob) Name() string                                         { return "blocking" }

func waitFor(t *testing.T, cond func() bool, timeout time.Duration, msg string) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for: %s", msg)
}

func newTestServer(t *testing.T, blob blobstore.Store) *GRPCServer {
	t.Helper()
	return &GRPCServer{
		manager:         &fakeManager{dataDir: t.TempDir()},
		checkpointStore: storage.NewCheckpointStoreFromStore(blob, "test-bucket"),
	}
}

// TestEnsureFullCheckpointCached_ConcurrentSameCheckpoint is the regression
// guard for the concurrent-fork race: many forks of the SAME checkpoint that
// all miss the cache must collapse onto a single S3 download+extract. Before
// the singleflight fix each fork ran downloadFullCheckpoint independently,
// clobbering the shared checkpoint-download.tar.zst path — this test would see
// N Gets. With the fix it sees exactly 1.
func TestEnsureFullCheckpointCached_ConcurrentSameCheckpoint(t *testing.T) {
	blob := newBlockingBlob()
	s := newTestServer(t, blob)

	const forks = 8
	var wg sync.WaitGroup
	for i := 0; i < forks; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// All share checkpoint id "cp-1" → must collapse to one download.
			_ = s.ensureFullCheckpointCached(context.Background(), "cp-1", "s3/key/cp-1")
		}()
	}

	// Wait until the singleflight leader is blocked inside Get, then give the
	// followers a beat to pile onto the same flight while the key is held. The
	// leader can't release the key until we close(release), so any follower that
	// reaches Do in this window joins the leader instead of starting a 2nd Get.
	waitFor(t, func() bool { return atomic.LoadInt32(&blob.inflight) >= 1 }, 2*time.Second, "leader Get to start")
	time.Sleep(100 * time.Millisecond)
	close(blob.release)
	wg.Wait()

	if got := blob.totalGets(); got != 1 {
		t.Fatalf("expected exactly 1 download for %d concurrent same-checkpoint forks, got %d", forks, got)
	}
	// Get is keyed by the S3 key that the single collapsed download fetched.
	if got := blob.getCount["s3/key/cp-1"]; got != 1 {
		t.Fatalf("expected 1 Get for the cp-1 S3 key, got %d", got)
	}
}

// TestEnsureFullCheckpointCached_DistinctCheckpointsNotSerialized proves the
// singleflight is keyed by checkpoint id, not global: forks of DIFFERENT
// checkpoints must run concurrently, not queue behind one another. If the key
// were wrong (e.g. constant), only one Get would run and inflight would never
// reach N — the wait below would time out.
func TestEnsureFullCheckpointCached_DistinctCheckpointsNotSerialized(t *testing.T) {
	blob := newBlockingBlob()
	s := newTestServer(t, blob)

	const distinct = 5
	var wg sync.WaitGroup
	for i := 0; i < distinct; i++ {
		id := fmt.Sprintf("cp-%d", i)
		wg.Add(1)
		go func() {
			defer wg.Done()
			_ = s.ensureFullCheckpointCached(context.Background(), id, "s3/key/"+id)
		}()
	}

	// All distinct checkpoints should be in Get simultaneously.
	waitFor(t, func() bool { return atomic.LoadInt32(&blob.inflight) == distinct },
		2*time.Second, "all distinct checkpoints to download concurrently")
	close(blob.release)
	wg.Wait()

	if got := int(blob.maxInflight); got != distinct {
		t.Fatalf("expected %d concurrent downloads for distinct checkpoints, got max %d", distinct, got)
	}
	if got := blob.totalGets(); got != distinct {
		t.Fatalf("expected %d total downloads, got %d", distinct, got)
	}
}
