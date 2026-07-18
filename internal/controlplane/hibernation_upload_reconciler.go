package controlplane

import (
	"context"
	"log"
	"sync"
	"time"

	"github.com/opensandbox/opensandbox/internal/db"
)

// hibUploadReconcilerStore is the DB surface the reconciler needs.
type hibUploadReconcilerStore interface {
	ListStuckHibernationUploads(ctx context.Context, olderThan time.Time, limit int) ([]db.StuckHibernationUpload, error)
	MarkHibernationUploaded(ctx context.Context, hibernationKey string, sizeBytes int64) error
	MarkHibernationUploadFailed(ctx context.Context, hibernationKey, errMsg string) error
}

// hibUploadBlobStat checks the checkpoint store for a blob's presence + size.
type hibUploadBlobStat interface {
	Stat(ctx context.Context, key string) (size int64, exists bool, err error)
}

// HibernationUploadReconciler is the safety net for hibernation-upload bookkeeping.
//
// The worker records uploaded_at / upload_error from an async goroutine after the
// S3 archive upload finishes (qemu/snapshot.go -> the worker callback). If that
// write is lost — a transient DB error, or the worker being torn down mid-drain
// before the write lands — the sandbox_hibernations row is left stuck with
// NEITHER field set. Two bad consequences:
//
//   - The box is silently un-wakeable even though its blob is safely in S3.
//   - Worker teardown wedges forever: the scaler gates draining a worker on
//     CountPendingHibernationUploads == 0, so one stuck row can freeze the whole
//     fleet's rolling replace.
//
// Every period this reconciler finds rows with no terminal upload state, older
// than a grace window (well past the upload timeout so it never races an
// in-flight upload), and resolves each against the checkpoint store:
//
//	blob present -> MarkHibernationUploaded  (recover — the write was just lost)
//	blob absent  -> MarkHibernationUploadFailed (record the loss so the drain proceeds)
//
// Idempotent and self-healing; it also mops up historical orphans left by the
// same class of lost write on workers that are long gone.
type HibernationUploadReconciler struct {
	store  hibUploadReconcilerStore
	blobs  hibUploadBlobStat
	period time.Duration
	grace  time.Duration
	batch  int

	stopCh chan struct{}
	doneCh chan struct{}
	once   sync.Once
}

// HibernationUploadReconcilerConfig configures the reconciler.
type HibernationUploadReconcilerConfig struct {
	Store  hibUploadReconcilerStore
	Blobs  hibUploadBlobStat
	Period time.Duration // default 2m
	Grace  time.Duration // default 15m (well past the ~5m upload timeout)
	Batch  int           // max rows resolved per tick, default 200
}

// NewHibernationUploadReconciler returns nil if Store or Blobs is missing, so the
// caller can safely `.Start()` the result unconditionally.
func NewHibernationUploadReconciler(cfg HibernationUploadReconcilerConfig) *HibernationUploadReconciler {
	if cfg.Store == nil || cfg.Blobs == nil {
		return nil
	}
	if cfg.Period == 0 {
		cfg.Period = 2 * time.Minute
	}
	if cfg.Grace == 0 {
		cfg.Grace = 15 * time.Minute
	}
	if cfg.Batch == 0 {
		cfg.Batch = 200
	}
	return &HibernationUploadReconciler{
		store:  cfg.Store,
		blobs:  cfg.Blobs,
		period: cfg.Period,
		grace:  cfg.Grace,
		batch:  cfg.Batch,
		stopCh: make(chan struct{}),
		doneCh: make(chan struct{}),
	}
}

// Start begins the reconcile loop. No-op on a nil receiver.
func (r *HibernationUploadReconciler) Start(ctx context.Context) {
	if r == nil {
		return
	}
	go r.run(ctx)
}

// Stop gracefully shuts down.
func (r *HibernationUploadReconciler) Stop(ctx context.Context) error {
	if r == nil {
		return nil
	}
	r.once.Do(func() { close(r.stopCh) })
	select {
	case <-r.doneCh:
	case <-ctx.Done():
		return ctx.Err()
	}
	return nil
}

func (r *HibernationUploadReconciler) run(ctx context.Context) {
	defer close(r.doneCh)
	ticker := time.NewTicker(r.period)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-r.stopCh:
			return
		case <-ticker.C:
			r.tick(ctx)
		}
	}
}

// tick performs one reconciliation pass.
func (r *HibernationUploadReconciler) tick(ctx context.Context) {
	cutoff := time.Now().Add(-r.grace)
	stuck, err := r.store.ListStuckHibernationUploads(ctx, cutoff, r.batch)
	if err != nil {
		log.Printf("hib_upload_reconciler: list stuck uploads failed: %v", err)
		return
	}
	if len(stuck) == 0 {
		return
	}

	var recovered, lost, errs int
	for _, h := range stuck {
		select {
		case <-ctx.Done():
			return
		case <-r.stopCh:
			return
		default:
		}

		sCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		size, exists, serr := r.blobs.Stat(sCtx, h.HibernationKey)
		cancel()
		if serr != nil {
			// Transient (network/S3) — leave the row for the next tick.
			errs++
			log.Printf("hib_upload_reconciler: stat %s failed: %v (retry next tick)", h.HibernationKey, serr)
			continue
		}

		mCtx, mcancel := context.WithTimeout(ctx, 10*time.Second)
		if exists {
			if err := r.store.MarkHibernationUploaded(mCtx, h.HibernationKey, size); err != nil {
				errs++
				log.Printf("hib_upload_reconciler: mark uploaded %s failed: %v", h.HibernationKey, err)
			} else {
				recovered++
			}
		} else {
			if err := r.store.MarkHibernationUploadFailed(mCtx, h.HibernationKey,
				"reconciler: checkpoint blob absent after grace window; upload never completed"); err != nil {
				errs++
				log.Printf("hib_upload_reconciler: mark failed %s failed: %v", h.HibernationKey, err)
			} else {
				lost++
			}
		}
		mcancel()
	}

	log.Printf("hib_upload_reconciler: resolved %d stuck hibernation uploads (recovered=%d lost=%d errors=%d considered=%d)",
		recovered+lost, recovered, lost, errs, len(stuck))
}
