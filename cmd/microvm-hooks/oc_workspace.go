package main

// oc_workspace.go — archiving the customer's work out of the guest, and back in.
//
// This is the primitive behind checkpoints on this runtime, and it is the only
// kind of checkpoint the service can support: there is no way to snapshot a
// running MicroVM into an image we control (an image is BUILT through an API,
// not captured), so a checkpoint here is the workspace, not the machine.
//
// Streamed both ways, deliberately. The agent path's equivalent execs `tar czf`
// to a file in /tmp and then reads the file back out — which needs the archive
// to fit on the guest's disk ALONGSIDE the data it just archived, and doubles
// the time. Piping tar's stdout straight into the HTTP response costs neither.
//
// What survives: everything under /home/sandbox. What does not: anything the
// customer installed elsewhere at runtime, and all process/memory state. That
// is a real difference from a QEMU checkpoint and belongs in the docs, not in a
// comment nobody reads — but it is also the part customers actually fork.

import (
	"log"
	"net/http"
	"os"
	"os/exec"
)

const (
	ocWorkspaceExport = ocPrefix + "workspace/export"
	ocWorkspaceImport = ocPrefix + "workspace/import"

	// workspaceDir is the customer's working directory — where commands run and
	// where relative paths land.
	workspaceDir = sandboxHomeDir
)

// archiveRoots are the paths a checkpoint captures, relative to /.
//
// JUST THE WORKSPACE, and the reason is worth recording because the obvious
// improvement is wrong here.
//
// Widening this to /usr/local and /opt looks compelling — that is where things
// built from source and dropped-in binaries land, and capturing them would make
// a template carry a customer's whole environment rather than just their files.
// It was tried, on dev, and measured:
//
//   - The customer CANNOT WRITE to either path. Both are root-owned, commands
//     run as the unprivileged sandbox user, and sudo cannot elevate because the
//     MicroVM runs with no_new_privs set. So there is nothing of theirs there
//     to capture — the same platform constraint that makes FUSE mounts
//     impossible.
//   - It captured OUR files instead. /usr/local/bin holds rclone, so every
//     customer checkpoint grew from 603 bytes to 48 MB of base image, and a
//     restore would have overwritten our own binaries with a stale copy.
//
// The way to let a customer keep an installed toolchain is therefore to put the
// toolchain INSIDE the workspace — see the user-space install defaults in the
// image (PATH, npm prefix, PIP_USER), which land everything under
// /home/sandbox/.local and are captured by this archive for free.
var archiveRoots = []string{"home/sandbox"}

// existingRoots filters archiveRoots to what is actually present. tar fails the
// whole archive on a missing member, and /opt is legitimately absent on a fresh
// box.
func existingRoots() []string {
	out := make([]string, 0, len(archiveRoots))
	for _, r := range archiveRoots {
		if _, err := os.Stat("/" + r); err == nil {
			out = append(out, r)
		}
	}
	return out
}

// ocWorkspaceExport streams a gzipped tar of the archived roots.
//
// Rooted at / with explicit members, so the archive carries paths like
// `home/sandbox/...` and `usr/local/...` and a restore puts each one back where
// it came from. The previous format was `-C /home/sandbox .`, which produced
// bare `./...` entries — those two are NOT interchangeable, which is why the
// storage key changed with the format (see WorkspaceKey): extracting an old
// archive under the new importer would scatter a customer's home directory
// across /.
func (s *server) ocWorkspaceExport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	roots := existingRoots()
	if len(roots) == 0 {
		http.Error(w, "export: nothing to archive", http.StatusInternalServerError)
		return
	}
	args := append([]string{"czf", "-", "-C", "/"}, roots...)
	cmd := exec.CommandContext(r.Context(), "tar", args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		http.Error(w, "export: "+err.Error(), http.StatusInternalServerError)
		return
	}
	// Captured rather than inherited: tar writes "file changed as we read it" to
	// stderr for anything the customer touches mid-archive, and that is a
	// warning, not a failure. Letting it reach the response would corrupt the
	// archive; letting it reach the container log unread would hide real errors.
	var stderr capBuffer
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		http.Error(w, "export: "+err.Error(), http.StatusInternalServerError)
		return
	}
	// Headers before the first byte, and no Content-Length: the size is not
	// known until tar finishes, and a chunked body is exactly what the proxy
	// forwards unchanged.
	w.Header().Set("Content-Type", "application/gzip")
	w.WriteHeader(http.StatusOK)

	n, copyErr := copyFlush(w, stdout)
	waitErr := cmd.Wait()
	if copyErr != nil || waitErr != nil {
		// The status is already 200 and bytes are on the wire, so nothing can be
		// signalled to the caller here. Logged loudly because a truncated
		// archive that nobody notices is a checkpoint that silently loses data —
		// the caller's own size check is what catches it.
		log.Printf("microvm-hooks: workspace export FAILED after %d bytes: copy=%v wait=%v stderr=%s",
			n, copyErr, waitErr, stderr.String())
		return
	}
	log.Printf("microvm-hooks: workspace export ok (%d bytes)", n)
}

// ocWorkspaceImport extracts a gzipped tar into the workspace.
//
// Additive, not a replacement: tar overwrites what the archive contains and
// leaves everything else alone. That is the behaviour a restore wants — a
// checkpoint carries what existed when it was taken, and wiping the directory
// first would delete files created since, on a box the customer is still using.
func (s *server) ocWorkspaceImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPut && r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// --no-same-owner: this process is root, so tar would otherwise restore the
	// uids recorded in the archive. They come from the same image and would
	// normally match, but "normally" is doing too much work for something that
	// silently hands the customer files they cannot write. Ownership is fixed up
	// below instead.
	cmd := exec.CommandContext(r.Context(), "tar", "xzf", "-", "-C", "/", "--no-same-owner")
	cmd.Stdin = r.Body
	var stderr capBuffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		log.Printf("microvm-hooks: workspace import failed: %v (%s)", err, stderr.String())
		http.Error(w, "import: "+err.Error()+": "+stderr.String(), http.StatusInternalServerError)
		return
	}
	// The customer's code runs as `sandbox`; a workspace it cannot write is
	// worse than no restore at all, because it fails later and somewhere else.
	// Only the workspace is chowned. /usr/local and /opt stay root-owned, which
	// is what they are on a fresh box — handing the sandbox user write access to
	// them would let a restore quietly widen its own privileges.
	if out, err := exec.Command("chown", "-R", "sandbox:sandbox", workspaceDir).CombinedOutput(); err != nil {
		log.Printf("microvm-hooks: workspace import: chown: %v (%s)", err, out)
		http.Error(w, "import: chown failed", http.StatusInternalServerError)
		return
	}
	log.Printf("microvm-hooks: workspace import ok")
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}
