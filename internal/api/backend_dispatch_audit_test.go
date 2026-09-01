package api

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// backend_dispatch_audit_test.go — the recurring bug, pinned.
//
// A handler that opens with `if s.workerRegistry != nil { …Remote(…) }` and
// never asks who holds the sandbox can only ever answer "no gRPC connection to
// worker vmhost:…" for a managed runtime — for an operation whose manager
// implements it correctly. That is not a graceful degradation; it reads as an
// outage, and the manager code sits there unreachable and unnoticed.
//
// It has now happened four separate times: the proxy routes that marked healthy
// MicroVM sandboxes `stopped`, PTY, reboot/power-cycle, and stats. The cause is
// structural — internal/api/backend.go was introduced AFTER these handlers
// existed, and nothing forces a route through it.
//
// So this test is the forcing function. A handler is either backend-aware, or
// it is on the list below with a reason.

// knownUnwired are handlers that dispatch to the worker path without consulting
// the backend seam, and are deliberately still that way.
//
// Removing an entry as you wire one up is the point. ADDING one should be a
// conscious act with a reason next to it, not something a new route falls into.
var knownUnwired = map[string]string{
	// createCheckpoint and restoreCheckpoint are wired (2026-08-31). What is
	// left of the family is genuinely QEMU-shaped: promotion is a disk_only→full
	// transition a workspace archive has no tier for, and fork CREATES a
	// sandbox, which belongs to the placement path rather than a manager call.
	"promoteCheckpointToFull":  "checkpoint handlers mix DB bookkeeping with dispatch",
	"createFromCheckpointCore": "fork needs the create/placement flow, not a manager call",
	"execPatchOnSandbox":       "checkpoint-patch path, follows the checkpoint family",

	// Scaling is a QEMU capability (virtio-mem). The managed runtimes size by
	// image and have nothing to dispatch; this wants a 501 like setLimits got.

	// Reads that answer from the database rather than the runtime.
	"listSandboxes": "answers from the sandboxes table, not the runtime",

	// Worker-fleet operations. A managed backend has no worker to drain,
	// evict, or manufacture pool stock on, so there is nothing to dispatch.
	"adminSetWorkerDraining": "operates on a worker, not a sandbox",
	"adminForceHibernate":    "empties one worker; managed backends have none",
	"adminEvictWorker":       "operates on a worker, not a sandbox",
	"listWorkers":            "enumerates the worker fleet",
	"manufacturePoolBoxOn":   "QEMU pool manufacture; lite pools via its own manager",
	"reconcilePool":          "QEMU pool reconciliation",
	"WipeWorkerPool":         "QEMU pool teardown",
	"tryClaimPooled":         "claims from the QEMU pool specifically",
	"proxyWorkerHTTP":        "the worker leg of an already-dispatched proxy",

	// Live migration is a QEMU capability (dirty-page transfer between two
	// hosts we own). Managed backends cannot migrate at all.
	"migrateSandbox":            "live migration is QEMU-only",
	"findScaleMigrationTargets": "live migration is QEMU-only",
	"migrateForScale":           "live migration is QEMU-only",

	// Edge-claim finalize dispatches to the MicroVM backend through its own
	// EdgeFinalize path; the registry call here is the QEMU branch.
	"claimFinalize":             "QEMU branch; MicroVM finalize goes via EdgeFinalize",
	"reapStaleEdgeReservations": "QEMU branch; MicroVM reservations reaped by the backend",

	// Org halt/resume are wired as of 2026-09-01: haltOne and wakeForResume
	// ask haltArchiverFor first. hibernateForHalt is what remains of the QEMU
	// half — the leg haltOne chooses, exactly like a `…Remote` function.
	"hibernateForHalt":      "the QEMU leg, chosen by haltOne after it asks the seam",
	"internalDeepHibernate": "deep hibernation is a QEMU checkpoint tier",
	"hibernateDeepFallback": "deep hibernation is a QEMU checkpoint tier",
	"adminReport":           "admin aggregate, not a per-sandbox dispatch",
	"buildImage":            "image build is worker-fleet only",
}

func TestHandlersConsultTheBackendSeamBeforeTheWorkerRegistry(t *testing.T) {
	aware := []string{
		"backendFor", "execManagerFor", "hibernatorFor", "managerFor",
		"backendForWorkerID", "ptyBackendFor", "execSessionBackendFor",
		"haltArchiverFor",
	}
	fnRe := regexp.MustCompile(`(?ms)^func \(s \*Server\) (\w+)\([^\n]*\{\n(.*?)\n\}`)

	// Every file that touches the registry, not a hand-kept subset. The
	// secret-refresh fanout lived in projects.go and so was invisible to this
	// test for as long as the list was curated by hand.
	paths, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	for _, path := range paths {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		src, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
		for _, m := range fnRe.FindAllStringSubmatch(string(src), -1) {
			name, body := m[1], m[2]
			// ANY use of the registry, not just the `!= nil` guard. The bug
			// this test exists to catch also wears two other costumes: an
			// early `if s.workerRegistry == nil { return }`, which turns the
			// whole operation into a silent no-op on a registry-less cell,
			// and a bare `s.workerRegistry.GetWorkerClient(…)`.
			reg := -1
			for _, use := range []string{"s.workerRegistry != nil", "s.workerRegistry == nil", "s.workerRegistry."} {
				if i := strings.Index(body, use); i >= 0 && (reg < 0 || i < reg) {
					reg = i
				}
			}
			if reg < 0 {
				continue
			}
			// A `…Remote` function IS the worker leg — a seam-aware caller
			// already chose it. Requiring it to re-ask would be circular.
			if strings.HasSuffix(name, "Remote") {
				continue
			}
			first := -1
			for _, a := range aware {
				if i := strings.Index(body, a); i >= 0 && (first < 0 || i < first) {
					first = i
				}
			}
			backendFirst := first >= 0 && first < reg
			_, allowed := knownUnwired[name]

			if !backendFirst && !allowed {
				t.Errorf("%s (%s) dispatches to the worker registry without asking who holds the sandbox — "+
					"a managed sandbox can only get 'no gRPC connection to worker vmhost:…'. "+
					"Add an execManagerFor/backendFor branch before it, or add it to knownUnwired with a reason.",
					name, path)
			}
			if backendFirst && allowed {
				t.Errorf("%s (%s) is backend-aware now — remove it from knownUnwired", name, path)
			}
		}
	}
}
