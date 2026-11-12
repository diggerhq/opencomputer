// Profiles: everything the proxy knows about an upstream is configuration.
// A profile names an upstream, the routes a bound runner may call on it, the
// headers that carry the binding's variables, and what to report back to the
// host. The files are JSON objects of name → profile in -profiles
// (/etc/oc-modelproxy/profiles.d/*.json), read once at start.
//
//	{
//	  "example": {
//	    "upstream": "https://api.example.com/base",
//	    "routes": {
//	      "POST /v1/messages": { "require": { "User-Agent": "my-cli/*" } },
//	      "GET /v1/models":    { "to": "/models", "default": { "Accept": "application/json" } },
//	      "WS /v1/responses":  {}
//	    },
//	    "set":    { "Authorization": "Bearer {token}" },
//	    "remove": [ "X-Forwarded-*", "Cookie" ],
//	    "report": [ "x-ratelimit-*", "retry-after" ],
//	    "concurrency": { "key": "{account}", "limit": 8 },
//	    "client": { "claude": "ANTHROPIC_AUTH_TOKEN" }
//	  }
//	}
//
// Fields (README.md has the full reference):
//   - upstream: an https base URL; its path, if any, prefixes every route's.
//   - routes: the allowlist, `METHOD path` or `WS path` (a WebSocket). Each
//     may set `to` (the upstream path), `name` (its telemetry name), `format`
//     (messages | responses), `require` (header globs that must match, else
//     403), and `set` / `default` headers for that route.
//   - set / remove: request headers. Values may use {var} from the binding.
//   - report: response header globs sent to the host with each `observed`.
//   - concurrency: a cap across units whose bindings expand `key` alike.
//   - websocket: false refuses WS routes with 426.
//   - client, runner: passed to the host in `hello`, not read here.
//   - errors: texts replacing the proxy's own (routes.go).
//
// Invariants:
//   - A profile's requests only ever go to its own upstream, through its own
//     transport and ReverseProxy.
//   - Every variable a profile uses must be in a binding to it (bindings.go).
//   - A file with an unknown field, or a profile that fails a check, stops
//     the proxy at start: nothing is half-loaded.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/textproto"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
)

type profileJSON struct {
	Upstream    string               `json:"upstream"`
	Routes      map[string]routeJSON `json:"routes"`
	Set         map[string]string    `json:"set"`
	Remove      []string             `json:"remove"`
	Report      []string             `json:"report"`
	Concurrency *concurrencyJSON     `json:"concurrency"`
	WebSocket   *bool                `json:"websocket"`
	Client      map[string]string    `json:"client"`
	Runner      map[string]any       `json:"runner"`
	Errors      map[string]string    `json:"errors"`
}

type routeJSON struct {
	To      string            `json:"to"`
	Name    string            `json:"name"`
	Format  string            `json:"format"`
	Require map[string]string `json:"require"`
	Set     map[string]string `json:"set"`
	Default map[string]string `json:"default"`
}

type concurrencyJSON struct {
	Key   string `json:"key"`
	Limit int    `json:"limit"`
}

// profile is a loaded profile and its runtime: the upstream's transport, its
// ReverseProxy and its concurrency counter (outbound.go).
type profile struct {
	name    string
	url     *url.URL
	routes  map[string]*routeSpec // "POST /v1/messages", "WS /v1/responses"
	set     []headerValue
	remove  []string // lower-case globs of header names
	report  []string
	concKey *template
	ws      bool
	vars    []string // every variable the profile uses, sorted
	client  map[string]string
	runner  map[string]any
	text    texts

	up     *upstream
	rp     *httputil.ReverseProxy
	perKey *inflight
}

// routeSpec is one allowlisted endpoint of a profile.
type routeSpec struct {
	name      string // telemetry name
	ws        bool
	to        string // the upstream path; "" = the request's
	responses bool   // format responses: its stream is read for telemetry (responses.go)
	respName  string // WS: the name its responses are reported under
	require   []headerValue
	set       []headerValue
	def       []headerValue
}

// headerValue is a canonical header name with a template (set, default) or
// a lower-case glob as its literal (require).
type headerValue struct {
	name  string
	value *template
}

// profiles is the loaded set, fixed for the process's life.
type profiles struct {
	byName map[string]*profile
	sorted []*profile // by name
}

func (ps *profiles) get(name string) *profile { return ps.byName[name] }

func (ps *profiles) names() []string {
	out := make([]string, len(ps.sorted))
	for i, p := range ps.sorted {
		out[i] = p.name
	}
	return out
}

// loadProfiles reads every *.json in dir. A name defined twice is an error.
func loadProfiles(dir string) (*profiles, error) {
	files, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		return nil, err
	}
	sort.Strings(files)
	raw := map[string]profileJSON{}
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		one, err := parseProfiles(b)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", f, err)
		}
		for name, p := range one {
			if _, dup := raw[name]; dup {
				return nil, fmt.Errorf("%s: profile %q is already defined", f, name)
			}
			raw[name] = p
		}
	}
	if len(raw) == 0 {
		return nil, fmt.Errorf("no profiles in %s", dir)
	}
	return compileProfiles(raw)
}

func parseProfiles(b []byte) (map[string]profileJSON, error) {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	var out map[string]profileJSON
	if err := dec.Decode(&out); err != nil {
		return nil, err
	}
	return out, nil
}

func compileProfiles(raw map[string]profileJSON) (*profiles, error) {
	ps := &profiles{byName: map[string]*profile{}}
	for name, j := range raw {
		p, err := compileProfile(name, j)
		if err != nil {
			return nil, fmt.Errorf("profile %q: %w", name, err)
		}
		ps.byName[name] = p
		ps.sorted = append(ps.sorted, p)
	}
	slices.SortFunc(ps.sorted, func(a, b *profile) int { return strings.Compare(a.name, b.name) })
	return ps, nil
}

func compileProfile(name string, j profileJSON) (*profile, error) {
	if !isName(name, "-_") {
		return nil, fmt.Errorf("the name must be letters, digits, - or _")
	}
	u, err := url.Parse(j.Upstream)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, fmt.Errorf("upstream must be an https URL without a query")
	}
	u.Path = strings.TrimSuffix(u.Path, "/")
	p := &profile{name: name, url: u, routes: map[string]*routeSpec{}, ws: j.WebSocket == nil || *j.WebSocket,
		client: j.Client, runner: j.Runner, text: defaultTexts}
	used := map[string]bool{}
	if p.set, err = headerTemplates(j.Set, used); err != nil {
		return nil, fmt.Errorf("set: %w", err)
	}
	if p.remove, err = headerGlobs(j.Remove); err != nil {
		return nil, fmt.Errorf("remove: %w", err)
	}
	if p.report, err = headerGlobs(j.Report); err != nil {
		return nil, fmt.Errorf("report: %w", err)
	}
	if c := j.Concurrency; c != nil {
		if c.Limit <= 0 {
			return nil, fmt.Errorf("concurrency: limit must be positive")
		}
		if p.concKey, err = parseTemplate(c.Key, used); err != nil || len(p.concKey.vars) == 0 {
			return nil, fmt.Errorf("concurrency: key must name a {variable}")
		}
		p.perKey = newInflight(c.Limit)
	}
	if len(j.Routes) == 0 {
		return nil, fmt.Errorf("no routes")
	}
	for key, rj := range j.Routes {
		rs, err := compileRoute(key, rj, used)
		if err != nil {
			return nil, fmt.Errorf("route %q: %w", key, err)
		}
		p.routes[key] = rs
	}
	for key, rs := range p.routes {
		if !rs.ws {
			continue
		}
		rs.respName = strings.TrimSuffix(rs.name, "_ws")
		if post := p.routes["POST"+strings.TrimPrefix(key, "WS")]; post != nil {
			rs.respName = post.name
		}
	}
	if err := p.text.override(j.Errors); err != nil {
		return nil, err
	}
	for v := range used {
		p.vars = append(p.vars, v)
	}
	sort.Strings(p.vars)
	return p, nil
}

func compileRoute(key string, j routeJSON, used map[string]bool) (*routeSpec, error) {
	method, path, ok := strings.Cut(key, " ")
	if !ok || !strings.HasPrefix(path, "/") || strings.ContainsAny(path, " ?#") {
		return nil, fmt.Errorf("write it as `METHOD /path`")
	}
	switch method {
	case http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete, "WS":
	default:
		return nil, fmt.Errorf("unknown method %q", method)
	}
	rs := &routeSpec{ws: method == "WS", to: j.To, name: j.Name}
	if rs.to != "" && (!strings.HasPrefix(rs.to, "/") || strings.ContainsAny(rs.to, " ?#")) {
		return nil, fmt.Errorf("`to` must be a path")
	}
	if rs.name == "" {
		rs.name = routeName(path)
		if rs.ws {
			rs.name += "_ws"
		}
	}
	if !isName(rs.name, "_") {
		return nil, fmt.Errorf("name must be letters, digits or _")
	}
	switch j.Format {
	case "responses":
		rs.responses = true
	case "messages":
	case "":
		rs.responses = strings.HasSuffix(path, "/responses")
	default:
		return nil, fmt.Errorf("format must be messages or responses")
	}
	if rs.ws {
		rs.responses = true // the tunnel reads Responses events (websocket.go)
	}
	for name, glob := range j.Require {
		if !validHeaderName(name) || glob == "" {
			return nil, fmt.Errorf("require: bad header %q", name)
		}
		rs.require = append(rs.require, headerValue{name: textproto.CanonicalMIMEHeaderKey(name), value: &template{parts: []string{strings.ToLower(glob)}}})
	}
	sortHeaders(rs.require)
	var err error
	if rs.set, err = headerTemplates(j.Set, used); err != nil {
		return nil, fmt.Errorf("set: %w", err)
	}
	if rs.def, err = headerTemplates(j.Default, used); err != nil {
		return nil, fmt.Errorf("default: %w", err)
	}
	return rs, nil
}

// routeName is a path's last element, as a telemetry name.
func routeName(path string) string {
	last := path[strings.LastIndexByte(path, '/')+1:]
	b := []byte(strings.ToLower(last))
	for i, c := range b {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9') {
			b[i] = '_'
		}
	}
	if len(b) == 0 {
		return "root"
	}
	return string(b)
}

// route is the profile's route for r (nil = not allowed). The path must
// match exactly; the query is not looked at. A request to upgrade can only
// match a WS route.
func (p *profile) route(r *http.Request, upgrade bool) *routeSpec {
	if upgrade {
		if r.Method != http.MethodGet {
			return nil
		}
		return p.routes["WS "+r.URL.Path]
	}
	return p.routes[r.Method+" "+r.URL.Path]
}

// requireOK: every required header has a value, or a comma-separated item of
// one (parameters after `;` ignored), matching its glob.
func (rs *routeSpec) requireOK(h http.Header) bool {
	for _, req := range rs.require {
		if !headerMatches(h[req.name], req.value.parts[0]) {
			return false
		}
	}
	return true
}

func headerMatches(values []string, glob string) bool {
	for _, v := range values {
		if globMatch(glob, strings.TrimSpace(v)) {
			return true
		}
		for item := range strings.SplitSeq(v, ",") {
			item, _, _ = strings.Cut(item, ";")
			if globMatch(glob, strings.TrimSpace(item)) {
				return true
			}
		}
	}
	return false
}

// globMatch: pattern (lower case, `*` matches any run) against s, ASCII
// case-insensitive.
func globMatch(pattern, s string) bool {
	for {
		star := strings.IndexByte(pattern, '*')
		if star < 0 {
			return strings.EqualFold(pattern, s)
		}
		if len(s) < star || !strings.EqualFold(pattern[:star], s[:star]) {
			return false
		}
		pattern, s = pattern[star+1:], s[star:]
		if pattern == "" {
			return true
		}
		next := strings.IndexByte(pattern, '*')
		if next < 0 {
			return len(s) >= len(pattern) && strings.EqualFold(pattern, s[len(s)-len(pattern):])
		}
		i := indexFold(s, pattern[:next])
		if i < 0 {
			return false
		}
		s = s[i:]
	}
}

func indexFold(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if strings.EqualFold(s[i:i+len(sub)], sub) {
			return i
		}
	}
	return -1
}

// matchesAny: one of the lower-case header-name globs matches name.
func matchesAny(globs []string, name string) bool {
	for _, g := range globs {
		if globMatch(g, name) {
			return true
		}
	}
	return false
}

func headerGlobs(in []string) ([]string, error) {
	out := make([]string, 0, len(in))
	for _, g := range in {
		if !validHeaderName(strings.ReplaceAll(g, "*", "x")) {
			return nil, fmt.Errorf("bad header glob %q", g)
		}
		out = append(out, strings.ToLower(g))
	}
	return out, nil
}

func headerTemplates(in map[string]string, used map[string]bool) ([]headerValue, error) {
	out := make([]headerValue, 0, len(in))
	for name, v := range in {
		if !validHeaderName(name) {
			return nil, fmt.Errorf("bad header %q", name)
		}
		t, err := parseTemplate(v, used)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		out = append(out, headerValue{name: textproto.CanonicalMIMEHeaderKey(name), value: t})
	}
	sortHeaders(out)
	return out, nil
}

func sortHeaders(h []headerValue) {
	slices.SortFunc(h, func(a, b headerValue) int { return strings.Compare(a.name, b.name) })
}

// template is a header value with {variables}: literal parts alternate with
// variable names, starting with a literal.
type template struct {
	parts []string // parts[0], vars[0], parts[1], vars[1], ..., parts[n]
	vars  []string
}

func parseTemplate(s string, used map[string]bool) (*template, error) {
	if !validHeaderValue(s) {
		return nil, fmt.Errorf("not a header value")
	}
	t := &template{}
	for {
		open := strings.IndexByte(s, '{')
		if open < 0 {
			if strings.IndexByte(s, '}') >= 0 {
				return nil, fmt.Errorf("unmatched }")
			}
			t.parts = append(t.parts, s)
			return t, nil
		}
		end := strings.IndexByte(s, '}')
		if end < open || !isName(s[open+1:end], "_") {
			return nil, fmt.Errorf("write variables as {name}")
		}
		t.parts = append(t.parts, s[:open])
		t.vars = append(t.vars, s[open+1:end])
		used[s[open+1:end]] = true
		s = s[end+1:]
	}
}

func (t *template) expand(vars map[string]string) string {
	if len(t.vars) == 0 {
		return t.parts[0]
	}
	var b strings.Builder
	for i, v := range t.vars {
		b.WriteString(t.parts[i])
		b.WriteString(vars[v])
	}
	b.WriteString(t.parts[len(t.vars)])
	return b.String()
}

// isName: non-empty, ASCII letters and digits plus the bytes in extra.
func isName(s, extra string) bool {
	if s == "" || len(s) > 64 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte(extra, c) >= 0) {
			return false
		}
	}
	return true
}

func validHeaderName(s string) bool { return isName(s, "-_") }

// validHeaderValue: printable, so it can neither end a header nor start one.
func validHeaderValue(s string) bool {
	for i := 0; i < len(s); i++ {
		if c := s[i]; c < 0x20 && c != '\t' || c == 0x7f {
			return false
		}
	}
	return true
}
