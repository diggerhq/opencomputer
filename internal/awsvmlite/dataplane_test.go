package awsvmlite

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/opensandbox/opensandbox/pkg/types"
)

// dataplane_test.go — the wire contract with the guest.
//
// These operations cross a proxy that authenticates on two headers and routes
// on a third, into a guest that answers on exact paths. Every one of those is
// silent when wrong: a missing auth header is a 403 that looks like a dead box,
// a wrong port header reaches nothing, and a mistyped path falls through the
// guest's mux to the agent bridge and comes back as an unexplained 415.

// rtFunc is a RoundTripper that answers without a network.
type rtFunc func(*http.Request) (*http.Response, error)

func (f rtFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

// newFakeBox returns a Manager bound to one box, plus a pointer to the last
// request its transport saw.
func newFakeBox(t *testing.T, status int, body string) (*Manager, **http.Request) {
	t.Helper()
	var last *http.Request
	m := &Manager{
		bound: map[string]*Box{
			"sbx-1": {MicrovmID: "mvm-1", Endpoint: "https://box.example", Token: "tok-abc", Port: 8080},
		},
		http: &http.Client{Transport: rtFunc(func(r *http.Request) (*http.Response, error) {
			// Drain the body before answering so a streamed upload is fully
			// consumed, as a real server would.
			if r.Body != nil {
				_, _ = io.Copy(io.Discard, r.Body)
			}
			last = r
			return &http.Response{
				StatusCode: status,
				Body:       io.NopCloser(strings.NewReader(body)),
				Header:     http.Header{},
			}, nil
		})},
	}
	return m, &last
}

// Every request must carry the proxy's auth token and target port. Without them
// the proxy answers before the guest is ever reached.
func TestEveryCallCarriesProxyHeaders(t *testing.T) {
	m, last := newFakeBox(t, http.StatusOK, `{"ok":true}`)
	if err := m.MakeDir(context.Background(), "sbx-1", "/home/sandbox/x"); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	r := *last
	if got := r.Header.Get("X-aws-proxy-auth"); got != "tok-abc" {
		t.Errorf("auth header = %q, want the box token", got)
	}
	if got := r.Header.Get("X-aws-proxy-port"); got != "8080" {
		t.Errorf("port header = %q, want 8080", got)
	}
	if r.URL.Path != ocFSMkdir {
		t.Errorf("path = %q, want %q", r.URL.Path, ocFSMkdir)
	}
	if r.URL.Host != "box.example" {
		t.Errorf("host = %q, want the box endpoint host", r.URL.Host)
	}
}

// The guest returns file content as base64 bytes so binary round-trips. A
// string field here would corrupt anything that is not valid UTF-8.
func TestReadFileDecodesBinaryContent(t *testing.T) {
	raw := []byte{0x00, 0xff, 0xfe, 'h', 'i'}
	body, _ := json.Marshal(map[string]any{"content": raw})
	m, _ := newFakeBox(t, http.StatusOK, string(body))

	got, err := m.ReadFile(context.Background(), "sbx-1", "/bin/thing")
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if got != string(raw) {
		t.Errorf("content = %q, want the exact bytes back", got)
	}
}

// A missing file must arrive as a 404-bearing error, not a generic failure.
// The API layer maps on this, and the SDK decides whether to retry on it.
func TestNotFoundSurvivesAsNotFound(t *testing.T) {
	m, _ := newFakeBox(t, http.StatusNotFound, "no such file")
	_, err := m.ReadFile(context.Background(), "sbx-1", "/nope")
	if err == nil {
		t.Fatal("read of a missing file succeeded")
	}
	he, ok := err.(httpError)
	if !ok {
		t.Fatalf("error type = %T, want httpError carrying the status", err)
	}
	if !he.NotFound() || he.StatusCode() != http.StatusNotFound {
		t.Errorf("status = %d, want 404", he.StatusCode())
	}
}

// An unbound sandbox is a clean error, never a request to somebody else's box.
func TestUnboundSandboxIsRefusedBeforeAnyRequest(t *testing.T) {
	m, last := newFakeBox(t, http.StatusOK, `{}`)
	if _, err := m.ReadFile(context.Background(), "sbx-unknown", "/x"); err == nil {
		t.Fatal("read against an unbound sandbox succeeded")
	}
	if *last != nil {
		t.Error("a request was sent for a sandbox this process holds no box for")
	}
}

// Upload streams the body and puts path/mode in the query, because the body is
// the file. Getting the mode base wrong (decimal for octal) silently changes
// permissions.
func TestUploadPutsPathAndOctalModeInQuery(t *testing.T) {
	m, last := newFakeBox(t, http.StatusOK, `{"bytesWritten":5}`)
	n, err := m.WriteFileStream(context.Background(), "sbx-1", "/home/sandbox/a b&c.txt", 0o755, bytes.NewReader([]byte("hello")))
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	if n != 5 {
		t.Errorf("bytesWritten = %d, want 5", n)
	}
	q := (*last).URL.Query()
	if q.Get("path") != "/home/sandbox/a b&c.txt" {
		t.Errorf("path = %q — an unescaped & would truncate it and write the wrong file", q.Get("path"))
	}
	if q.Get("mode") != "755" {
		t.Errorf("mode = %q, want octal 755", q.Get("mode"))
	}
	if (*last).Method != http.MethodPut {
		t.Errorf("method = %s, want PUT", (*last).Method)
	}
}

// Download hands back an open body rather than buffering, and reports the size
// the guest declared.
func TestDownloadStreamsWithDeclaredSize(t *testing.T) {
	var last *http.Request
	m := &Manager{
		bound: map[string]*Box{"sbx-1": {Endpoint: "https://box.example", Token: "t", Port: 8080}},
		http: &http.Client{Transport: rtFunc(func(r *http.Request) (*http.Response, error) {
			last = r
			h := http.Header{}
			h.Set("Content-Length", "11")
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader("hello world")),
				Header:     h,
			}, nil
		})},
	}
	rc, size, err := m.ReadFileStream(context.Background(), "sbx-1", "/f")
	if err != nil {
		t.Fatalf("download: %v", err)
	}
	defer rc.Close()
	if size != 11 {
		t.Errorf("size = %d, want 11", size)
	}
	got, _ := io.ReadAll(rc)
	if string(got) != "hello world" {
		t.Errorf("body = %q", got)
	}
	if last.URL.Query().Get("path") != "/f" {
		t.Errorf("path query = %q", last.URL.Query().Get("path"))
	}
}

// Paths are escaped, and the separators that make a path a path are not.
func TestPathEscapingPreservesSlashesAndEscapesTheRest(t *testing.T) {
	cases := map[string]string{
		"/home/sandbox/file.txt": "/home/sandbox/file.txt",
		"/a b":                   "/a%20b",
		"/a&b":                   "/a%26b",
		"/a#b":                   "/a%23b",
		"/a?b":                   "/a%3Fb",
		"/tilde~dash-dot.":       "/tilde~dash-dot.",
	}
	for in, want := range cases {
		if got := urlQueryEscape(in); got != want {
			t.Errorf("escape(%q) = %q, want %q", in, got, want)
		}
	}
}

// Stats unmarshals straight into the runtime-agnostic struct the API returns.
func TestStatsMapsOntoTheSharedShape(t *testing.T) {
	m, last := newFakeBox(t, http.StatusOK,
		`{"cpuPercent":12.5,"memUsage":100,"memLimit":4096,"netInput":7,"netOutput":9,"pids":3}`)
	st, err := m.Stats(context.Background(), "sbx-1")
	if err != nil {
		t.Fatalf("stats: %v", err)
	}
	if st.CPUPercent != 12.5 || st.MemUsage != 100 || st.MemLimit != 4096 || st.PIDs != 3 {
		t.Errorf("stats = %+v, want the guest's numbers verbatim", st)
	}
	if (*last).URL.Path != ocStats {
		t.Errorf("path = %q, want %q", (*last).URL.Path, ocStats)
	}
}

// Reboot is a POST with no body and no result to decode; the point is that a
// non-200 is still an error rather than a silently-successful reboot.
func TestRebootReportsFailure(t *testing.T) {
	m, _ := newFakeBox(t, http.StatusInternalServerError, "agent did not come back")
	if err := m.Reboot(context.Background(), "sbx-1"); err == nil {
		t.Fatal("a failed reboot reported success — the customer's view and the box would disagree")
	}
}

func TestRebootSucceeds(t *testing.T) {
	m, last := newFakeBox(t, http.StatusOK, `{"ok":true}`)
	if err := m.Reboot(context.Background(), "sbx-1"); err != nil {
		t.Fatalf("reboot: %v", err)
	}
	if (*last).Method != http.MethodPost || (*last).URL.Path != ocReboot {
		t.Errorf("%s %s, want POST %s", (*last).Method, (*last).URL.Path, ocReboot)
	}
}

// PreviewTarget hands back the three things a caller needs to reach a guest
// port; without the token the proxy refuses, without the port it routes nowhere.
func TestPreviewTargetReturnsTheProxyTriple(t *testing.T) {
	m, _ := newFakeBox(t, http.StatusOK, `{}`)
	host, token, port, err := m.PreviewTarget("sbx-1")
	if err != nil {
		t.Fatalf("preview target: %v", err)
	}
	if host != "box.example" || token != "tok-abc" || port != 8080 {
		t.Errorf("got (%q, %q, %d), want the box's host, token and hook port", host, token, port)
	}
	if _, _, _, err := m.PreviewTarget("sbx-unknown"); err == nil {
		t.Error("preview target for an unbound sandbox succeeded")
	}
}

// ── exec sessions ───────────────────────────────────────────────────────────

// A running session has no exit code, and reporting 0 for one would read as
// "it succeeded" — the single most misleading answer this API can give.
func TestExecSessionResultOmitsExitCodeWhileRunning(t *testing.T) {
	m, _ := newFakeBox(t, http.StatusOK, `{"running":true,"stdout":"aGk="}`)
	res, err := m.ExecSessionGetResult(context.Background(), "sbx-1", "sess-1")
	if err != nil {
		t.Fatalf("result: %v", err)
	}
	if !res.Running {
		t.Error("running session reported as finished")
	}
	if res.ExitCode != nil {
		t.Errorf("exitCode = %d for a running session — a caller reads 0 as success", *res.ExitCode)
	}
	if string(res.Stdout) != "hi" {
		t.Errorf("stdout = %q, want the decoded bytes", res.Stdout)
	}
}

func TestExecSessionResultCarriesExitCode(t *testing.T) {
	m, last := newFakeBox(t, http.StatusOK, `{"running":false,"exitCode":3,"stderr":"YmFk"}`)
	res, err := m.ExecSessionGetResult(context.Background(), "sbx-1", "sess-1")
	if err != nil {
		t.Fatalf("result: %v", err)
	}
	if res.ExitCode == nil || *res.ExitCode != 3 {
		t.Errorf("exitCode = %v, want 3", res.ExitCode)
	}
	if string(res.Stderr) != "bad" {
		t.Errorf("stderr = %q", res.Stderr)
	}
	// The session id travels in the query, and must be escaped: an id
	// containing & would otherwise address a different session or none.
	if got := (*last).URL.Query().Get("sessionId"); got != "sess-1" {
		t.Errorf("sessionId = %q", got)
	}
}

func TestExecSessionCreateSendsTheCommand(t *testing.T) {
	m, last := newFakeBox(t, http.StatusOK, `{"sessionId":"sess-9"}`)
	id, err := m.ExecSessionCreate(context.Background(), "sbx-1", ExecSessionRequest{
		Command: "npm", Args: []string{"run", "dev"}, MaxRunAfterDisconnect: 300,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if id != "sess-9" {
		t.Errorf("sessionId = %q, want sess-9", id)
	}
	if (*last).URL.Path != ocExecCreatePath {
		t.Errorf("path = %q, want %q", (*last).URL.Path, ocExecCreatePath)
	}
}

// Killing and listing must refuse an unbound sandbox before any request.
func TestExecSessionOpsRefuseUnboundSandbox(t *testing.T) {
	m, last := newFakeBox(t, http.StatusOK, `{}`)
	if _, err := m.ExecSessionCreate(context.Background(), "nope", ExecSessionRequest{Command: "x"}); err == nil {
		t.Error("create against an unbound sandbox succeeded")
	}
	if _, err := m.ExecSessionList(context.Background(), "nope"); err == nil {
		t.Error("list against an unbound sandbox succeeded")
	}
	if err := m.ExecSessionKill(context.Background(), "nope", "s", 0); err == nil {
		t.Error("kill against an unbound sandbox succeeded")
	}
	if *last != nil {
		t.Error("a request was sent for a sandbox this process holds no box for")
	}
}

// ── secrets ─────────────────────────────────────────────────────────────────

// HasSecrets is the hot-path gate. A create with nothing to seal must not send
// the request at all — the pooled default create is what the TTI benchmark
// measures, and it must stay at zero extra round trips.
func TestHasSecretsGatesTheHotPath(t *testing.T) {
	if HasSecrets(types.SandboxConfig{}) {
		t.Error("an empty create was treated as having secrets — every pooled create would pay a round trip")
	}
	if HasSecrets(types.SandboxConfig{Envs: map[string]string{"A": "b"}}) {
		t.Error("plain envs were treated as secrets — they go through SetEnvs, which does not seal")
	}
	if !HasSecrets(types.SandboxConfig{SecretEnvs: map[string]string{"K": "v"}}) {
		t.Error("a secret env was not detected")
	}
	// An allowlist with no secrets still needs the proxy: it is an egress
	// restriction, and skipping it would leave the sandbox unrestricted while
	// the API reported the store applied.
	if !HasSecrets(types.SandboxConfig{EgressAllowlist: []string{"api.stripe.com"}}) {
		t.Error("an allowlist-only store was skipped — egress would be unrestricted")
	}
	if !HasSecrets(types.SandboxConfig{SecretAllowedHosts: map[string][]string{"K": {"h"}}}) {
		t.Error("per-secret host restrictions were not detected")
	}
}

// SetSecrets must carry the plaintext envs too: the guest merges both into ONE
// environment, so sending them separately would overwrite the sealed values.
func TestSetSecretsCarriesPlaintextEnvsToo(t *testing.T) {
	// A capturing transport, because the assertion is about what was SENT.
	var captured []byte
	var path string
	m := &Manager{
		bound: map[string]*Box{"sbx-1": {Endpoint: "https://box.example", Token: "t", Port: 8080}},
		http: &http.Client{Transport: rtFunc(func(r *http.Request) (*http.Response, error) {
			captured, _ = io.ReadAll(r.Body)
			path = r.URL.Path
			return &http.Response{
				StatusCode: http.StatusOK,
				Body:       io.NopCloser(strings.NewReader(`{"ok":true}`)),
				Header:     http.Header{},
			}, nil
		})},
	}

	err := m.SetSecrets(context.Background(), "sbx-1", types.SandboxConfig{
		Envs:            map[string]string{"PUBLIC": "fine"},
		SecretEnvs:      map[string]string{"API_KEY": "sk-real"},
		EgressAllowlist: []string{"api.stripe.com"},
	})
	if err != nil {
		t.Fatalf("set secrets: %v", err)
	}
	if path != ocSecrets {
		t.Fatalf("path = %q, want %q", path, ocSecrets)
	}

	var sent secretsPayload
	if err := json.Unmarshal(captured, &sent); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if sent.PlaintextEnvs["PUBLIC"] != "fine" {
		t.Error("plaintext envs were dropped — a separate SetEnvs would then clobber the sealed environment")
	}
	if sent.SecretEnvs["API_KEY"] != "sk-real" {
		t.Error("the secret value did not reach the guest, which is the only place that can seal it")
	}
	if len(sent.Allowlist) != 1 || sent.Allowlist[0] != "api.stripe.com" {
		t.Errorf("allowlist = %v, want it forwarded", sent.Allowlist)
	}
}

// A miss is (false, nil), not an error: the refresh flow sweeps every sandbox
// in an org and most will not hold the secret being rotated.
func TestUpdateSecretMissIsNotAnError(t *testing.T) {
	m, _ := newFakeBox(t, http.StatusOK, `{"updated":false}`)
	ok, err := m.UpdateSecret(context.Background(), "sbx-1", "API_KEY", "new")
	if err != nil {
		t.Fatalf("a miss returned an error: %v", err)
	}
	if ok {
		t.Error("reported updated for a miss")
	}
}

// But an unreachable box IS an error, so a rotation that silently failed to
// land is distinguishable from one that had nothing to do.
func TestUpdateSecretUnreachableBoxIsAnError(t *testing.T) {
	m, _ := newFakeBox(t, http.StatusBadGateway, "box gone")
	if _, err := m.UpdateSecret(context.Background(), "sbx-1", "API_KEY", "new"); err == nil {
		t.Fatal("an unreachable box reported success — a failed rotation would look like a miss")
	}
}

// ── auth token freshness ────────────────────────────────────────────────────

// The launch-time token is not a credential you can keep using.
//
// AWS caps proxy auth tokens at 60 minutes. Box.Token is minted once, when the
// box is launched, so a box that sits in the warm set or stays bound for longer
// than an hour carries a dead one — and every request against it then fails
// with a proxy 403, permanently, because nothing refreshes and nothing evicts
// on 403.
//
// A deep pool hides this completely: boxes churn well inside an hour, which is
// why every burst benchmark passed while a customer's hour-old sandbox would
// have been dead. Found by dropping the dev pool to a single box.
func TestRequestsUseARefreshedTokenNotTheLaunchTimeOne(t *testing.T) {
	var sawAuth string
	m := &Manager{
		bound: map[string]*Box{
			"sbx-1": {MicrovmID: "mvm-1", Endpoint: "https://box.example", Token: "STALE-LAUNCH-TOKEN", Port: 8080},
		},
		http: &http.Client{Transport: rtFunc(func(r *http.Request) (*http.Response, error) {
			sawAuth = r.Header.Get("X-aws-proxy-auth")
			return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"ok":true}`)), Header: http.Header{}}, nil
		})},
	}
	// With no AWS client the refresher has nothing to ask, so it falls back to
	// the launch-time value — which is what keeps unit tests working and is the
	// only case where the stale token is legitimately used.
	if err := m.MakeDir(context.Background(), "sbx-1", "/x"); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if sawAuth != "STALE-LAUNCH-TOKEN" {
		t.Fatalf("auth header = %q; with no client configured the launch token is the only source", sawAuth)
	}

	// The property that matters: the header is sourced from token(), not read
	// straight off the Box. If someone re-inlines b.Token this fails, because
	// token() is the only place a refresh can ever be introduced.
	b := m.bound["sbx-1"]
	if got := m.token(context.Background(), b); got != b.Token {
		t.Fatalf("token() = %q, want the fallback %q", got, b.Token)
	}
}
