package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// These cover the contract the direct exec path depends on. The whole point of
// runCmdPath is that a caller gets a RESULT rather than a transport error, so
// the cases that matter are the ones where something went wrong in the guest and
// the reply still has to be well-formed JSON with the right exit code.

func postRunCmd(t *testing.T, body string) *httptest.ResponseRecorder {
	t.Helper()
	s := &server{}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, runCmdPath, strings.NewReader(body))
	s.handleRunCmd(rec, req)
	return rec
}

func decodeRunCmd(t *testing.T, rec *httptest.ResponseRecorder) runCmdResponse {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body %q", rec.Code, rec.Body.String())
	}
	var out runCmdResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v (body %q)", err, rec.Body.String())
	}
	return out
}

func TestRunCmdReturnsStdoutAndZeroExit(t *testing.T) {
	out := decodeRunCmd(t, postRunCmd(t, `{"cmd":"echo hello"}`))
	if strings.TrimSpace(out.Stdout) != "hello" {
		t.Fatalf("stdout = %q, want %q", out.Stdout, "hello")
	}
	if out.ExitCode != 0 {
		t.Fatalf("exitCode = %d, want 0", out.ExitCode)
	}
}

// A non-zero exit is a RESULT, not an HTTP error. Returning 500 here would make
// every failing customer command indistinguishable from a broken sandbox, and
// would throw away the output that explains the failure.
func TestNonZeroExitIsStillA200WithOutput(t *testing.T) {
	out := decodeRunCmd(t, postRunCmd(t, `{"cmd":"echo oops >&2; exit 3"}`))
	if out.ExitCode != 3 {
		t.Fatalf("exitCode = %d, want 3", out.ExitCode)
	}
	if strings.TrimSpace(out.Stderr) != "oops" {
		t.Fatalf("stderr = %q, want %q", out.Stderr, "oops")
	}
}

// The deadline has to be reported, because a killed command and a command that
// chose to exit non-zero otherwise look identical to the caller.
func TestTimeoutIsReportedRatherThanHidden(t *testing.T) {
	out := decodeRunCmd(t, postRunCmd(t, `{"cmd":"sleep 5","timeoutSec":1}`))
	if !out.TimedOut {
		t.Fatalf("timedOut = false for a command killed at its deadline (exit %d)", out.ExitCode)
	}
}

// cwd and envs are part of the exec contract the control plane forwards. They
// are carried as real fields precisely so no host-side quoting can mangle them,
// and these two pin that end of it — a path with a space and a value with a
// quote are exactly what a hand-built `cd %s && export %s=%s` gets wrong.
func TestCwdAndEnvAreAppliedWithoutQuoting(t *testing.T) {
	dir := t.TempDir() + "/a dir"
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(runCmdRequest{
		Cmd: `printf '%s|%s' "$PWD" "$OSB_T"`,
		Cwd: dir,
		Env: map[string]string{"OSB_T": `it's "quoted"`},
	})
	out := decodeRunCmd(t, postRunCmd(t, string(body)))
	// Resolved because the host may hand back a symlinked temp dir (macOS
	// /var → /private/var); the guest never does, and the point here is the
	// space and the quote, not the prefix.
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		t.Fatal(err)
	}
	if want := resolved + `|it's "quoted"`; out.Stdout != want {
		t.Fatalf("stdout = %q, want %q", out.Stdout, want)
	}
}

// An explicit env must not replace the guest's own: dropping PATH would break
// every command that names a binary instead of a path.
func TestExplicitEnvKeepsTheInheritedEnvironment(t *testing.T) {
	body, _ := json.Marshal(runCmdRequest{Cmd: `command -v sh >/dev/null && echo found`, Env: map[string]string{"OSB_T": "1"}})
	out := decodeRunCmd(t, postRunCmd(t, string(body)))
	if strings.TrimSpace(out.Stdout) != "found" {
		t.Fatalf("stdout = %q — PATH did not survive an explicit env", out.Stdout)
	}
}

// With args present, cmd is an executable and NOT a shell string — the agent's
// rule. Without this the two paths would disagree on what `echo` even means.
func TestArgsMakeCmdAnExecutable(t *testing.T) {
	body, _ := json.Marshal(runCmdRequest{Cmd: "/bin/echo", Args: []string{"a b", "c"}})
	out := decodeRunCmd(t, postRunCmd(t, string(body)))
	if strings.TrimSpace(out.Stdout) != "a b c" {
		t.Fatalf("stdout = %q, want %q", out.Stdout, "a b c")
	}
}

func TestEmptyCommandIsRejected(t *testing.T) {
	if rec := postRunCmd(t, `{"cmd":"   "}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d for an empty command, want 400", rec.Code)
	}
}

// cappedBuffer must report the FULL write length even when it discards. An
// io.Writer that under-reports makes os/exec treat the capped stream as a short
// write and fail the command — turning "your command printed a lot" into "your
// command did not run".
func TestCappedBufferTruncatesWithoutFailingTheCommand(t *testing.T) {
	b := &cappedBuffer{limit: 4}
	n, err := b.Write([]byte("abcdefgh"))
	if err != nil {
		t.Fatalf("Write returned %v; os/exec aborts the command on a writer error", err)
	}
	if n != 8 {
		t.Fatalf("Write reported %d of 8 bytes — a short write fails the command", n)
	}
	if b.String() != "abcd" {
		t.Fatalf("buffered %q, want %q", b.String(), "abcd")
	}

	out := decodeRunCmd(t, postRunCmd(t, `{"cmd":"head -c 3000000 /dev/zero | tr '\\0' 'x'"}`))
	if out.ExitCode != 0 {
		t.Fatalf("exitCode = %d for an over-cap command, want 0 (stderr %q)", out.ExitCode, out.Stderr)
	}
	if len(out.Stdout) != runCmdMaxOutput {
		t.Fatalf("stdout = %d bytes, want the cap %d", len(out.Stdout), runCmdMaxOutput)
	}
}
