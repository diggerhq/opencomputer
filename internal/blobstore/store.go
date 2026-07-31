// Package blobstore is the abstraction over the global object store that
// holds canonical golden rootfs blobs, template blobs, and the events
// archive.
//
// We currently use Tigris (Region Earth — automatic global replication),
// but every implementation talks S3-compatible APIs, so swapping providers
// (R2, AWS S3, Azure Blob via S3 compat, GCS via interop, MinIO) is a
// config change — point at a different endpoint, supply different
// credentials. Multi-backend failover composes Stores via FallbackStore.
//
// The package is intentionally small: just enough surface for downloading
// goldens on cache miss, uploading from CI/Packer, and archiving events.
// Anything richer (presigned URLs, multipart uploads >5GB, server-side
// copy) belongs in a higher layer if/when we need it.
package blobstore

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"time"
)

// ErrNotFound is returned by Get/Exists/Download when the object doesn't
// exist. Distinguishable from transient errors so callers can fall back
// to other behaviors (rebuild locally, try a different store, etc.).
var ErrNotFound = errors.New("blobstore: object not found")

// Store is the abstract interface every backend implements.
//
// Implementations should be safe for concurrent use — a single Store is
// typically shared across goroutines (worker pool, async upload, etc.).
type Store interface {
	// Get streams the object at key from bucket. Caller closes the reader.
	// Returns ErrNotFound if the object isn't present.
	Get(ctx context.Context, bucket, key string) (io.ReadCloser, error)

	// GetRange streams a byte range of the object. Used for parallel
	// chunked downloads of large objects (e.g. checkpoint archives).
	// Returns ErrNotFound if the object isn't present.
	GetRange(ctx context.Context, bucket, key string, offset, length int64) (io.ReadCloser, error)

	// Put writes body of length contentLength bytes to bucket/key.
	// Streams from the reader — no in-memory buffering of the full body.
	Put(ctx context.Context, bucket, key string, body io.Reader, contentLength int64) error

	// Head returns the content length of the object. Distinct from Exists
	// in that callers needing size (e.g. for range planning) avoid a second
	// round trip. Returns ErrNotFound if the object isn't present.
	Head(ctx context.Context, bucket, key string) (int64, error)

	// Exists returns true if the object is present at bucket/key.
	// Returns (false, nil) on NotFound; (false, err) on other errors.
	Exists(ctx context.Context, bucket, key string) (bool, error)

	// Delete removes the object at bucket/key. Returns nil if the object
	// didn't exist (idempotent).
	Delete(ctx context.Context, bucket, key string) error

	// Name returns a short identifier for logging ("tigris", "r2",
	// "azure-blob"). Never empty.
	Name() string
}

// Download is a convenience wrapper that streams an object to a local file
// atomically (writes to dest+".tmp" and renames on success). Most callers
// want this rather than the streaming Get.
func Download(ctx context.Context, s Store, bucket, key, destPath string) error {
	r, err := s.Get(ctx, bucket, key)
	if err != nil {
		return err
	}
	defer r.Close()
	return writeAtomic(destPath, r)
}

// Upload streams a local file to bucket/key, retrying the whole upload on
// transient failure. Multi-GB uploads to S3-compatible stores (Tigris) fail
// intermittently mid-stream (a part reset surfaces as RequestCanceled) or on the
// final CompleteMultipartUpload (the upload id expires / a retried Complete 404s
// as NoSuchUpload) — the per-request SDK retryer can't recover either. Reopening
// the file and starting a fresh multipart upload does. Safe to retry: each write
// is a full-object PUT to a fixed key, so it's idempotent.
func Upload(ctx context.Context, s Store, bucket, key, srcPath string) error {
	const attempts = 4
	var lastErr error
	for i := 0; i < attempts; i++ {
		if i > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(i) * 5 * time.Second):
			}
			log.Printf("blobstore: retry %d/%d uploading %s/%s (prev: %v)", i+1, attempts, bucket, key, lastErr)
		}
		f, length, err := openSized(srcPath)
		if err != nil {
			return err // local file problem — not worth retrying
		}
		err = s.Put(ctx, bucket, key, f, length)
		f.Close()
		if err == nil {
			return nil
		}
		if ctx.Err() != nil {
			return err // caller/deadline canceled — stop spinning
		}
		lastErr = err
	}
	return fmt.Errorf("upload %s/%s failed after %d attempts: %w", bucket, key, attempts, lastErr)
}
