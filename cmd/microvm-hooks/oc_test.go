package main

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// oc_test.go — the parts of the front door that do not need a live agent.
//
// The filesystem handlers are a thin translation over loopback gRPC and are
// exercised end to end on dev against a real box; what is worth pinning here is
// the routing and the error mapping, because both fail silently. A port proxy
// that mis-parses its path reaches the wrong service, and a status mapping that
// collapses everything to 500 makes "file not found" indistinguishable from
// "the agent is wedged" — the SDK then retries the one that can never succeed.

// The customer's own server is reachable, path and query intact.
func TestPortProxyReachesCustomerServer(t *testing.T) {
	var gotPath, gotQuery string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotQuery = r.URL.Path, r.URL.RawQuery
		_, _ = io.WriteString(w, "hello from the sandbox")
	}))
	defer backend.Close()

	_, port, err := net.SplitHostPort(strings.TrimPrefix(backend.URL, "http://"))
	if err != nil {
		t.Fatalf("split backend addr: %v", err)
	}

	s := &server{}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, ocPortPrefix+port+"/api/users?limit=5", nil)
	s.ocPort(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body: %s)", rec.Code, rec.Body.String())
	}
	if body := rec.Body.String(); body != "hello from the sandbox" {
		t.Errorf("body = %q, want the customer server's response", body)
	}
	// The /oc/port/<port> prefix must be stripped: forwarding it would make
	// every customer route 404 against their own server.
	if gotPath != "/api/users" {
		t.Errorf("forwarded path = %q, want /api/users — the port prefix leaked through", gotPath)
	}
	if gotQuery != "limit=5" {
		t.Errorf("forwarded query = %q, want limit=5", gotQuery)
	}
}

// Our own ports are refused. Proxying to the hook port is an infinite loop that
// takes down the box's only listener; the agent port is not the customer's to
// reach.
func TestPortProxyRefusesReservedPorts(t *testing.T) {
	s := &server{}
	for _, port := range []string{"8080", "8081"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, ocPortPrefix+port+"/", nil)
		s.ocPort(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("port %s: status = %d, want 403", port, rec.Code)
		}
	}
}

func TestPortProxyRejectsBadPort(t *testing.T) {
	s := &server{}
	for _, path := range []string{"notaport/", "0/", "99999/", ""} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, ocPortPrefix+path, nil)
		s.ocPort(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("path %q: status = %d, want 400", path, rec.Code)
		}
	}
}

// Nothing listening is a 502 with an explanation, not a hang or a 500. This is
// the ordinary state while a customer's server is still starting up.
func TestPortProxyReportsNothingListening(t *testing.T) {
	// Bind and immediately release, so the port is almost certainly free.
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	_, port, _ := net.SplitHostPort(l.Addr().String())
	_ = l.Close()

	s := &server{}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, ocPortPrefix+port+"/", nil)
	s.ocPort(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "nothing is listening") {
		t.Errorf("body = %q, want an explanation naming the port", rec.Body.String())
	}
}

// A missing file must not look like a broken agent. The control plane cannot
// see gRPC codes from outside the guest, so this mapping is the only thing that
// distinguishes a normal answer from a fault.
func TestErrorMappingDistinguishesFaultFromAnswer(t *testing.T) {
	cases := []struct {
		code codes.Code
		want int
	}{
		{codes.NotFound, http.StatusNotFound},
		{codes.InvalidArgument, http.StatusBadRequest},
		{codes.PermissionDenied, http.StatusForbidden},
		{codes.AlreadyExists, http.StatusConflict},
		{codes.Unavailable, http.StatusServiceUnavailable},
		{codes.ResourceExhausted, http.StatusInsufficientStorage},
		{codes.Internal, http.StatusInternalServerError},
		{codes.Unknown, http.StatusInternalServerError},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		fail(rec, "test", status.Error(c.code, "boom"))
		if rec.Code != c.want {
			t.Errorf("gRPC %v -> HTTP %d, want %d", c.code, rec.Code, c.want)
		}
	}
}

// The front door must win over the catch-all bridge to the agent. Without an
// explicit registration a JSON POST to /oc/fs/read is forwarded to the agent's
// gRPC listener, which answers 415 with no explanation.
func TestOCRoutesBeatTheAgentCatchAll(t *testing.T) {
	mux := http.NewServeMux()
	catchAll := false
	mux.HandleFunc("/", func(http.ResponseWriter, *http.Request) { catchAll = true })
	(&server{}).registerOC(mux)

	for _, path := range []string{
		ocFSPrefix + "read", ocFSPrefix + "write", ocFSPrefix + "list",
		ocFSPrefix + "mkdir", ocFSPrefix + "rm", ocFSPrefix + "exists",
		ocFSPrefix + "stat", ocFSPrefix + "download", ocFSPrefix + "upload",
		ocStatsPath, ocRebootPath, ocPortPrefix + "3000/",
		ocRunPath, ocClaimPath, ocClaimRunPath,
	} {
		_, pattern := mux.Handler(httptest.NewRequest(http.MethodPost, path, nil))
		if pattern == "/" {
			t.Errorf("%s fell through to the agent catch-all", path)
		}
	}
	if catchAll {
		t.Error("catch-all ran during registration")
	}
}

// The old prefix keeps working. The deployed control plane speaks /osb, and an
// image that served only /oc would break every box the moment it rolled.
func TestLegacyOSBPathsStillRegistered(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc(runCmdPath, (&server{}).handleRunCmd)
	(&server{}).registerOC(mux)

	_, pattern := mux.Handler(httptest.NewRequest(http.MethodPost, runCmdPath, nil))
	if pattern != runCmdPath {
		t.Errorf("legacy %s resolved to %q — a rolling image would break the deployed control plane", runCmdPath, pattern)
	}
}
