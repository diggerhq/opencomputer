package main

import (
	"bufio"
	"context"
	"crypto/x509"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

const (
	testUnit        = "sp-runner-abc123.service"
	testPlaceholder = "ssh-placeholder"
	placeholderAuth = "Bearer " + testPlaceholder
	wsNonce         = "dGhlIHNhbXBsZSBub25jZQ==" // RFC 6455's sample nonce
)

// The profiles tests run on: the shipped defaults (profiles/default.json),
// their upstreams replaced by the fake one, plus `alt`, on a second fake
// upstream, which uses what the defaults do not: a base path, `to`,
// variables beyond the token, `remove`, `report`, `concurrency`, `errors`.
const (
	mainProfile = "claude-oauth"
	altProfile  = "alt"
	altUnit     = "sp-runner-alt001.service"
	altAccount  = "acct-123"
	altShape    = "alt: not this client's request"
	altNotReady = "alt: not ready"
)

func altProfileJSON(upstream string, limit int, ws bool) profileJSON {
	return profileJSON{
		Upstream: upstream + "/base",
		Routes: map[string]routeJSON{
			"POST /v1/responses": {To: "/x/responses", Require: map[string]string{"Accept": "text/event-stream", "Content-Type": "application/json"}},
			"WS /v1/responses":   {To: "/x/responses", Require: map[string]string{"X-Proto": "ws=*"}},
			"GET /v1/models":     {To: "/x/models", Default: map[string]string{"Accept": "application/json"}},
		},
		Set:         map[string]string{"Authorization": "Bearer {token}", "X-Account": "{accountId}", "Originator": "fixed"},
		Remove:      []string{"X-Forwarded-*", "X-Real-Ip", "Cookie", "X-Private-*"},
		Report:      []string{"x-quota-*", "retry-after"},
		Concurrency: &concurrencyJSON{Key: "{accountId}", Limit: limit},
		WebSocket:   &ws,
		Client:      map[string]string{"codex": "api-key"},
		Runner:      map[string]any{"promptCacheTtl": "1h"},
		Errors:      map[string]string{"require": altShape, "notReady": altNotReady},
	}
}

// harness: a proxy on a TCP listener (callers named by their dial, see
// client), a control socket, and two fake TLS upstreams.
type harness struct {
	t        testing.TB
	srv      *server
	upstream *httptest.Server // the default profiles'
	alt      *httptest.Server // the alt profile's
	apiURL   string
	ctlPath  string
	dir      string
	callers  sync.Map // client local addr → unit
}

type harnessOpts struct {
	hold           time.Duration
	restore        []persisted
	warm           int
	perUnit        int           // -max-inflight-per-unit; 0 = the default of 32
	alt            http.Handler  // the alt profile's upstream; nil = one that answers 500
	perKey         int           // alt's concurrency limit; 0 = 8
	noWS           bool          // alt's `websocket: false`
	wsIdle         time.Duration // -ws-idle-timeout; 0 = never
	defaultProfile string        // -default-profile
}

func fakeUpstream(t testing.TB, h http.Handler, roots *x509.CertPool) *httptest.Server {
	up := httptest.NewUnstartedServer(h)
	up.EnableHTTP2 = false
	up.StartTLS()
	t.Cleanup(up.Close)
	roots.AddCert(up.Certificate())
	return up
}

func newHarness(t testing.TB, h http.Handler, o harnessOpts) *harness {
	t.Helper()
	roots := x509.NewCertPool()
	up := fakeUpstream(t, h, roots)
	if o.alt == nil {
		o.alt = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(500) })
	}
	alt := fakeUpstream(t, o.alt, roots)
	dir, err := os.MkdirTemp("", "mp") // short: sun_path is 108 bytes
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	if o.hold == 0 {
		o.hold = 2 * time.Second
	}
	if o.perUnit == 0 {
		o.perUnit = 32
	}
	if o.perKey == 0 {
		o.perKey = 8
	}
	b, err := os.ReadFile(filepath.Join("profiles", "default.json"))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := parseProfiles(b)
	if err != nil {
		t.Fatal(err)
	}
	for name, p := range raw {
		u, _ := url.Parse(p.Upstream)
		p.Upstream = up.URL + u.Path
		raw[name] = p
	}
	raw[altProfile] = altProfileJSON(alt.URL, o.perKey, !o.noWS)
	ps, err := compileProfiles(raw)
	if err != nil {
		t.Fatal(err)
	}
	cfg := config{hold: o.hold, bindingsFile: filepath.Join(dir, "bindings.json"), maxInflightPerUnit: o.perUnit, wsIdle: o.wsIdle,
		placeholder: testPlaceholder, defaultProfile: o.defaultProfile, rootCAs: roots,
		maxIdlePerHost: 128, maxConnsPerHost: 256, idleConnTimeout: time.Minute, warmMax: o.warm}
	if o.restore != nil {
		if err := writeBindings(cfg.bindingsFile, o.restore); err != nil {
			t.Fatal(err)
		}
	}
	hs := &harness{t: t, upstream: up, alt: alt, dir: dir, ctlPath: filepath.Join(dir, "c.sock")}
	resolve := func(c net.Conn) string {
		v, _ := hs.callers.Load(c.RemoteAddr().String())
		s, _ := v.(string)
		return s
	}
	srv, err := newServer(cfg, ps, resolve)
	if err != nil {
		t.Fatal(err)
	}
	hs.srv = srv
	apiL, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctlL, err := listenUnix(hs.ctlPath)
	if err != nil {
		t.Fatal(err)
	}
	hs.apiURL = "http://" + apiL.Addr().String()
	srv.start(apiL, ctlL)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.shutdown(ctx)
	})
	return hs
}

// client returns an HTTP client whose connections the proxy sees as unit.
func (h *harness) client(unit string) *http.Client {
	tr := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			c, err := (&net.Dialer{}).DialContext(ctx, network, addr)
			if err == nil {
				h.callers.Store(c.LocalAddr().String(), unit)
			}
			return c, err
		},
		DisableCompression:  true,
		MaxIdleConnsPerHost: 128,
	}
	h.t.Cleanup(tr.CloseIdleConnections)
	return &http.Client{Transport: tr}
}

// messagesReq is a /v1/messages request that passes claude-oauth's `require`.
func (h *harness) messagesReq(ctx context.Context) *http.Request {
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, h.apiURL+"/v1/messages?beta=true", stringsReader(`{"model":"x"}`))
	req.Host = "api.anthropic.com"
	req.Header.Set("User-Agent", "claude-cli/2.1.301 (external, sdk-cli)")
	req.Header.Set("X-App", "cli")
	req.Header.Set("Anthropic-Beta", "claude-code-20250219,interleaved-thinking-2025-05-14,oauth-2025-04-20")
	req.Header.Set("Anthropic-Version", "2023-06-01")
	req.Header.Set("Authorization", placeholderAuth)
	req.Header.Set("Content-Type", "application/json")
	return req
}

// ctl is a fake host on the control socket.
type ctl struct {
	t    testing.TB
	c    net.Conn
	msgs chan map[string]any
}

func (h *harness) dialControl() *ctl {
	h.t.Helper()
	c, err := net.Dial("unix", h.ctlPath)
	if err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(func() { c.Close() })
	k := &ctl{t: h.t, c: c, msgs: make(chan map[string]any, 10000)}
	go func() {
		sc := bufio.NewScanner(c)
		sc.Buffer(make([]byte, 1<<16), 1<<20)
		for sc.Scan() {
			var m map[string]any
			if json.Unmarshal(sc.Bytes(), &m) == nil {
				k.msgs <- m
			}
		}
		close(k.msgs)
	}()
	return k
}

func (k *ctl) send(v any) {
	k.t.Helper()
	b, _ := json.Marshal(v)
	if _, err := k.c.Write(append(b, '\n')); err != nil {
		k.t.Fatal(err)
	}
}

// bind binds unit to the main profile.
func (k *ctl) bind(unit, session, token, key string) {
	k.send(map[string]any{"t": "bind", "unit": unit, "sessionKey": session, "profile": mainProfile, "vars": map[string]string{"token": token}, "key": key})
}

func (k *ctl) bindAlt(unit, session, token, key, account string) {
	k.send(map[string]any{"t": "bind", "unit": unit, "sessionKey": session, "profile": altProfile,
		"vars": map[string]string{"token": token, "accountId": account}, "key": key})
}

// waitFor returns the first message matching pred, failing after 3 s.
func (k *ctl) waitFor(pred func(map[string]any) bool) map[string]any {
	k.t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case m, ok := <-k.msgs:
			if !ok {
				k.t.Fatal("control connection closed")
			}
			if pred(m) {
				return m
			}
		case <-deadline:
			k.t.Fatal("timed out waiting for a control message")
		}
	}
}

func isT(t string) func(map[string]any) bool {
	return func(m map[string]any) bool { return m["t"] == t }
}

func isEvent(name string) func(map[string]any) bool {
	return func(m map[string]any) bool { return m["t"] == "event" && m["name"] == name }
}

// noMessage asserts no matching message arrives within d.
func (k *ctl) noMessage(pred func(map[string]any) bool, d time.Duration) {
	k.t.Helper()
	deadline := time.After(d)
	for {
		select {
		case m, ok := <-k.msgs:
			if !ok {
				return
			}
			if pred(m) {
				k.t.Fatalf("unexpected message %v", m)
			}
		case <-deadline:
			return
		}
	}
}

func isBound(unit, key string) func(map[string]any) bool {
	return func(m map[string]any) bool { return m["t"] == "bound" && m["unit"] == unit && m["key"] == key }
}

// bindReady binds unit and waits for `bound`.
func (h *harness) bindReady(k *ctl, unit, session, token, key string) {
	h.t.Helper()
	k.bind(unit, session, token, key)
	k.waitFor(isBound(unit, key))
}

func (h *harness) bindAltReady(k *ctl, unit, session, token, key, account string) map[string]any {
	h.t.Helper()
	k.bindAlt(unit, session, token, key, account)
	return k.waitFor(isBound(unit, key))
}

// responsesReq is a /v1/responses request that passes alt's `require`.
func (h *harness) responsesReq(ctx context.Context) *http.Request {
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, h.apiURL+"/v1/responses", stringsReader(`{"model":"m","stream":true,"input":[]}`))
	req.Header.Set("Authorization", placeholderAuth)
	req.Header.Set("User-Agent", "test-client/1.0")
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Session-Id", "sess-1")
	return req
}

func toJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func evData(e map[string]any) map[string]any { return e["data"].(map[string]any) }

func isRoute(route string) func(map[string]any) bool {
	return func(m map[string]any) bool {
		d, _ := m["data"].(map[string]any)
		return isEvent("model.request")(m) && d["route"] == route
	}
}

func decodeAPIError(t *testing.T, res *http.Response) apiError {
	t.Helper()
	var e apiError
	if err := json.NewDecoder(res.Body).Decode(&e); err != nil {
		t.Fatalf("error body: %v", err)
	}
	if e.Type != "error" || e.Error.Type == "" || e.Error.Message == "" {
		t.Fatalf("not the API error shape: %+v", e)
	}
	return e
}
