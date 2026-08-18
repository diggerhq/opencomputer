package api

import (
	"context"
	"log"
	"strings"
	"time"
)

// hibernation_reclaim.go — freeing hibernation archives nothing can wake.
//
// Hibernation uploads an archive per sandbox and, until this existed, exactly
// one thing ever deleted one: CreateHibernation superseding a previous archive
// for the same sandbox. Every other end-of-life freed nothing.
//
// The two that matter are both permanent:
//
//   - a WAKE. MarkHibernationRestored stamps restored_at and stops. From that
//     instant GetActiveHibernation cannot match the row (it filters on
//     restored_at IS NULL), so the object is unreachable by every code path in
//     the system. It is not a recovery copy; it is garbage with a bill.
//   - a DESTROY. Nothing consults sandbox_hibernations when a sandbox dies, so
//     the archive outlives the sandbox indefinitely.
//
// Measured on prod 2026-08-17: ~11 TB unreachable against ~16 TB live, on a
// bucket growing ~600 GB/day.
//
// The sweep runs out of band rather than deleting inline at the wake. A wake is
// latency-critical and a blob delete is a network round-trip to object storage
// that can fail; putting it on that path would trade a storage leak for a
// slower, flakier wake. Deferring costs only the grace period.

// hibernationReclaimInterval paces the sweep.
const hibernationReclaimInterval = 5 * time.Minute

// hibernationReclaimGrace is how long an archive is left alone before it is
// considered dead, measured from hibernated_at.
//
// The hazard this buys off is an upload still in flight for a row the sweep is
// about to delete underneath: the archive is written asynchronously, so a row
// can look dead by status while its bytes are still being written. An hour is
// far past any upload that is going to succeed (the largest measured, 500 MB,
// took ~2m30s) while still reclaiming same-day.
const hibernationReclaimGrace = time.Hour

// hibernationReclaimBatch bounds deletions per tick. Each is a round-trip to
// object storage, so this is a rate limit, not a correctness bound — the sweep
// resumes wherever it left off. At this size the backlog drains in hours while
// staying well clear of the storage provider's request limits.
const hibernationReclaimBatch = 200

// StartHibernationReclaim runs the sweep for the life of the process.
func (s *Server) StartHibernationReclaim(ctx context.Context) {
	if s == nil || s.store == nil || s.checkpointStore == nil {
		return
	}
	grace := time.Duration(envInt("OPENSANDBOX_HIBERNATION_RECLAIM_GRACE_SECONDS",
		int(hibernationReclaimGrace/time.Second))) * time.Second
	batch := envInt("OPENSANDBOX_HIBERNATION_RECLAIM_BATCH", hibernationReclaimBatch)

	// Batch 0 is the off switch, and it has to be expressible. Coercing a zero
	// up to a default is how "disabled" quietly becomes "enabled" — if this
	// sweep ever starts deleting something it should not, an operator needs a
	// way to stop it that does not require a new build.
	if batch == 0 {
		log.Printf("api: hibernation reclaim DISABLED (OPENSANDBOX_HIBERNATION_RECLAIM_BATCH=0)")
		return
	}

	go func() {
		t := time.NewTicker(hibernationReclaimInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				s.reclaimHibernationBlobs(ctx, grace, batch)
			}
		}
	}()
	log.Printf("api: hibernation reclaim started (grace=%s, batch=%d/%s)",
		grace, batch, hibernationReclaimInterval)
}

// reclaimHibernationBlobs deletes one bounded batch of dead archives.
func (s *Server) reclaimHibernationBlobs(ctx context.Context, grace time.Duration, batch int) {
	rows, err := s.store.ListReclaimableHibernations(ctx, grace, batch)
	if err != nil {
		log.Printf("api: hibernation reclaim query failed: %v", err)
		return
	}
	if len(rows) == 0 {
		return
	}

	var freed, deleted, skipped int64
	byReason := map[string]int{}
	for _, r := range rows {
		if ctx.Err() != nil {
			return
		}
		if !deletableBlobKey(r.HibernationKey) {
			// Nothing to delete in object storage, but the row must still leave
			// the queue or the sweep re-reads it every tick forever.
			if err := s.store.MarkHibernationBlobDeleted(ctx, r.ID); err != nil {
				log.Printf("api: hibernation reclaim: mark %s: %v", r.SandboxID, err)
			}
			skipped++
			continue
		}

		delCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		err := s.checkpointStore.Delete(delCtx, r.HibernationKey)
		cancel()
		if err != nil {
			// Leave blob_deleted_at unset so the next tick retries. A delete
			// that failed must not be recorded as done — that is precisely how
			// an object gets stranded with no record that it still exists.
			log.Printf("api: hibernation reclaim: delete %s (%s): %v", r.HibernationKey, r.Reason, err)
			continue
		}
		if err := s.store.MarkHibernationBlobDeleted(ctx, r.ID); err != nil {
			// The object is already gone; failing to stamp only costs a
			// duplicate delete next tick, which object stores treat as success.
			log.Printf("api: hibernation reclaim: mark %s deleted: %v", r.SandboxID, err)
		}
		deleted++
		freed += r.SizeBytes
		byReason[r.Reason]++
	}

	if deleted > 0 || skipped > 0 {
		log.Printf("api: hibernation reclaim freed %d archive(s), %d MB %v (%d keyless)",
			deleted, freed>>20, byReason, skipped)
	}
}

// checkpointObjectSuffixes are the object names a USER CHECKPOINT is made of.
//
// Hibernation archives and customer checkpoints share the checkpoints/ prefix:
//
//	hibernation archive  checkpoints/<sandbox>/<epoch>.tar.zst
//	user checkpoint      checkpoints/<sandbox>/<uuid>/rootfs.tar.zst
//
// so prefix alone cannot tell them apart. The leaf name can.
var checkpointObjectSuffixes = []string{"/rootfs.tar.zst", "/workspace.tar.zst"}

// deletableBlobKey reports whether a hibernation key names an object this sweep
// is allowed to delete.
//
// Two kinds of key are not deletable objects at all: "local://" marks an
// archive kept on the worker's own disk, which no central sweep can or should
// touch, and an empty key belongs to a hibernation that failed before it ever
// named one. Handing either to Delete would at best error every tick and at
// worst address the wrong thing.
//
// The third check is the one that matters. This sweep only ever reads
// hibernation_key, so on today's code it cannot see a checkpoint — but "the
// query only returns hibernation rows" is an argument about the caller, and
// customer checkpoints are not something to protect with an argument. A
// hibernation archive is a single timestamped object and never carries these
// leaf names, so refusing them costs nothing and makes deleting a customer
// checkpoint structurally impossible rather than merely unlikely.
func deletableBlobKey(key string) bool {
	if key == "" || strings.HasPrefix(key, "local://") {
		return false
	}
	for _, suffix := range checkpointObjectSuffixes {
		if strings.HasSuffix(key, suffix) {
			return false
		}
	}
	return true
}
