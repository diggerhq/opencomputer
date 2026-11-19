package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The shipped profiles load from a directory as the proxy loads them.
func TestShippedProfiles(t *testing.T) {
	ps, err := loadProfiles("profiles")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, p := range ps.sorted {
		names = append(names, p.name)
		if len(p.vars) != 1 || p.vars[0] != "token" || p.perKey != nil || len(p.harness) != 1 {
			t.Errorf("%s: vars %v harness %v", p.name, p.vars, p.harness)
		}
	}
	if got := strings.Join(names, " "); got != "anthropic-key claude-oauth openai-key openrouter" {
		t.Fatalf("profiles %q", got)
	}
	or := ps.get("openrouter")
	if or.url.Host != "openrouter.ai" || or.url.Path != "/api" {
		t.Fatalf("openrouter upstream %v", or.url)
	}
	oa := ps.get("openai-key")
	if ws := oa.routes["WS /v1/responses"]; ws == nil || !ws.ws || ws.name != "responses_ws" || ws.respName != "responses" || !ws.responses {
		t.Fatalf("WS route %+v", ws)
	}
	if r := oa.routes["POST /v1/responses"]; !r.responses || r.name != "responses" || oa.routes["GET /v1/models"].responses {
		t.Fatalf("formats %+v", r)
	}
	if r := ps.get("claude-oauth").routes["POST /v1/messages/count_tokens"]; r.name != "count_tokens" || len(r.require) != 3 || r.responses {
		t.Fatalf("route %+v", r)
	}
}

func TestLoadProfilesErrors(t *testing.T) {
	const ok = `{"upstream":"https://a.example","routes":{"POST /v1/messages":{}}}`
	write := func(files map[string]string) string {
		dir := t.TempDir()
		for name, body := range files {
			if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		return dir
	}
	for _, c := range []struct {
		name, want string
		files      map[string]string
	}{
		{"empty directory", "no profiles", nil},
		{"only other files", "no profiles", map[string]string{"a.txt": "{}"}},
		{"a name twice", "already defined", map[string]string{"a.json": `{"p":` + ok + `}`, "b.json": `{"p":` + ok + `}`}},
		{"an unknown field", "unknown field", map[string]string{"a.json": `{"p":{"upstream":"https://a.example","routes":{"POST /x":{}},"sets":{}}}`}},
		{"an unknown route field", "unknown field", map[string]string{"a.json": `{"p":{"upstream":"https://a.example","routes":{"POST /x":{"too":"/y"}}}}`}},
		{"not JSON", "a.json", map[string]string{"a.json": `{`}},
		{"a bad profile", `profile "p"`, map[string]string{"a.json": `{"p":{"upstream":"http://a.example","routes":{"POST /x":{}}}}`}},
	} {
		if _, err := loadProfiles(write(c.files)); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v, want %q", c.name, err, c.want)
		}
	}
	ps, err := loadProfiles(write(map[string]string{"a.json": `{"p":` + ok + `}`, "b.json": `{"q":` + ok + `}`}))
	if err != nil || len(ps.sorted) != 2 {
		t.Fatalf("two files: %v", err)
	}
}

func TestCompileProfileErrors(t *testing.T) {
	routes := map[string]routeJSON{"POST /v1/messages": {}}
	base := func(mut func(*profileJSON)) profileJSON {
		p := profileJSON{Upstream: "https://a.example/base/", Routes: routes}
		mut(&p)
		return p
	}
	route := func(key string, r routeJSON) profileJSON {
		return profileJSON{Upstream: "https://a.example", Routes: map[string]routeJSON{key: r}}
	}
	for _, c := range []struct {
		name, want string
		p          profileJSON
	}{
		{"plain http", "https URL", base(func(p *profileJSON) { p.Upstream = "http://a.example" })},
		{"a query", "https URL", base(func(p *profileJSON) { p.Upstream = "https://a.example/?k=v" })},
		{"credentials in the URL", "https URL", base(func(p *profileJSON) { p.Upstream = "https://u:p@a.example" })},
		{"no host", "https URL", base(func(p *profileJSON) { p.Upstream = "https://" })},
		{"no routes", "no routes", base(func(p *profileJSON) { p.Routes = nil })},
		{"a bad set header", "set: bad header", base(func(p *profileJSON) { p.Set = map[string]string{"Bad Name": "v"} })},
		{"a set value with a newline", "not a header value", base(func(p *profileJSON) { p.Set = map[string]string{"X-A": "v\r\nX-B: w"} })},
		{"an open variable", "write variables as {name}", base(func(p *profileJSON) { p.Set = map[string]string{"X-A": "{token"} })},
		{"an empty variable", "write variables as {name}", base(func(p *profileJSON) { p.Set = map[string]string{"X-A": "{}"} })},
		{"a stray brace", "unmatched }", base(func(p *profileJSON) { p.Set = map[string]string{"X-A": "a}"} })},
		{"a bad remove glob", "remove: bad header glob", base(func(p *profileJSON) { p.Remove = []string{"X Forwarded"} })},
		{"a bad report glob", "report: bad header glob", base(func(p *profileJSON) { p.Report = []string{""} })},
		{"concurrency without a limit", "limit must be positive", base(func(p *profileJSON) { p.Concurrency = &concurrencyJSON{Key: "{a}"} })},
		{"concurrency on a constant", "key must name a {variable}", base(func(p *profileJSON) { p.Concurrency = &concurrencyJSON{Key: "all", Limit: 2} })},
		{"an unknown error text", `errors: unknown key "nope"`, base(func(p *profileJSON) { p.Errors = map[string]string{"nope": "x"} })},
		{"a harness that is no object", "harness:", base(func(p *profileJSON) { p.Harness = map[string]any{"claude": "x"} })},
		{"a route without a method", "METHOD /path", route("/v1/messages", routeJSON{})},
		{"a relative route", "METHOD /path", route("POST v1/messages", routeJSON{})},
		{"a route with a query", "METHOD /path", route("POST /v1/messages?x=1", routeJSON{})},
		{"an unknown method", `unknown method "post"`, route("post /v1/messages", routeJSON{})},
		{"a relative to", "`to` must be a path", route("POST /a", routeJSON{To: "b"})},
		{"a to with a query", "`to` must be a path", route("POST /a", routeJSON{To: "/b?x=1"})},
		{"a bad name", "name must be", route("POST /a", routeJSON{Name: "a-b"})},
		{"a bad format", "format: the only one is responses", route("POST /a", routeJSON{Format: "chat"})},
		{"an empty require", "require: bad header", route("POST /a", routeJSON{Require: map[string]string{"X-A": ""}})},
		{"a bad default", "default: bad header", route("POST /a", routeJSON{Default: map[string]string{"": "v"}})},
	} {
		if _, err := compileProfile("p", c.p); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: %v, want %q", c.name, err, c.want)
		}
	}
	if _, err := compileProfile("bad name", base(func(*profileJSON) {})); err == nil {
		t.Error("a name with a space compiled")
	}
	p, err := compileProfile("p", base(func(p *profileJSON) {
		p.Set = map[string]string{"x-a": "{b} and {a}"}
		p.Routes = map[string]routeJSON{"POST /v1/chat.completions": {Set: map[string]string{"X-C": "{c}"}}, "GET /": {Name: "home", Format: "responses"}}
		p.Errors = map[string]string{"notReady": "wait"}
	}))
	if err != nil {
		t.Fatal(err)
	}
	if p.url.Path != "/base" || strings.Join(p.vars, ",") != "a,b,c" || p.set[0].name != "X-A" || !p.ws ||
		p.routes["POST /v1/chat.completions"].name != "chat_completions" || !p.routes["GET /"].responses ||
		p.text.notReady != "wait" || p.text.refused != defaultTexts.refused {
		t.Fatalf("profile %+v", p)
	}
	if got := p.set[0].value.expand(map[string]string{"a": "1", "b": "2"}); got != "2 and 1" {
		t.Fatalf("expand %q", got)
	}
}

func TestGlobMatch(t *testing.T) {
	for _, c := range []struct {
		glob, s string
		want    bool
	}{
		{"cli", "CLI", true}, {"cli", "cli2", false}, {"claude-cli/*", "Claude-CLI/2.1 (x)", true}, {"claude-cli/*", "claude-cli", false},
		{"*", "", true}, {"*-id", "session-id", true}, {"*-id", "id", false}, {"x-*-id", "x-request-id", true}, {"x-*-id", "x-id", false},
		{"a*b*c", "a1b2c", true}, {"a*b*c", "a1c2b", false}, {"a*a", "a", false}, {"x-forwarded-*", "X-Forwarded-For", true},
	} {
		if got := globMatch(c.glob, c.s); got != c.want {
			t.Errorf("globMatch(%q, %q) = %v", c.glob, c.s, got)
		}
	}
}

func TestRequireOK(t *testing.T) {
	p, err := compileProfile("p", profileJSON{Upstream: "https://a.example", Routes: map[string]routeJSON{
		"POST /a": {Require: map[string]string{"user-agent": "My-CLI/*", "Accept": "text/event-stream"}}}})
	if err != nil {
		t.Fatal(err)
	}
	rs := p.routes["POST /a"]
	for _, c := range []struct {
		h    http.Header
		want bool
	}{
		{http.Header{"User-Agent": {"my-cli/1.0"}, "Accept": {"text/event-stream"}}, true},
		{http.Header{"User-Agent": {"my-cli/1.0 (a, b)"}, "Accept": {"application/json, text/event-stream;q=0.5"}}, true},
		{http.Header{"User-Agent": {"other", "my-cli/2"}, "Accept": {"TEXT/EVENT-STREAM"}}, true},
		{http.Header{"User-Agent": {"my-cli/1.0"}}, false},
		{http.Header{"User-Agent": {"not-my-cli/1.0"}, "Accept": {"text/event-stream"}}, false},
		{http.Header{"User-Agent": {"my-cli/1.0"}, "Accept": {"text/event-stream-x"}}, false},
	} {
		if got := rs.requireOK(c.h); got != c.want {
			t.Errorf("%v: %v", c.h, got)
		}
	}
}
