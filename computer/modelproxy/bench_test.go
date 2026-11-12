package main

import (
	"bufio"
	"cmp"
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime/debug"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const benchConcurrency = 64

// BenchmarkProxyOverhead streams SSE through the proxy at 64 concurrent
// streams from a local TLS fake upstream, and reports the proxy's own time
// per request: overhead_pre + overhead_first_byte (telemetry.go), which
// leaves out the upstream's time and the client's. The upstream and the
// clients run in a child process, as they do on a real host, so their
// allocations and goroutines do not land in the proxy's heap and scheduler.
// The proxy runs at the binary's GC setting (-gc-percent's default).
// With MODELPROXY_OVERHEAD_P99_MS set (CI: 2) it fails when p99 exceeds it
// in each of three rounds.
//
//	MODELPROXY_OVERHEAD_P99_MS=2 go test -run '^$' -bench ProxyOverhead -benchtime 5000x
func BenchmarkProxyOverhead(b *testing.B) {
	setGCPercent(defaultGCPercent)
	b.Cleanup(func() { debug.SetGCPercent(100) })
	cmd := exec.Command(os.Args[0], "-test.run=^TestLoadGenChild$", "-test.count=1", "-test.v=false")
	cmd.Env = append(os.Environ(), "MP_LOADGEN_CHILD=1")
	cmd.Stderr = os.Stderr
	stdin, _ := cmd.StdinPipe()
	stdout, _ := cmd.StdoutPipe()
	if err := cmd.Start(); err != nil {
		b.Fatal(err)
	}
	defer func() { stdin.Close(); cmd.Wait() }()
	out := bufio.NewScanner(stdout)
	out.Buffer(make([]byte, 1<<16), 1<<20)
	var hello struct{ URL, CertPEM string }
	if !out.Scan() || json.Unmarshal(out.Bytes(), &hello) != nil {
		b.Fatalf("load generator did not start: %q", out.Text())
	}
	blk, _ := pem.Decode([]byte(hello.CertPEM))
	cert, err := x509.ParseCertificate(blk.Bytes)
	if err != nil {
		b.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(cert)
	ps, err := compileProfiles(map[string]profileJSON{mainProfile: {
		Upstream: hello.URL,
		Routes:   map[string]routeJSON{"POST /v1/messages": {Require: map[string]string{"User-Agent": "claude-cli/*", "X-App": "cli", "Anthropic-Beta": "oauth-2025-04-20"}}},
		Set:      map[string]string{"Authorization": "Bearer {token}"},
		Report:   []string{"x-quota-*"},
	}})
	if err != nil {
		b.Fatal(err)
	}

	dir, err := os.MkdirTemp("", "mp")
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { os.RemoveAll(dir) })
	cfg := config{hold: 2 * time.Second, bindingsFile: filepath.Join(dir, "bindings.json"), placeholder: testPlaceholder, rootCAs: roots,
		maxIdlePerHost: 96, maxConnsPerHost: 256, idleConnTimeout: time.Minute, warmMax: 4}
	srv, err := newServer(cfg, ps, func(net.Conn) string { return testUnit })
	if err != nil {
		b.Fatal(err)
	}
	h := &harness{t: b, srv: srv, dir: dir, ctlPath: filepath.Join(dir, "c.sock")}
	apiL, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		b.Fatal(err)
	}
	ctlL, err := listenUnix(h.ctlPath)
	if err != nil {
		b.Fatal(err)
	}
	srv.start(apiL, ctlL)
	b.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.shutdown(ctx)
	})
	k := h.dialControl()
	h.bindReady(k, testUnit, "s1", "tok", "fp1")
	go func() { // keep the control queue empty
		for range k.msgs {
		}
	}()

	var mu sync.Mutex
	var totals, pres, fbs []time.Duration
	srv.proxy.statsHook = func(st *reqState) {
		pre, ok1 := st.overheadPre()
		fb, ok2 := st.overheadFirstByte()
		if !ok1 || !ok2 {
			return
		}
		mu.Lock()
		totals, pres, fbs = append(totals, pre+fb), append(pres, pre), append(fbs, fb)
		mu.Unlock()
	}
	load := func(n int) {
		fmt.Fprintf(stdin, "http://%s %d\n", apiL.Addr(), n)
		if !out.Scan() || out.Text() != "ok" {
			b.Fatalf("load generator: %q", out.Text())
		}
	}
	load(benchConcurrency * 4) // warm both connection pools
	mu.Lock()
	totals, pres, fbs = nil, nil, nil
	mu.Unlock()

	// Three rounds of b.N requests each; the gate takes the best round's
	// p99, so a burst from another process on a shared runner fails one
	// round, not the build. A real regression fails all three.
	const rounds = 3
	type result struct{ p50, p99, pre99, fb99 float64 }
	p := func(xs []time.Duration, q float64) float64 {
		s := slices.Clone(xs)
		slices.Sort(s)
		return float64(s[min(int(q*float64(len(s))), len(s)-1)].Microseconds()) / 1000
	}
	var results []result
	b.ResetTimer()
	for range rounds {
		load(b.N)
		mu.Lock()
		if len(totals) < b.N {
			mu.Unlock()
			b.Fatalf("%d measurements for %d requests", len(totals), b.N)
		}
		results = append(results, result{p(totals, 0.50), p(totals, 0.99), p(pres, 0.99), p(fbs, 0.99)})
		totals, pres, fbs = nil, nil, nil
		mu.Unlock()
	}
	b.StopTimer()
	best := slices.MinFunc(results, func(x, y result) int { return cmp.Compare(x.p99, y.p99) })
	worst := slices.MaxFunc(results, func(x, y result) int { return cmp.Compare(x.p99, y.p99) })
	b.ReportMetric(best.p50, "p50-overhead-ms")
	b.ReportMetric(best.p99, "p99-overhead-ms")
	b.ReportMetric(worst.p99, "worst-round-p99-ms")
	b.ReportMetric(best.pre99, "p99-pre-ms")
	b.ReportMetric(best.fb99, "p99-first-byte-ms")
	if gate := os.Getenv("MODELPROXY_OVERHEAD_P99_MS"); gate != "" && b.N >= 100 {
		limit, err := strconv.ParseFloat(gate, 64)
		if err != nil {
			b.Fatalf("MODELPROXY_OVERHEAD_P99_MS: %v", err)
		}
		if best.p99 > limit {
			b.Fatalf("proxy overhead p99 %.3f ms > %.3f ms in every round (%+v)", best.p99, limit, results)
		}
	}
}

// TestLoadGenChild is BenchmarkProxyOverhead's other process: a TLS fake
// SSE upstream plus 64 concurrent streaming clients. It prints the upstream's
// URL and certificate, then for each "<proxy url> <n>" line on stdin runs n
// requests and answers "ok" (or the first error).
func TestLoadGenChild(t *testing.T) {
	if os.Getenv("MP_LOADGEN_CHILD") != "1" {
		t.Skip("run by BenchmarkProxyOverhead")
	}
	const events = 8
	payload := make([]byte, 0, 4096)
	for i := range events {
		payload = fmt.Appendf(payload, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"chunk %d lorem ipsum dolor sit amet\"}}\n\n", i)
	}
	up := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("X-Quota-Used", "12")
		w.WriteHeader(200)
		f := w.(http.Flusher)
		f.Flush()
		chunk := len(payload) / events
		for i := 0; i < len(payload); i += chunk {
			w.Write(payload[i:min(i+chunk, len(payload))])
			f.Flush()
		}
	}))
	up.EnableHTTP2 = false
	up.StartTLS()
	defer up.Close()
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: up.Certificate().Raw})
	line, _ := json.Marshal(map[string]string{"URL": up.URL, "CertPEM": string(certPEM)})
	os.Stdout.Write(append(line, '\n'))

	clients := make([]*http.Client, benchConcurrency)
	for i := range clients {
		clients[i] = &http.Client{Transport: &http.Transport{DisableCompression: true, MaxIdleConnsPerHost: 4}}
	}
	in := bufio.NewScanner(os.Stdin)
	for in.Scan() {
		var target string
		var n int64
		if _, err := fmt.Sscanf(in.Text(), "%s %d", &target, &n); err != nil {
			t.Fatal(err)
		}
		h := &harness{apiURL: target}
		var next atomic.Int64
		var firstErr atomic.Value
		var wg sync.WaitGroup
		for i := range benchConcurrency {
			wg.Add(1)
			go func() {
				defer wg.Done()
				for next.Add(1) <= n {
					res, err := clients[i].Do(h.messagesReq(context.Background()))
					if err == nil {
						io.Copy(io.Discard, res.Body)
						res.Body.Close()
						if res.StatusCode != 200 {
							err = fmt.Errorf("status %d", res.StatusCode)
						}
					}
					if err != nil {
						firstErr.CompareAndSwap(nil, err.Error())
						return
					}
				}
			}()
		}
		wg.Wait()
		if e := firstErr.Load(); e != nil {
			fmt.Println(e)
		} else {
			fmt.Println("ok")
		}
	}
}
