package proxy

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
)

// The preview-port proxy must stream the upstream response to the client as
// bytes arrive — not buffer the whole thing first (which produced Cloudflare
// 524s on long responses and broke SSE/chunked/long-poll). This proves the
// first chunk reaches the client while the upstream is still holding the
// response open, and that upstream CORS headers are stripped.
func TestDoHTTP_StreamsBeforeUpstreamCompletes(t *testing.T) {
	release := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Test", "up")
		w.Header().Set("Access-Control-Allow-Origin", "*") // must be stripped by the proxy
		fl, ok := w.(http.Flusher)
		if !ok {
			t.Error("upstream writer is not a Flusher")
			return
		}
		_, _ = io.WriteString(w, "chunk1\n")
		fl.Flush()
		<-release // hold the response open until the test says go
		_, _ = io.WriteString(w, "chunk2\n")
		fl.Flush()
	}))
	defer upstream.Close()
	addr := strings.TrimPrefix(upstream.URL, "http://")

	p := &SandboxProxy{} // doHTTP takes addr directly; no manager needed
	e := echo.New()
	e.Any("/*", func(c echo.Context) error { return p.doHTTP(c, "sb-x", addr, 13000) })
	front := httptest.NewServer(e)
	defer front.Close()

	resp, err := http.Get(front.URL + "/")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()

	// The first chunk must arrive WITHOUT releasing the upstream — if the proxy
	// buffered, this read would block until the whole response completed.
	buf := make([]byte, len("chunk1\n"))
	readDone := make(chan string, 1)
	go func() {
		n, _ := io.ReadFull(resp.Body, buf)
		readDone <- string(buf[:n])
	}()
	select {
	case got := <-readDone:
		if !strings.Contains(got, "chunk1") {
			t.Fatalf("first read = %q, want chunk1", got)
		}
	case <-time.After(2 * time.Second):
		close(release)
		t.Fatal("first chunk did not arrive before upstream completed — proxy is buffering, not streaming")
	}

	close(release) // let the upstream finish
	rest, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(rest), "chunk2") {
		t.Fatalf("rest = %q, want chunk2", rest)
	}

	if resp.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatalf("upstream Access-Control-Allow-Origin should be stripped by the proxy")
	}
	if resp.Header.Get("X-Test") != "up" {
		t.Fatalf("non-CORS upstream headers should pass through; X-Test=%q", resp.Header.Get("X-Test"))
	}
}
