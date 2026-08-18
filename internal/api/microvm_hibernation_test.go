package api

import (
	"testing"
	"time"

	"github.com/opensandbox/opensandbox/internal/db"
)

// A suspended box may only be released once its archive is durable. Before
// that it is the only copy of the sandbox, and terminating it destroys the
// customer's files outright — there is no degraded wake, there is nothing.
//
// This is the invariant the whole hibernation design rests on, so it is pinned
// here rather than left to a WHERE clause.
func TestSuspendedBoxIsNeverRetiredBeforeItsUploadCompletes(t *testing.T) {
	if safeToRetire(db.RetirableHibernation{SandboxID: "sb-1", UploadedAt: nil}) {
		t.Fatal("retired a hibernation whose archive had not finished uploading — the sandbox would be destroyed")
	}
}

// Once the archive is stored the box is only a latency cache, and holding it
// costs regional memory quota — the ceiling on warm-pool depth. Failing to
// release it is a slow capacity leak.
func TestRetiresOnceTheArchiveIsDurable(t *testing.T) {
	at := time.Now().Add(-time.Minute)
	if !safeToRetire(db.RetirableHibernation{SandboxID: "sb-1", UploadedAt: &at}) {
		t.Fatal("kept a suspended box after its archive was safely uploaded")
	}
}
