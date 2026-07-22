package commands

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
	"github.com/opensandbox/opensandbox/cmd/oc/internal/output"
	"github.com/spf13/cobra"
)

func TestSessionCreateDoesNotExposeRevisionFlag(t *testing.T) {
	if flag := sessionCreateCmd.Flags().Lookup("revision"); flag != nil {
		t.Fatal("session create must not expose unsupported revision selection")
	}
}

func TestSessionGetJSONPreservesCompleteServerResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v3/sessions/ses_test" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"id":"ses_test","status":"idle","agent_id":"agt_test","created_at":"2026-07-22T00:00:00Z",
			"head":7,"input_cursor":7,"last_turn":{"id":"trn_test","state":"ok"},
			"usage":{"active_seconds":3,"reported_turns":1,"unreported_turns":0,"complete":true,"tokens":42},
			"future_field":{"kept":true}
		}`))
	}))
	defer server.Close()

	cmd := &cobra.Command{}
	cmd.SetContext(client.WithSessionsClient(
		context.Background(),
		client.NewSessionsAPI(server.URL, "test-key"),
	))

	previousPrinter, previousJSON := printer, jsonOutput
	var out bytes.Buffer
	printer = output.New(true)
	printer.W = &out
	jsonOutput = true
	defer func() {
		printer = previousPrinter
		jsonOutput = previousJSON
	}()

	if err := sessionGetCmd.RunE(cmd, []string{"ses_test"}); err != nil {
		t.Fatalf("session get: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(out.Bytes(), &got); err != nil {
		t.Fatalf("decode command output: %v\n%s", err, out.String())
	}
	if got["head"] != float64(7) || got["input_cursor"] != float64(7) {
		t.Fatalf("session cursors were dropped: %#v", got)
	}
	if got["usage"].(map[string]any)["tokens"] != float64(42) {
		t.Fatalf("session usage was dropped: %#v", got)
	}
	if got["future_field"].(map[string]any)["kept"] != true {
		t.Fatalf("unknown server fields were dropped: %#v", got)
	}
}

func TestParseSources(t *testing.T) {
	ok := []struct {
		in       []string
		wantRepo []string
		wantRef  []string
	}{
		{[]string{"acme/agents"}, []string{"acme/agents"}, []string{"HEAD"}},
		{[]string{"acme/agents@main"}, []string{"acme/agents"}, []string{"main"}},
		{[]string{"acme/agents@refs/pull/5/head"}, []string{"acme/agents"}, []string{"refs/pull/5/head"}},
		{[]string{"  acme/agents  "}, []string{"acme/agents"}, []string{"HEAD"}},
		{[]string{"acme/agents@"}, []string{"acme/agents"}, []string{"HEAD"}}, // empty ref → HEAD
		{[]string{"a/b", "c/d@dev"}, []string{"a/b", "c/d"}, []string{"HEAD", "dev"}},
		{[]string{"", "  "}, nil, nil}, // blanks skipped
		{nil, nil, nil},
	}
	for _, c := range ok {
		got, err := parseSources(c.in)
		if err != nil {
			t.Fatalf("parseSources(%v) unexpected error: %v", c.in, err)
		}
		if len(got) != len(c.wantRepo) {
			t.Fatalf("parseSources(%v) = %d sources, want %d", c.in, len(got), len(c.wantRepo))
		}
		for i := range got {
			if got[i]["repo"] != c.wantRepo[i] {
				t.Errorf("parseSources(%v)[%d].repo = %v, want %s", c.in, i, got[i]["repo"], c.wantRepo[i])
			}
			if got[i]["ref"] != c.wantRef[i] {
				t.Errorf("parseSources(%v)[%d].ref = %v, want %s", c.in, i, got[i]["ref"], c.wantRef[i])
			}
		}
	}

	bad := [][]string{
		{"notarepo"},         // no slash
		{"owner/repo/extra"}, // two slashes
		{"/repo"},            // leading slash
		{"owner/"},           // trailing slash
	}
	for _, in := range bad {
		if _, err := parseSources(in); err == nil {
			t.Errorf("parseSources(%v) expected an error, got nil", in)
		}
	}
}
