package worker

import (
	"testing"

	"github.com/opensandbox/opensandbox/internal/db"
)

func TestIsStrayVM(t *testing.T) {
	const self = "w-azure-osb-worker-self"
	const other = "w-azure-osb-worker-other"

	cases := []struct {
		name    string
		session *db.SandboxSession
		want    bool
	}{
		// --- legit: never reap ---
		{"running here", &db.SandboxSession{WorkerID: self, Status: "running"}, false},
		{"pooled here", &db.SandboxSession{WorkerID: self, Status: "pooled"}, false},
		{"hibernated (paused) here", &db.SandboxSession{WorkerID: self, Status: "hibernated"}, false},
		{"deep-hibernated here", &db.SandboxSession{WorkerID: self, Status: "hibernated"}, false},
		{"nil session", nil, false},
		{"empty home", &db.SandboxSession{WorkerID: "", Status: "hibernated"}, false},
		// in-flight incoming migration: home still points at source, box running.
		{"incoming migration (foreign home, running)", &db.SandboxSession{WorkerID: other, Status: "running"}, false},
		// mid-migration flag set: never touch, even if it looks foreign.
		{"migrating flag set", &db.SandboxSession{WorkerID: other, Status: "hibernated", MigratingToWorker: self}, false},
		{"migrating flag set, running here", &db.SandboxSession{WorkerID: self, Status: "running", MigratingToWorker: other}, false},

		// --- stray: reap ---
		{"deep-hibernated elsewhere (the observed leak)", &db.SandboxSession{WorkerID: other, Status: "hibernated"}, true},
		{"stopped elsewhere", &db.SandboxSession{WorkerID: other, Status: "stopped"}, true},
		{"pooled but owned elsewhere", &db.SandboxSession{WorkerID: other, Status: "pooled"}, true},
		{"terminal (stopped) here, qemu leaked", &db.SandboxSession{WorkerID: self, Status: "stopped"}, true},
		{"terminal (error) here, qemu leaked", &db.SandboxSession{WorkerID: self, Status: "error"}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := isStrayVM(tc.session, self); got != tc.want {
				t.Errorf("isStrayVM(%+v) = %v, want %v", tc.session, got, tc.want)
			}
		})
	}
}
