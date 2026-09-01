package api

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/opensandbox/opensandbox/pkg/types"
	"log"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/opensandbox/opensandbox/internal/controlplane"
	"github.com/opensandbox/opensandbox/internal/db"
	pb "github.com/opensandbox/opensandbox/proto/worker"
)

// Compile-time assertion that *Server satisfies the OrgHalter interface from
// the controlplane package. If the interface changes, this fails fast.
var _ controlplane.OrgHalter = (*Server)(nil)

// haltCoordinator dedupes concurrent halt webhooks for the same org. The DO
// retries on transient failure, and the halt_reconciler safety net may also
// fire a halt for the same org in the same ~30s window. We want each org to
// have at most one halt goroutine running at a time, so a redundant call
// short-circuits while the original finishes.
var (
	haltInFlight = struct {
		sync.Mutex
		m map[string]struct{}
	}{m: make(map[string]struct{})}
	resumeInFlight = struct {
		sync.Mutex
		m map[string]struct{}
	}{m: make(map[string]struct{})}
)

func acquireHaltSlot(orgID string) bool {
	haltInFlight.Lock()
	defer haltInFlight.Unlock()
	if _, busy := haltInFlight.m[orgID]; busy {
		return false
	}
	haltInFlight.m[orgID] = struct{}{}
	return true
}

func releaseHaltSlot(orgID string) {
	haltInFlight.Lock()
	defer haltInFlight.Unlock()
	delete(haltInFlight.m, orgID)
}

func acquireResumeSlot(orgID string) bool {
	resumeInFlight.Lock()
	defer resumeInFlight.Unlock()
	if _, busy := resumeInFlight.m[orgID]; busy {
		return false
	}
	resumeInFlight.m[orgID] = struct{}{}
	return true
}

func releaseResumeSlot(orgID string) {
	resumeInFlight.Lock()
	defer resumeInFlight.Unlock()
	delete(resumeInFlight.m, orgID)
}

// HaltOrg responds quickly (202-style — runs the actual hibernate work in a
// background goroutine) and returns the count of sandboxes the cell intends to
// halt. The DO doesn't need to block on every hibernate completing; the cell's
// halt_reconciler will re-issue the halt on the next tick if any sandboxes
// remain running, which keeps the system convergent without long DO calls.
//
// halt_reason='credits_exhausted' is stamped on each hibernated session so
// ResumeOrg can wake just those (and leave user-initiated hibernations alone).
func (s *Server) HaltOrg(ctx context.Context, orgIDStr, reason string) (int, error) {
	if s.store == nil {
		return 0, fmt.Errorf("database not configured")
	}
	// Deliberately NOT gated on workerRegistry. A cell whose sandboxes all live
	// on a managed backend has no registry, and refusing here meant a halted
	// org's sandboxes kept running — billed and reachable — for the rest of
	// their lives. haltOne picks the right mechanism per sandbox.
	orgID, err := uuid.Parse(orgIDStr)
	if err != nil {
		return 0, fmt.Errorf("invalid org_id: %w", err)
	}

	// Halt state now lives in D1 only (migration 041 dropped the local orgs
	// table). The edge gates create + wake against D1.is_halted before the
	// request ever reaches the cell, so the cell-PG mirror this used to keep
	// is no longer needed. Sandbox hibernation below still proceeds.

	sessions, err := s.store.ListSandboxSessions(ctx, orgID, "running", 1000, 0)
	if err != nil {
		return 0, fmt.Errorf("list running sessions: %w", err)
	}
	if len(sessions) == 0 {
		return 0, nil
	}

	if !acquireHaltSlot(orgIDStr) {
		// Another halt for this org is already in flight — short-circuit. The
		// running goroutine will hibernate everything visible at its start,
		// and the reconciler catches anything created in between.
		return len(sessions), nil
	}

	// Detach from the inbound HTTP context — caller (CF DO) is going to
	// return immediately, but the hibernate gRPC calls take 30s+ each and
	// we don't want them cancelled by the webhook's idle close.
	go func(sessions []db.SandboxSession) {
		defer releaseHaltSlot(orgIDStr)
		bgCtx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		for i := range sessions {
			sess := &sessions[i]
			if err := s.haltOne(bgCtx, sess, orgID); err != nil {
				log.Printf("admin: halt-org %s: hibernate sandbox %s failed: %v (reason=%s)", orgIDStr, sess.SandboxID, err, reason)
				continue
			}
			if err := s.store.SetSandboxHaltReason(bgCtx, sess.SandboxID, "credits_exhausted"); err != nil {
				log.Printf("admin: halt-org %s: stamp halt_reason on %s failed: %v", orgIDStr, sess.SandboxID, err)
			}
		}
	}(sessions)

	return len(sessions), nil
}

// ResumeOrg clears the cell-local halt flag, then asynchronously wakes every
// sandbox the org has hibernated with halt_reason='credits_exhausted'. Manual
// hibernations (halt_reason IS NULL) stay hibernated — the user can wake them
// explicitly. skip_resume short-circuits the wake fan-out (useful when the
// DO just wants to mark the org as un-halted without auto-waking).
func (s *Server) ResumeOrg(ctx context.Context, orgIDStr string, skipResume bool) (int, error) {
	if s.store == nil {
		return 0, fmt.Errorf("database not configured")
	}
	// Not gated on workerRegistry — see HaltOrg. An org that could be halted on
	// this cell has to be resumable on it.
	orgID, err := uuid.Parse(orgIDStr)
	if err != nil {
		return 0, fmt.Errorf("invalid org_id: %w", err)
	}

	// Cell-PG orgs table is gone post-041; D1 is authoritative for is_halted.
	// Resume of running sandboxes still proceeds below.

	if skipResume {
		return 0, nil
	}

	sessions, err := s.store.ListSandboxSessionsByHaltReason(ctx, orgID, "credits_exhausted")
	if err != nil {
		return 0, fmt.Errorf("list halted sessions: %w", err)
	}
	if len(sessions) == 0 {
		return 0, nil
	}

	if !acquireResumeSlot(orgIDStr) {
		return len(sessions), nil
	}

	go func(sessions []db.SandboxSession) {
		defer releaseResumeSlot(orgIDStr)
		bgCtx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		for i := range sessions {
			sess := &sessions[i]
			if err := s.wakeForResume(bgCtx, sess.SandboxID); err != nil {
				log.Printf("admin: resume-org %s: wake sandbox %s failed: %v", orgIDStr, sess.SandboxID, err)
				continue
			}
			// Clear halt_reason — the sandbox is no longer credit-halted.
			if err := s.store.SetSandboxHaltReason(bgCtx, sess.SandboxID, ""); err != nil {
				log.Printf("admin: resume-org %s: clear halt_reason on %s failed: %v", orgIDStr, sess.SandboxID, err)
			}
		}
	}(sessions)

	return len(sessions), nil
}

// hibernateForHalt mirrors hibernateSandboxRemote but skips the auth check
// and runs without an echo.Context. Same gRPC + DB path; the DO webhook is
// the authorization.
func (s *Server) hibernateForHalt(ctx context.Context, sandboxID, workerID, region, template string, config []byte, orgID uuid.UUID) error {
	client, err := s.workerRegistry.GetWorkerClient(workerID)
	if err != nil {
		return fmt.Errorf("worker %s unreachable: %w", workerID, err)
	}
	grpcCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	grpcResp, err := client.HibernateSandbox(grpcCtx, &pb.HibernateSandboxRequest{SandboxId: sandboxID})
	if err != nil {
		return fmt.Errorf("grpc HibernateSandbox: %w", err)
	}
	_, superseded, _ := s.store.CreateHibernation(ctx, sandboxID, orgID, grpcResp.CheckpointKey, grpcResp.SizeBytes, region, template, config)
	s.deleteSupersededHibernation(superseded)
	_ = s.store.UpdateSandboxSessionStatus(ctx, sandboxID, "hibernated", nil)
	if s.sandboxAPIProxy != nil {
		s.sandboxAPIProxy.InvalidateRouteCache(sandboxID)
	}
	// Worker's HibernateSandbox handler emits the "hibernated" lifecycle event
	// + SandboxDBManager flushes it before SQLite is removed. events-ingest
	// updates D1 sandboxes_index from there.
	return nil
}

// wakeForResume mirrors wakeSandboxRemote but skips the wake-time credit
// gate (the whole point of resume is that the DO just decided the org is
// no longer halted) and runs without an echo.Context.
func (s *Server) wakeForResume(ctx context.Context, sandboxID string) error {
	hibernation, err := s.store.GetActiveHibernation(ctx, sandboxID)
	if err != nil {
		return fmt.Errorf("get active hibernation: %w", err)
	}
	session, err := s.store.GetSandboxSession(ctx, sandboxID)
	if err != nil {
		return fmt.Errorf("get session: %w", err)
	}
	if session.Status != "hibernated" {
		return fmt.Errorf("sandbox %s is not hibernated (status=%s)", sandboxID, session.Status)
	}

	// A managed backend that archived this sandbox has no host to wake — the
	// host was released at halt, and the worker id on the row names a box that
	// no longer exists. Asking the registry for it yields "worker unreachable"
	// for a sandbox that is perfectly restorable.
	//
	// A NON-EMPTY hibernation key is what distinguishes the two ways a managed
	// sandbox can be parked: an idle park suspends the box and records no key,
	// so it is woken; a halt archives and records the archive's key, so it is
	// restored onto a fresh host.
	if ha, ok := s.haltArchiverFor(session.WorkerID); ok && hibernation.HibernationKey != "" {
		return s.resumeViaArchive(ctx, ha, session, hibernation)
	}
	if s.workerRegistry == nil {
		return fmt.Errorf("no backend and no worker registry can revive sandbox %s", sandboxID)
	}

	region := hibernation.Region
	uploadComplete := hibernation.UploadedAt != nil
	var workerClient pb.SandboxWorkerClient
	var workerEntry *controlplane.WorkerEntry
	if session.WorkerID != "" {
		if src := s.workerRegistry.GetWorker(session.WorkerID); src != nil &&
			!src.Draining && src.CPUPct < 90 && src.MemPct < 90 && src.DiskPct < 90 {
			if cli, cerr := s.workerRegistry.GetWorkerClient(session.WorkerID); cerr == nil {
				workerEntry = src
				workerClient = cli
			}
		}
	}
	if workerEntry == nil {
		if !uploadComplete {
			return fmt.Errorf("source worker unavailable and hibernation upload not yet complete; retry shortly")
		}
		var lerr error
		workerEntry, workerClient, lerr = s.workerRegistry.GetLeastLoadedWorker(region)
		if lerr != nil {
			return fmt.Errorf("no workers available in region %s: %w", region, lerr)
		}
	}

	grpcCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	_, err = workerClient.WakeSandbox(grpcCtx, &pb.WakeSandboxRequest{
		SandboxId:     sandboxID,
		CheckpointKey: hibernation.HibernationKey,
	})
	if err != nil {
		return fmt.Errorf("grpc WakeSandbox: %w", err)
	}
	_ = s.store.MarkHibernationRestored(ctx, sandboxID)
	_ = s.store.UpdateSandboxSessionForWake(ctx, sandboxID, workerEntry.ID)
	if workerEntry.GoldenVersion != "" {
		_ = s.store.SetSandboxGoldenVersion(ctx, sandboxID, workerEntry.GoldenVersion)
	}
	if s.sandboxAPIProxy != nil {
		s.sandboxAPIProxy.InvalidateRouteCache(sandboxID)
	}
	// Worker's WakeSandbox handler emits "woke"; events-ingest sets D1 to running.
	return nil
}

// haltOne parks a single sandbox for an org halt, using whichever mechanism its
// runtime actually supports.
//
// The QEMU fleet hibernates: a full checkpoint to blob, worker freed, wakeable
// forever. A managed backend that can only SUSPEND cannot express that — the
// MicroVM provider counts suspended time against the same 8h lifetime cap as
// running time, so suspending would hand every halted org a sandbox that
// silently dies within the day and takes its disk with it. Those runtimes
// archive the workspace and give the host back instead, which stops the charge
// immediately and survives a halt of any length.
func (s *Server) haltOne(ctx context.Context, sess *db.SandboxSession, orgID uuid.UUID) error {
	if ha, ok := s.haltArchiverFor(sess.WorkerID); ok {
		return s.haltViaArchive(ctx, ha, sess, orgID)
	}
	if s.workerRegistry == nil {
		return fmt.Errorf("no backend and no worker registry holds sandbox %s", sess.SandboxID)
	}
	return s.hibernateForHalt(ctx, sess.SandboxID, sess.WorkerID, sess.Region, sess.Template, sess.Config, orgID)
}

// haltViaArchive is archive → record → release, and the order is the whole
// design.
//
// Releasing the host is irreversible: there is no memory or disk export on this
// runtime, so once the box is gone the archive is the only copy of the
// customer's data. Every step that could fail therefore happens while the box
// is still alive and the operation is still abandonable. A halt that gives up
// halfway leaves a running sandbox, which the halt reconciler simply retries on
// its next tick — the one outcome that must never happen is a terminated host
// with nothing pointing at its archive.
func (s *Server) haltViaArchive(ctx context.Context, ha haltArchiver, sess *db.SandboxSession, orgID uuid.UUID) error {
	// 1. Archive. Box untouched; a failure here costs nothing but a retry.
	key, size, err := ha.ArchiveForHalt(ctx, sess.SandboxID, s.checkpointStore)
	if err != nil {
		return fmt.Errorf("archive for halt: %w", err)
	}

	// 2. Record, still before anything destructive. If this fails the archive
	// is orphaned in blob storage — wasteful, but the sandbox is untouched and
	// the next tick tries again. Reversed, it would be unrecoverable.
	if _, superseded, cErr := s.store.CreateHibernation(ctx, sess.SandboxID, orgID, key, size,
		sess.Region, sess.Template, sess.Config); cErr != nil {
		return fmt.Errorf("record hibernation (archive %s left orphaned, sandbox untouched): %w", key, cErr)
	} else {
		s.deleteSupersededHibernation(superseded)
	}

	// 3. Release. Past this line the archive is the only copy.
	if rErr := ha.ReleaseForHalt(ctx, sess.SandboxID); rErr != nil {
		// The row still says running and the record now exists. Leaving the
		// status alone is right: the box may genuinely still be alive, and
		// calling it hibernated would make a live sandbox invisible.
		return fmt.Errorf("release host after archiving to %s: %w", key, rErr)
	}

	if uErr := s.store.UpdateSandboxSessionStatus(ctx, sess.SandboxID, "hibernated", nil); uErr != nil {
		log.Printf("admin: halt %s: archived and released but status flip failed: %v", sess.SandboxID, uErr)
	}
	// Carries the transition to D1, which is what customer-facing reads answer
	// from. Postgres alone would leave every surface reporting `running` for a
	// sandbox whose host no longer exists — the same gap the idle park hit.
	if s.sandboxDBs != nil {
		if sdb, dbErr := s.sandboxDBs.Get(sess.SandboxID); dbErr == nil {
			_ = sdb.LogEvent("hibernated", map[string]string{
				"sandbox_id":     sess.SandboxID,
				"checkpoint_key": key,
			})
		}
		_ = s.sandboxDBs.Remove(sess.SandboxID)
	}
	if s.sandboxAPIProxy != nil {
		s.sandboxAPIProxy.InvalidateRouteCache(sess.SandboxID)
	}
	log.Printf("admin: halted %s — archived %d bytes to %s and released its host", sess.SandboxID, size, key)
	return nil
}

// resumeViaArchive is the other half: a new host, the archive laid back onto
// it, and the row repointed at wherever it landed.
func (s *Server) resumeViaArchive(ctx context.Context, ha haltArchiver, sess *db.SandboxSession, hib *db.SandboxHibernation) error {
	// Size is not a column — it lives in the session's stored config, which is
	// the same blob the QEMU restore path reads. A zero here is not a problem:
	// it means "the default tier", which is what the sandbox was created at.
	var cfg types.SandboxConfig
	if len(sess.Config) > 0 {
		if uErr := json.Unmarshal(sess.Config, &cfg); uErr != nil {
			log.Printf("admin: resume %s: unreadable stored config (%v) — restoring at the default size", sess.SandboxID, uErr)
		}
	}
	workerID, err := ha.RestoreForResume(ctx, sess.SandboxID, hib.HibernationKey, s.checkpointStore, HaltRestoreSpec{
		Template: sess.Template,
		MemoryMB: cfg.MemoryMB,
		CPUCount: cfg.CpuCount,
	})
	if err != nil {
		return fmt.Errorf("restore from archive: %w", err)
	}
	// The sandbox is on a DIFFERENT host than before the halt, so the row has
	// to be repointed. Skipping this leaves every later request routed at a
	// terminated box.
	if uErr := s.store.UpdateSandboxSessionForWake(ctx, sess.SandboxID, workerID); uErr != nil {
		log.Printf("admin: resume %s: restored onto %s but could not repoint the row: %v", sess.SandboxID, workerID, uErr)
	}
	_ = s.store.MarkHibernationRestored(ctx, sess.SandboxID)
	if s.sandboxAPIProxy != nil {
		s.sandboxAPIProxy.InvalidateRouteCache(sess.SandboxID)
	}
	if s.sandboxDBs != nil {
		if sdb, dbErr := s.sandboxDBs.Get(sess.SandboxID); dbErr == nil {
			_ = sdb.LogEvent("woke", map[string]string{"sandbox_id": sess.SandboxID})
		}
	}
	log.Printf("admin: resumed %s from %s onto %s", sess.SandboxID, hib.HibernationKey, workerID)
	return nil
}
