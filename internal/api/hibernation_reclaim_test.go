package api

import "testing"

// hibernation_reclaim_test.go — the guards standing between the reclaim sweep
// and customer data.
//
// This sweep deletes objects from blob storage permanently. The tests that
// matter here are not "does it delete things" but "what will it refuse to
// delete", so they are written as refusals.

// The reclaim sweep must never delete a user checkpoint. Hibernation archives
// and customer checkpoints share the checkpoints/ prefix and are told apart
// only by their leaf name:
//
//	hibernation archive  checkpoints/<sandbox>/<epoch>.tar.zst
//	user checkpoint      checkpoints/<sandbox>/<uuid>/rootfs.tar.zst
//
// The sweep reads hibernation_key and so should never see a checkpoint at all,
// but "the query is right" is a property of the caller. This is the property of
// the deleter.
func TestReclaimRefusesUserCheckpointObjects(t *testing.T) {
	checkpoints := []string{
		"checkpoints/sb-00311f36/cf4024d5-25ea-4ddb-a646-ef8448aea0db/rootfs.tar.zst",
		"checkpoints/sb-00311f36/cf4024d5-25ea-4ddb-a646-ef8448aea0db/workspace.tar.zst",
		"checkpoints/sb-build-9516bc9e/a3cc86f0-3aea-429a-a7f9-417824f8c337/rootfs.tar.zst",
	}
	for _, key := range checkpoints {
		if deletableBlobKey(key) {
			t.Errorf("sweep would delete the user checkpoint %q", key)
		}
	}
}

// The archives the sweep exists to free must actually be deletable, or the
// guard above has quietly turned the whole thing into a no-op while still
// logging success.
func TestReclaimAcceptsHibernationArchives(t *testing.T) {
	archives := []string{
		"checkpoints/sb-c25159be/1755400000.tar.zst",
		"hibernations/sb-d064ceb0.tgz",
	}
	for _, key := range archives {
		if !deletableBlobKey(key) {
			t.Errorf("sweep refuses the hibernation archive %q — nothing would ever be freed", key)
		}
	}
}

// A "local://" key names an archive on a worker's own disk. The control plane
// cannot reach it, and handing it to the blob store would address something
// else entirely or error on every tick forever.
func TestReclaimRefusesLocalArchives(t *testing.T) {
	if deletableBlobKey("local:///data/hibernations/sb-abc.tar.zst") {
		t.Fatal("sweep would hand a worker-local path to the blob store")
	}
}

// An empty key belongs to a hibernation that failed before it named an object.
// There is nothing to delete, and an empty key passed through to a bucket
// delete is an unpredictable request, not a no-op.
func TestReclaimRefusesEmptyKey(t *testing.T) {
	if deletableBlobKey("") {
		t.Fatal("sweep would issue a delete for an empty key")
	}
}
