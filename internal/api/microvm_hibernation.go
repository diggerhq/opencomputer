package api

import (
	"context"
	"log"
	"time"

	"github.com/opensandbox/opensandbox/internal/db"
)

// microvm_hibernation.go — retiring the suspended box behind a hibernation.
//
// Hibernate exports the workspace to blob storage and then suspends the box, so
// from that moment there are two copies: a durable archive, and a suspended
// host that can serve a ~1s resume instead of a restore. The host is the
// disposable one — it goes on holding regional memory quota, which is the
// ceiling on warm-pool depth, purely to make a quick wake quicker.
//
// This sweep retires it. Two conditions, and the order matters:
//
//  1. the upload must have completed. A suspended box whose archive is still in
//     flight is the ONLY copy of that sandbox, and terminating it loses the
//     customer's data outright. Not slowly, not recoverably — the box is gone
//     and the blob is a partial object nothing can restore from.
//
//  2. the dwell must have elapsed. Customers who hibernate and wake within the
//     same minute are common, and for them the suspended box is the difference
//     between a resume and a full restore.
//
// Condition 1 is a safety invariant and has no timeout: if an upload is stuck
// for an hour, the box lives for an hour. Condition 2 is a tunable comfort
// margin on top.

// hibernationDwell is how long a suspended box is kept after its archive is
// durable. Short enough to bound quota, long enough to cover the
// hibernate-then-immediately-wake pattern.
const hibernationDwell = 10 * time.Minute

// hibernationSweepInterval paces the sweep. Well under the dwell so a box is
// retired close to its deadline rather than a whole period late.
const hibernationSweepInterval = 2 * time.Minute

// StartHibernationExpiry runs the sweep for the life of the process.
func (b *microvmBackend) StartHibernationExpiry(ctx context.Context, store *db.Store) {
	if b == nil || store == nil {
		return
	}
	go func() {
		t := time.NewTicker(hibernationSweepInterval)
		defer t.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				b.expireHibernations(ctx, store)
			}
		}
	}()
	log.Printf("microvm: hibernation expiry started (dwell=%s, gated on upload completion)", hibernationDwell)
}

// expireHibernations terminates suspended boxes whose archive is safely stored
// and whose dwell has passed.
func (b *microvmBackend) expireHibernations(ctx context.Context, store *db.Store) {
	rows, err := store.ListRetirableHibernations(ctx, b.WorkerIDPrefixes(), time.Now().Add(-hibernationDwell))
	if err != nil {
		log.Printf("microvm: hibernation expiry query failed: %v", err)
		return
	}
	var retired int
	for _, r := range rows {
		microvmID, ok := parseMicrovmWorkerID(r.WorkerID)
		if !ok {
			continue
		}
		if !safeToRetire(r) {
			continue
		}
		if err := b.client.Terminate(ctx, microvmID); err != nil {
			log.Printf("microvm: expire %s: terminate: %v", r.SandboxID, err)
			continue
		}
		if err := store.SetHibernationMode(ctx, r.SandboxID, "deep"); err != nil {
			log.Printf("microvm: expire %s: mark deep: %v", r.SandboxID, err)
		}
		b.manager.Forget(r.SandboxID)
		retired++
	}
	if retired > 0 {
		log.Printf("microvm: hibernation expiry retired %d suspended box(es) to blob-only", retired)
	}
}


// safeToRetire reports whether a suspended box can be terminated.
//
// Separate from the query on purpose. The SQL already filters on uploaded_at,
// but this is the single line standing between a customer's files and
// deletion, and a WHERE clause is easy to loosen by accident three refactors
// from now. Checking it again in code — where it can be tested without a
// database — makes the invariant something a test can hold onto.
//
// Until the archive is uploaded the suspended box is the ONLY copy of that
// sandbox: the blob is a partial object nothing can restore from. Terminating
// then does not degrade the wake, it destroys the sandbox.
func safeToRetire(r db.RetirableHibernation) bool {
	return r.UploadedAt != nil
}
