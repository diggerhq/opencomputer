package commands

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/output"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// stub feedback.now receiver: serves discovery pointing at itself and records
// the last submission body + headers.
type feedbackStub struct {
	srv      *httptest.Server
	lastPath string
	lastBody map[string]any
	lastHdr  http.Header
}

func newFeedbackStub(t *testing.T) *feedbackStub {
	t.Helper()
	s := &feedbackStub{}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/agent-feedback.json", func(w http.ResponseWriter, _ *http.Request) {
		// Relative + absolute URLs mixed on purpose: the emitter must resolve both.
		json.NewEncoder(w).Encode(map[string]any{
			"schema_version": "1.1",
			"name":           "Stub",
			"policy_url":     "/api/v1/policy",
			"endpoints": map[string]any{
				"feedback":     map[string]any{"submit": map[string]any{"method": "POST", "url": "/custom/feedback"}},
				"observations": map[string]any{"submit": map[string]any{"method": "POST", "url": s.srv.URL + "/custom/obs"}},
				"receipts":     map[string]any{"get": map[string]any{"method": "GET", "url": "/custom/receipts/{id}"}},
			},
		})
	})
	mux.HandleFunc("/api/v1/policy", func(w http.ResponseWriter, _ *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"categories": []string{"bug"}, "severity_levels": []string{"low"}, "evidence_types": []string{"other"}})
	})
	record := func(w http.ResponseWriter, r *http.Request) {
		s.lastPath = r.URL.Path
		s.lastHdr = r.Header.Clone()
		raw, _ := io.ReadAll(r.Body)
		s.lastBody = nil
		_ = json.Unmarshal(raw, &s.lastBody)
		if sig := r.Header.Get("X-Agent-Signature"); sig != "" {
			if !verifySig(r, raw) {
				w.WriteHeader(401)
				return
			}
		}
		if r.URL.Path == "/custom/feedback" {
			if _, ok := s.lastBody["content"].(map[string]any)["title"]; !ok {
				w.WriteHeader(400)
				json.NewEncoder(w).Encode(map[string]any{"error": "validation_failed", "errors": []map[string]any{{"field": "content.title", "error": "required", "message": "title is required"}}})
				return
			}
		}
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(map[string]any{"receipt": map[string]any{"id": "rcpt_1", "status": "accepted", "feedback_id": "fb_1"}})
	}
	mux.HandleFunc("/custom/feedback", record)
	mux.HandleFunc("/custom/obs", record)
	mux.HandleFunc("/custom/receipts/", func(w http.ResponseWriter, r *http.Request) {
		s.lastPath = r.URL.Path
		json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"id": strings.TrimPrefix(r.URL.Path, "/custom/receipts/"), "status": "duplicate", "duplicate_of": "fb_0"}})
	})
	s.srv = httptest.NewServer(mux)
	t.Cleanup(s.srv.Close)
	return s
}

func verifySig(r *http.Request, body []byte) bool {
	spki, err := base64.StdEncoding.DecodeString(r.Header.Get("X-Agent-Key"))
	if err != nil {
		return false
	}
	pubAny, err := x509.ParsePKIXPublicKey(spki)
	if err != nil {
		return false
	}
	pub, ok := pubAny.(ed25519.PublicKey)
	if !ok {
		return false
	}
	sig, err := base64.StdEncoding.DecodeString(r.Header.Get("X-Agent-Signature"))
	if err != nil {
		return false
	}
	sum := sha256.Sum256(body)
	payload := strings.Join([]string{r.Header.Get("X-Agent-Timestamp"), r.Method, r.URL.Path, hex.EncodeToString(sum[:])}, "\n")
	return ed25519.Verify(pub, []byte(payload), sig)
}

func runFeedback(t *testing.T, args ...string) (string, error) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("OPENCOMPUTER_API_KEY", "")
	t.Setenv("OC_NO_UPDATE_CHECK", "1")
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	oldStdout := os.Stdout
	os.Stdout = w
	printer = output.New(false)
	printer.W = w
	rootCmd.SetArgs(append([]string{"feedback"}, args...))
	runErr := rootCmd.Execute()
	os.Stdout = oldStdout
	w.Close()
	out, _ := io.ReadAll(r)
	// cobra keeps parsed flag values across Execute calls in one process;
	// restore defaults so tests don't leak --target/--title into each other.
	for _, c := range append([]*cobra.Command{feedbackCmd}, feedbackCmd.Commands()...) {
		for _, fs := range []*pflag.FlagSet{c.PersistentFlags(), c.Flags()} {
			fs.VisitAll(func(f *pflag.Flag) {
				if f.Changed && f.Value.Type() != "stringArray" {
					_ = f.Value.Set(f.DefValue)
					f.Changed = false
				}
			})
		}
	}
	return string(out), runErr
}

func TestFeedbackSubmitDiscoversEndpointAndSendsSpecShape(t *testing.T) {
	stub := newFeedbackStub(t)
	out, err := runFeedback(t, "submit", "--target", stub.srv.URL,
		"--surface", "POST /api/sandboxes", "--category", "bug", "--severity", "high",
		"--title", "boom", "--summary", "expected 404", "--reproducibility", "always",
		"--evidence", "http_summary={\"status\":500}")
	if err != nil {
		t.Fatalf("submit: %v", err)
	}
	if stub.lastPath != "/custom/feedback" {
		t.Fatalf("did not follow discovery url, got %s", stub.lastPath)
	}
	if stub.lastHdr.Get("X-Agent-Signature") != "" {
		t.Fatal("unsigned submission should carry no signature")
	}
	rep := stub.lastBody["reporter"].(map[string]any)
	if rep["agent_vendor"] != "opencomputer" || rep["agent_product"] != "oc-cli" {
		t.Fatalf("reporter = %v", rep)
	}
	subj := stub.lastBody["subject"].(map[string]any)
	if subj["surface"] != "POST /api/sandboxes" || subj["domain"] != "127.0.0.1" {
		t.Fatalf("subject = %v", subj)
	}
	sig := stub.lastBody["signal"].(map[string]any)
	if sig["category"] != "bug" || sig["severity"] != "high" || sig["reproducibility"] != "always" || sig["confidence"] != 0.7 {
		t.Fatalf("signal = %v", sig)
	}
	ev := stub.lastBody["evidence"].([]any)
	if len(ev) != 1 || ev[0].(map[string]any)["type"] != "http_summary" {
		t.Fatalf("evidence = %v", ev)
	}
	if !strings.Contains(out, "Receipt:  rcpt_1") || !strings.Contains(out, "Feedback: fb_1") {
		t.Fatalf("output = %q", out)
	}
}

func TestFeedbackSubmitSignsWithEd25519(t *testing.T) {
	stub := newFeedbackStub(t)
	keyPath := filepath.Join(t.TempDir(), "agent.pem")
	if _, err := runFeedback(t, "keygen", "--out", keyPath); err != nil {
		t.Fatalf("keygen: %v", err)
	}
	if _, err := runFeedback(t, "submit", "--target", stub.srv.URL, "--signing-key", keyPath,
		"--surface", "s", "--category", "bug", "--severity", "low", "--title", "t"); err != nil {
		t.Fatalf("signed submit rejected by stub verifier: %v", err)
	}
	if stub.lastHdr.Get("X-Agent-Key") == "" || stub.lastHdr.Get("X-Agent-Timestamp") == "" {
		t.Fatal("missing signing headers")
	}
}

func TestFeedbackObserveUsesAbsoluteDiscoveryURL(t *testing.T) {
	stub := newFeedbackStub(t)
	if _, err := runFeedback(t, "observe", "--target", stub.srv.URL, "--surface", "oc sandbox create", "--category", "friction", "--domain", "example.test"); err != nil {
		t.Fatalf("observe: %v", err)
	}
	if stub.lastPath != "/custom/obs" {
		t.Fatalf("path = %s", stub.lastPath)
	}
	if stub.lastBody["domain"] != "example.test" || stub.lastBody["agent_product"] != "oc-cli" || stub.lastBody["category"] != "friction" {
		t.Fatalf("body = %v", stub.lastBody)
	}
	if _, has := stub.lastBody["confidence"]; has {
		t.Fatal("confidence should be omitted when not passed")
	}
}

func TestFeedbackReceiptAndValidationErrors(t *testing.T) {
	stub := newFeedbackStub(t)
	out, err := runFeedback(t, "receipt", "rcpt_9", "--target", stub.srv.URL)
	if err != nil {
		t.Fatalf("receipt: %v", err)
	}
	if stub.lastPath != "/custom/receipts/rcpt_9" || !strings.Contains(out, "duplicate") || !strings.Contains(out, "fb_0") {
		t.Fatalf("path=%s out=%q", stub.lastPath, out)
	}

	_, err = runFeedback(t, "submit", "--target", stub.srv.URL, "--surface", "s", "--category", "bug", "--severity", "low")
	if err == nil || !strings.Contains(err.Error(), "--title") {
		t.Fatalf("expected local required-flag error, got %v", err)
	}

	_, err = runFeedback(t, "submit", "--target", "http://127.0.0.1:9", "--surface", "s", "--category", "bug", "--severity", "low", "--title", "t")
	if err == nil || !strings.Contains(err.Error(), "does not advertise feedback.now") {
		t.Fatalf("expected discovery failure, got %v", err)
	}
}

func TestParseEvidenceFlags(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "err.log")
	os.WriteFile(p, []byte("stack trace"), 0o600)
	ev, err := parseEvidenceFlags([]string{"stderr_excerpt=@" + p, "other=a=b"})
	if err != nil {
		t.Fatal(err)
	}
	if ev[0]["content"] != "stack trace" || ev[1]["type"] != "other" || ev[1]["content"] != "a=b" {
		t.Fatalf("ev = %v", ev)
	}
	if _, err := parseEvidenceFlags([]string{"nope"}); err == nil {
		t.Fatal("expected error for missing =")
	}
}
