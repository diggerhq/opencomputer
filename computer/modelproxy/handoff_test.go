package main

import (
	"bufio"
	"context"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// logFile is the processes' shared log: a file, not a pipe, which a
// replacement would hold open past the exit of the process it replaced.
type logFile string

func (l logFile) String() string {
	b, _ := os.ReadFile(string(l))
	return string(b)
}

// handoffProxy is a proxy run as a real process (this test binary, running
// run), its replacements included: what it tells the service manager, and
// its two sockets.
type handoffProxy struct {
	t      *testing.T
	dir    string
	notify chan string
	log    logFile
}

var mainPID = regexp.MustCompile(`MAINPID=(\d+)`)

// ready waits for a process to report itself ready and returns its pid.
func (p *handoffProxy) ready() int {
	p.t.Helper()
	select {
	case m := <-p.notify:
		pid, _ := strconv.Atoi(string(mainPID.FindSubmatch([]byte(m))[1]))
		if pid == 0 || !strings.Contains(m, "READY=1") {
			p.t.Fatalf("notified %q", m)
		}
		return pid
	case <-time.After(20 * time.Second):
		p.t.Fatalf("no process became ready; log:\n%s", p.log)
		return 0
	}
}

// binder connects to the control socket and waits for the hello.
func (p *handoffProxy) binder() (*ctl, map[string]any) {
	p.t.Helper()
	h := &harness{t: p.t, ctlPath: filepath.Join(p.dir, "control.sock")}
	k := h.dialControl()
	return k, k.waitFor(isT("hello"))
}

func (p *handoffProxy) bind(k *ctl) {
	p.t.Helper()
	k.send(map[string]any{"t": "bind", "caller": singleCaller, "sessionKey": "s1", "profile": "p", "vars": map[string]string{"token": "sk-test"}, "key": "k1"})
	k.send(map[string]any{"t": "synced"})
	k.waitFor(isBound(singleCaller, "k1"))
}

// post sends one request on a connection of its own.
func (p *handoffProxy) post(ctx context.Context, path string) (*http.Response, error) {
	tr := &http.Transport{DisableKeepAlives: true, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", filepath.Join(p.dir, "api.sock"))
	}}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://proxy"+path, strings.NewReader(`{}`))
	req.Header.Set("X-Api-Key", testPlaceholder)
	return (&http.Client{Transport: tr}).Do(req)
}

func (p *handoffProxy) logged(msg string) {
	p.t.Helper()
	for range 2000 {
		if strings.Contains(p.log.String(), msg) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	p.t.Fatalf("never logged %q; log:\n%s", msg, p.log)
}

// TestHandoff: a SIGUSR2 replaces the proxy under a live stream. The stream
// finishes on the process it started on, the replacement holds a new
// request until the binder has re-bound and then serves it, and a
// replacement that cannot start leaves the old process serving.
func TestHandoff(t *testing.T) {
	if dir := os.Getenv("MP_HANDOFF_DIR"); dir != "" {
		initLogger("test", slog.LevelInfo)
		cfg, _, err := parseFlags([]string{"-identity=single", "-hold-timeout=20s", "-drain-timeout=30s",
			"-api-socket", filepath.Join(dir, "api.sock"), "-control-socket", filepath.Join(dir, "control.sock"),
			"-profiles", filepath.Join(dir, "profiles"), "-bindings-file", filepath.Join(dir, "bindings.json")})
		if err == nil {
			err = run(cfg)
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if runtime.GOOS != "linux" {
		t.Skip("the replacement trusts the fake upstream through SSL_CERT_FILE")
	}

	release := make(chan struct{})
	up := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Api-Key") != "sk-test" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		io.WriteString(w, "a")
		if r.URL.Path == "/v1/stream" {
			w.(http.Flusher).Flush()
			<-release
			io.WriteString(w, "b")
		}
	}))
	up.EnableHTTP2 = false
	up.StartTLS()
	defer up.Close()

	dir, err := os.MkdirTemp("", "mp") // short: sun_path is 108 bytes
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("ca.pem", string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: up.Certificate().Raw})))
	if err := os.Mkdir(filepath.Join(dir, "profiles"), 0o700); err != nil {
		t.Fatal(err)
	}
	profile := toJSON(map[string]any{"p": map[string]any{"upstream": up.URL,
		"routes": map[string]any{"POST /v1/stream": map[string]any{}, "POST /v1/quick": map[string]any{}},
		"set":    map[string]string{"X-Api-Key": "{token}"}}})
	write("profiles/p.json", profile)

	nc, err := net.ListenUnixgram("unixgram", &net.UnixAddr{Name: filepath.Join(dir, "notify.sock"), Net: "unixgram"})
	if err != nil {
		t.Fatal(err)
	}
	defer nc.Close()
	p := &handoffProxy{t: t, dir: dir, notify: make(chan string, 16), log: logFile(filepath.Join(dir, "log"))}
	go func() {
		b := make([]byte, 512)
		for {
			n, err := nc.Read(b)
			if err != nil {
				return
			}
			p.notify <- string(b[:n])
		}
	}()

	cmd := exec.Command(os.Args[0], "-test.run=^TestHandoff$", "-test.count=1", "-test.timeout=120s")
	cmd.Env = append(os.Environ(), "MP_HANDOFF_DIR="+dir, "SSL_CERT_FILE="+filepath.Join(dir, "ca.pem"), "NOTIFY_SOCKET="+filepath.Join(dir, "notify.sock"))
	out, err := os.Create(string(p.log))
	if err != nil {
		t.Fatal(err)
	}
	defer out.Close()
	cmd.Stdout, cmd.Stderr = out, out
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	first := p.ready()
	if first != cmd.Process.Pid {
		t.Fatalf("the first process reported pid %d, is %d", first, cmd.Process.Pid)
	}
	second := 0
	defer func() {
		cmd.Process.Kill()
		if second != 0 {
			syscall.Kill(second, syscall.SIGKILL)
		}
	}()
	k, _ := p.binder()
	p.bind(k)

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	stream, err := p.post(ctx, "/v1/stream")
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Body.Close()
	body := bufio.NewReader(stream.Body)
	if c, err := body.ReadByte(); err != nil || c != 'a' {
		t.Fatalf("stream start: %q %v", c, err)
	}

	// A replacement that cannot start: the old process goes on serving.
	write("profiles/p.json", `{"p":{"upstream":"http://not-https.example"}}`)
	cmd.Process.Signal(syscall.SIGUSR2)
	p.logged("handoff failed; still serving")
	if res, err := p.post(ctx, "/v1/quick"); err != nil || res.StatusCode != http.StatusOK {
		t.Fatalf("after a failed handoff: %v %v", res, err)
	}

	// One that can.
	write("profiles/p.json", profile)
	cmd.Process.Signal(syscall.SIGUSR2)
	if second = p.ready(); second == first {
		t.Fatal("the replacement reported the old pid")
	}
	// The old process drops the binder, which finds the replacement holding
	// the caller it knew from the bindings file.
	for range k.msgs {
	}
	k2, hello := p.binder()
	if bs, _ := json.Marshal(hello["bindings"]); !strings.Contains(string(bs), `"caller":"single"`) {
		t.Fatalf("the replacement's hello has no binding for the caller: %s", bs)
	}
	quick := make(chan error, 1)
	go func() {
		res, err := p.post(ctx, "/v1/quick")
		if err == nil && res.StatusCode != http.StatusOK {
			err = fmt.Errorf("status %d", res.StatusCode)
		}
		quick <- err
	}()
	select {
	case err := <-quick:
		t.Fatalf("a request was answered before the binder re-bound: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	p.bind(k2)
	if err := <-quick; err != nil {
		t.Fatalf("the held request: %v", err)
	}

	// The stream is still the old process's, which exits when it ends.
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	select {
	case err := <-exited:
		t.Fatalf("the old process exited under its stream: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	close(release)
	if rest, err := io.ReadAll(body); err != nil || string(rest) != "b" {
		t.Fatalf("stream end: %q %v", rest, err)
	}
	select {
	case err := <-exited:
		if err != nil {
			t.Fatalf("the old process: %v; log:\n%s", err, p.log)
		}
	case <-time.After(20 * time.Second):
		t.Fatalf("the old process did not exit; log:\n%s", p.log)
	}
	if res, err := p.post(ctx, "/v1/quick"); err != nil || res.StatusCode != http.StatusOK {
		t.Fatalf("after the old process exited: %v %v", res, err)
	}

	// The replacement stops as any proxy does.
	syscall.Kill(second, syscall.SIGTERM)
	select {
	case m := <-p.notify:
		if m != "STOPPING=1" {
			t.Fatalf("notified %q", m)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("the replacement did not stop")
	}
	if strings.Contains(p.log.String(), "sk-test") {
		t.Fatal("the log carries the binding's variable")
	}
}
