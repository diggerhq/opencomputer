package worker

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// dodialer.go — the QEMU worker HOST side of the VM-DO exec data plane
// (vm_do_datapane_validation). For each customer-usable sandbox on this worker
// the host opens a persistent outbound WebSocket to the sandbox's VmSession
// Durable Object on the edge (wss://<edge>/internal/vms/<id>/connect). The DO
// relays exec requests over that socket as protobuf frames; the host runs them
// against the in-guest agent (via the same manager.Exec the tunnel path uses)
// and replies with a result frame keyed by requestId.
//
// This re-homes the internal/wsgateway broker concept as a host→edge dial. It is
// host-dialed (not guest-dialed): the credential never enters the untrusted
// guest, egress allowlists don't sever it, and it is torn down/re-established on
// the box's lifecycle transitions rather than dying with a guest process.
//
// Auth is a per-sandbox connect token (auth.MintVMDOConnectToken), minted by the
// CP and delivered to the worker over the already-authenticated create/claim/wake
// gRPC. The worker holds no signing secret — only the token for the boxes it
// hosts — and presents it as the 2nd WS subprotocol; the edge re-derives and
// compares. A box with no token simply doesn't dial (exec stays on the tunnel).
//
// Scope is deliberately narrow — one-shot buffered exec, which is all the TTI
// benchmark (create→node -v→destroy) exercises. Files/PTY/streaming stay on the
// tunnel; the edge falls back to it automatically whenever the DO reports the
// channel isn't live, so a dialer that never connects only costs a fallback, not
// a failure.

const (
	// WebSocket control-frame keepalive. This keeps intermediaries from reaping
	// an idle connection, but it CANNOT prove the Durable Object still holds the
	// socket: Cloudflare's edge terminates control frames and pongs on the DO's
	// behalf. A box whose DO lost the socket therefore looks perfectly healthy
	// here forever — measured on dev, where 8/16 pooled boxes served every exec
	// over the tunnel while the host logged no error, no redial, no close.
	// Liveness is proven by the app-level ping below; this is just hygiene.
	doPingPeriod = 30 * time.Second
	doPongWait   = 75 * time.Second

	// App-level liveness. The host sends a requestId=0 frame; only the DO can
	// decode it and answer, so a pong proves the socket is still bound to a live
	// VmSession — the one thing the control-frame pong cannot tell us. No pong
	// within the wait means the channel is a zombie: drop it and redial, so a
	// pool box that has been parked for minutes still has a channel the edge
	// agrees is connected when it is finally claimed.
	doAppPingPeriod = 20 * time.Second
	doAppPongWait   = 50 * time.Second

	// How long a claim-time probe waits for the pong before condemning the
	// channel. A healthy DO answers in a single edge round trip; anything
	// slower is better spent redialing than hoping.
	doVerifyGrace = 400 * time.Millisecond

	// pingRequestID is reserved for liveness in both directions and is never a
	// real exec: the DO mints request ids from 1 (`nextRequestId++ >>> 0 || 1`).
	pingRequestID = 0

	doHandshakeTimeout = 10 * time.Second
	doDialBackoffMin   = 250 * time.Millisecond
	doDialBackoffMax   = 10 * time.Second

	// A single result frame must stay under the Workers WebSocket message cap
	// (~1 MiB). Larger buffered output is truncated to this combined budget —
	// parity with the tunnel path's 1 MB scrollback ring. Commands that need
	// unbounded/streaming output aren't served here anyway (they attach over the
	// tunnel); this only bounds the run-async buffered result.
	doMaxOutputBytes = 900 * 1024

	// wsSubprotocol marks the binary exec wire format; the connect secret rides
	// as the 2nd subprotocol (mirrors the edge's socketSecret parsing).
	wsSubprotocol = "oc-protobuf-v1"
)

// doExecFn runs one buffered command against a sandbox's in-guest agent. It is
// s.manager.Exec — the exact one-shot path (with transport-error redial
// recovery) the tunnel exec uses, so DO-served and tunnel-served execs are
// byte-for-byte equivalent.
type doExecFn func(ctx context.Context, sandboxID string, cfg types.ProcessConfig) (*types.ProcessResult, error)

// doDialerRegistry owns the per-sandbox host dialers. Inert (start/stop no-op)
// unless an edge URL is configured; per-sandbox it also needs a connect token.
type doDialerRegistry struct {
	edgeWSBase string // e.g. wss://opensandbox-edge-dev.example
	execFn     doExecFn

	mu      sync.Mutex
	dialers map[string]*doDialer
}

func newDoDialerRegistry(edgeURL string, execFn doExecFn) *doDialerRegistry {
	// Accept an https:// base for convenience and normalize to wss:// (the
	// gorilla dialer requires a ws/wss scheme).
	base := strings.TrimRight(edgeURL, "/")
	switch {
	case strings.HasPrefix(base, "https://"):
		base = "wss://" + strings.TrimPrefix(base, "https://")
	case strings.HasPrefix(base, "http://"):
		base = "ws://" + strings.TrimPrefix(base, "http://")
	}
	return &doDialerRegistry{
		edgeWSBase: base,
		execFn:     execFn,
		dialers:    make(map[string]*doDialer),
	}
}

func (r *doDialerRegistry) enabled() bool {
	return r != nil && r.edgeWSBase != ""
}

// start begins (or leaves running) the host dialer for a sandbox, using the
// per-sandbox connect token the CP delivered. Idempotent: a second call for a
// live sandbox is a no-op. An empty token means the VM-DO plane isn't provisioned
// for this box → no dial (exec stays on the tunnel). Safe to call from any
// lifecycle success tail (claim, create, warm-fork, wake).
func (r *doDialerRegistry) start(sandboxID, token string) {
	if !r.enabled() || token == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, ok := r.dialers[sandboxID]; ok {
		return
	}
	url := fmt.Sprintf("%s/internal/vms/%s/connect", r.edgeWSBase, sandboxID)
	d := newDoDialer(url, token, sandboxID, r.execFn)
	r.dialers[sandboxID] = d
	d.run()
}

// verify proves a sandbox's channel is live end-to-end and repairs it if not.
// Detached: it must never sit on the claim path. Call it wherever a box is
// about to serve customer traffic after an idle spell — start() alone is not
// enough, because it is a no-op for an existing dialer and the dialer cannot
// tell a live channel from a zombie without asking the DO.
func (r *doDialerRegistry) verify(sandboxID string) {
	if !r.enabled() {
		return
	}
	r.mu.Lock()
	d := r.dialers[sandboxID]
	r.mu.Unlock()
	if d == nil {
		return
	}
	go d.verifyLive(doVerifyGrace)
}

// stop tears the dialer down deterministically so a reaped/hibernated box can't
// keep serving a stale channel. Idempotent.
func (r *doDialerRegistry) stop(sandboxID string) {
	if r == nil {
		return
	}
	r.mu.Lock()
	d := r.dialers[sandboxID]
	delete(r.dialers, sandboxID)
	r.mu.Unlock()
	if d != nil {
		d.close()
	}
}

// doDialer is one sandbox's reconnecting host→DO WebSocket. A single background
// goroutine owns the dial/serve/backoff loop until close() cancels it.
type doDialer struct {
	url       string
	token     string // per-sandbox connect token, presented as the 2nd WS subprotocol
	sandboxID string
	execFn    doExecFn

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
	// startedAt is when this dialer was created (i.e. claim time for a pool box),
	// so serveOnce can report how long the channel took to become usable.
	startedAt time.Time

	// Live connection state, published by serveOnce so verifyLive can probe the
	// channel from outside the serve loop (claim time). writeMu is the same
	// mutex serveOnce serializes data writes with — gorilla allows one writer.
	connMu  sync.Mutex
	conn    *websocket.Conn
	writeMu *sync.Mutex
	// lastPong is the unix-nano time of the most recent app-level pong.
	lastPong atomic.Int64
}

// setConn publishes (or clears) the live connection for out-of-loop probes.
func (d *doDialer) setConn(conn *websocket.Conn, writeMu *sync.Mutex) {
	d.connMu.Lock()
	d.conn, d.writeMu = conn, writeMu
	d.connMu.Unlock()
}

// sendAppPing writes a liveness frame. Returns false if there is no connection
// or the write fails.
func (d *doDialer) sendAppPing() bool {
	d.connMu.Lock()
	conn, writeMu := d.conn, d.writeMu
	d.connMu.Unlock()
	if conn == nil || writeMu == nil {
		return false
	}
	writeMu.Lock()
	defer writeMu.Unlock()
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return conn.WriteMessage(websocket.BinaryMessage, encodeExecResult(pingRequestID, 0, 0, "", "", "")) == nil
}

// dropConn closes the current connection so the blocked ReadMessage unwinds and
// loop() redials. Safe to call concurrently; a nil conn is a no-op.
func (d *doDialer) dropConn() {
	d.connMu.Lock()
	conn := d.conn
	d.connMu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
}

// verifyLive proves the channel end-to-end and repairs it if it can't. Called at
// claim, when the box is about to serve its first customer exec and a channel
// dialed at manufacture may have gone stale under it. Blocking for `grace` at
// most; callers run it detached so claim latency is untouched. A failed probe
// only costs a redial (~280ms), which the DO's own connect/reconnect grace
// absorbs — far cheaper than the tunnel fallback it replaces.
func (d *doDialer) verifyLive(grace time.Duration) {
	before := d.lastPong.Load()
	if !d.sendAppPing() {
		d.dropConn() // no usable conn — force the loop to redial now
		return
	}
	deadline := time.Now().Add(grace)
	for time.Now().Before(deadline) {
		if d.lastPong.Load() != before {
			return // DO answered — channel is genuinely live
		}
		select {
		case <-d.ctx.Done():
			return
		case <-time.After(20 * time.Millisecond):
		}
	}
	log.Printf("vmdo: %s failed liveness probe — dropping stale channel", d.sandboxID)
	d.dropConn()
}

func newDoDialer(url, token, sandboxID string, execFn doExecFn) *doDialer {
	ctx, cancel := context.WithCancel(context.Background())
	return &doDialer{url: url, token: token, sandboxID: sandboxID, execFn: execFn, ctx: ctx, cancel: cancel, startedAt: time.Now()}
}

func (d *doDialer) run() {
	d.wg.Add(1)
	go d.loop()
}

func (d *doDialer) close() {
	d.cancel()
	// Don't Wait() here: close() is called on the gRPC hot path (destroy /
	// hibernate) and the loop unwinds on its own once ctx is cancelled. The
	// blocked ReadMessage returns when the deferred conn.Close fires.
}

func (d *doDialer) loop() {
	defer d.wg.Done()
	backoff := doDialBackoffMin
	for {
		if d.ctx.Err() != nil {
			return
		}
		if d.serveOnce() {
			backoff = doDialBackoffMin // clean connection resets the ladder
		}
		if d.ctx.Err() != nil {
			return
		}
		select {
		case <-d.ctx.Done():
			return
		case <-time.After(backoff):
		}
		backoff *= 2
		if backoff > doDialBackoffMax {
			backoff = doDialBackoffMax
		}
	}
}

// serveOnce dials, serves the read loop until the socket drops, and returns true
// if the connection was established (so the caller can reset backoff).
func (d *doDialer) serveOnce() (connected bool) {
	dialer := websocket.Dialer{
		HandshakeTimeout: doHandshakeTimeout,
		// The DO echoes "oc-protobuf-v1"; offering the per-sandbox token as the
		// 2nd subprotocol carries the credential without a custom header (which
		// the CF edge upgrade wouldn't forward).
		Subprotocols: []string{wsSubprotocol, d.token},
	}
	conn, resp, err := dialer.DialContext(d.ctx, d.url, nil)
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		// Quiet on shutdown; a canceled ctx surfaces as a dial error.
		if d.ctx.Err() == nil {
			log.Printf("vmdo: dial %s failed (status=%d): %v", d.sandboxID, status, err)
		}
		return false
	}
	defer conn.Close()
	// Report time-from-start, not just "connected": every exec that arrives in
	// this window takes the tunnel (~300ms) instead of the DO path (~15ms), and
	// on a claimed box that window sits directly in front of the customer's
	// FIRST exec. This is the number that says whether the channel needs to be
	// pre-connected at stock-prep instead of at claim.
	log.Printf("vmdo: connected %s after %dms", d.sandboxID, time.Since(d.startedAt).Milliseconds())

	// Read deadline is the pong watchdog: every pong (and every inbound frame)
	// pushes it out; if pongs stop landing it fires and ReadMessage errors,
	// dropping us into the reconnect loop.
	_ = conn.SetReadDeadline(time.Now().Add(doPongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(doPongWait))
	})

	// gorilla permits one concurrent writer; execs reply from per-request
	// goroutines, so serialize data writes. Ping uses WriteControl, which
	// gorilla documents as safe alongside other methods.
	var writeMu sync.Mutex

	// Publish the connection so verifyLive can probe it at claim time, and seed
	// the pong clock so a fresh channel isn't immediately judged stale.
	d.lastPong.Store(time.Now().UnixNano())
	d.setConn(conn, &writeMu)
	defer d.setConn(nil, nil)

	pingCtx, stopPing := context.WithCancel(d.ctx)
	defer stopPing()
	go func() {
		ticker := time.NewTicker(doPingPeriod)
		defer ticker.Stop()
		for {
			select {
			case <-pingCtx.Done():
				return
			case <-ticker.C:
				if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(5*time.Second)); err != nil {
					return
				}
			}
		}
	}()

	// App-level liveness: the only signal that distinguishes "the DO holds this
	// socket" from "Cloudflare's edge is answering pings for a DO that doesn't".
	go func() {
		ticker := time.NewTicker(doAppPingPeriod)
		defer ticker.Stop()
		for {
			select {
			case <-pingCtx.Done():
				return
			case <-ticker.C:
				if !d.sendAppPing() {
					return
				}
				if age := time.Since(time.Unix(0, d.lastPong.Load())); age > doAppPongWait {
					log.Printf("vmdo: %s no app-pong for %s — reconnecting stale channel", d.sandboxID, age.Truncate(time.Second))
					_ = conn.Close() // unwinds ReadMessage → loop() redials
					return
				}
			}
		}
	}()

	// Close the conn when the dialer is cancelled so a blocked ReadMessage
	// unwinds promptly on destroy/hibernate.
	go func() {
		<-pingCtx.Done()
		_ = conn.Close()
	}()

	for {
		msgType, data, err := conn.ReadMessage()
		if err != nil {
			if d.ctx.Err() == nil {
				log.Printf("vmdo: read %s: %v", d.sandboxID, err)
			}
			return true
		}
		if msgType != websocket.BinaryMessage {
			continue
		}
		_ = conn.SetReadDeadline(time.Now().Add(doPongWait))
		req, derr := decodeExecRequest(data)
		if derr != nil {
			log.Printf("vmdo: bad exec frame %s: %v", d.sandboxID, derr)
			continue
		}
		if req.requestID == pingRequestID {
			d.lastPong.Store(time.Now().UnixNano()) // the DO answered — channel proven live
			continue
		}
		go d.handleExec(conn, &writeMu, req)
	}
}

// handleExec runs one decoded request against the agent and writes the result
// frame back. Any agent/transport failure is returned as the frame's error
// field, which the DO turns into a 409 so the edge retries via the tunnel.
func (d *doDialer) handleExec(conn *websocket.Conn, writeMu *sync.Mutex, req execRequest) {
	timeoutSec := int((req.timeoutMs + 999) / 1000)
	if timeoutSec <= 0 {
		timeoutSec = 60
	}
	// Cap the RPC a little past the command's own timeout so a wedged agent
	// call can't leak the goroutine.
	ctx, cancel := context.WithTimeout(d.ctx, time.Duration(timeoutSec)*time.Second+5*time.Second)
	defer cancel()

	started := time.Now()
	res, err := d.execFn(ctx, d.sandboxID, types.ProcessConfig{
		Command: req.command, // flattened shell string; manager.Exec wraps it in /bin/sh -c
		Env:     req.env,
		Cwd:     req.cwd,
		Timeout: timeoutSec,
	})
	durMs := uint32(time.Since(started).Milliseconds())

	var frame []byte
	if err != nil {
		frame = encodeExecResult(req.requestID, 1, durMs, "", "", err.Error())
	} else {
		stdout, stderr := capOutput(res.Stdout, res.Stderr)
		frame = encodeExecResult(req.requestID, int32(res.ExitCode), durMs, stdout, stderr, "")
	}

	writeMu.Lock()
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	werr := conn.WriteMessage(websocket.BinaryMessage, frame)
	writeMu.Unlock()
	if werr != nil && d.ctx.Err() == nil {
		log.Printf("vmdo: write result %s: %v", d.sandboxID, werr)
	}
}

// capOutput bounds the combined stdout+stderr so the result frame stays under
// the WebSocket message cap. stdout is favored (it carries the command result);
// stderr gets whatever budget remains. Truncation keeps the head of each stream,
// matching the tunnel scrollback's behavior for parity.
func capOutput(stdout, stderr string) (string, string) {
	if len(stdout)+len(stderr) <= doMaxOutputBytes {
		return stdout, stderr
	}
	if len(stdout) >= doMaxOutputBytes {
		return stdout[:doMaxOutputBytes], ""
	}
	remaining := doMaxOutputBytes - len(stdout)
	if len(stderr) > remaining {
		stderr = stderr[:remaining]
	}
	return stdout, stderr
}

// ── protobuf codec (opencomputer.edge.v1 ExecRequest/ExecResult) ────────────
// Hand-rolled to match cloudflare-workers/api-edge/src/protocol.ts byte-for-byte
// without pulling in a generated stub. ExecRequest is decoded (DO→host);
// ExecResult is encoded (host→DO).

type execRequest struct {
	requestID uint32
	command   string
	cwd       string
	timeoutMs uint32
	env       map[string]string
}

func decodeExecRequest(buf []byte) (execRequest, error) {
	r := execRequest{env: map[string]string{}}
	i := 0
	for i < len(buf) {
		tag, n := binary.Uvarint(buf[i:])
		if n <= 0 {
			return r, fmt.Errorf("bad tag varint")
		}
		i += n
		field := tag >> 3
		wire := tag & 7
		switch {
		case field == 1 && wire == 0:
			v, m, err := readUvarint(buf, i)
			if err != nil {
				return r, err
			}
			r.requestID = uint32(v)
			i = m
		case field == 2 && wire == 2:
			v, m, err := readBytes(buf, i)
			if err != nil {
				return r, err
			}
			r.command = string(v)
			i = m
		case field == 3 && wire == 2:
			v, m, err := readBytes(buf, i)
			if err != nil {
				return r, err
			}
			r.cwd = string(v)
			i = m
		case field == 4 && wire == 0:
			v, m, err := readUvarint(buf, i)
			if err != nil {
				return r, err
			}
			r.timeoutMs = uint32(v)
			i = m
		case field == 5 && wire == 2:
			v, m, err := readBytes(buf, i)
			if err != nil {
				return r, err
			}
			k, val := decodeEnvEntry(v)
			r.env[k] = val
			i = m
		default:
			m, err := skipField(buf, i, wire)
			if err != nil {
				return r, err
			}
			i = m
		}
	}
	// requestID 0 is the reserved liveness pong (empty command by construction) —
	// it is a valid frame, not a malformed exec, and the caller dispatches on it
	// before ever looking at the command.
	if r.requestID == pingRequestID {
		return r, nil
	}
	if r.command == "" {
		return r, fmt.Errorf("request_id and command are required")
	}
	return r, nil
}

// decodeEnvEntry parses a map<string,string> entry message ({1:key, 2:value}).
func decodeEnvEntry(buf []byte) (key, value string) {
	i := 0
	for i < len(buf) {
		tag, n := binary.Uvarint(buf[i:])
		if n <= 0 {
			return
		}
		i += n
		field := tag >> 3
		wire := tag & 7
		if wire != 2 {
			m, err := skipField(buf, i, wire)
			if err != nil {
				return
			}
			i = m
			continue
		}
		v, m, err := readBytes(buf, i)
		if err != nil {
			return
		}
		if field == 1 {
			key = string(v)
		} else if field == 2 {
			value = string(v)
		}
		i = m
	}
	return
}

func readUvarint(buf []byte, i int) (uint64, int, error) {
	v, n := binary.Uvarint(buf[i:])
	if n <= 0 {
		return 0, i, fmt.Errorf("truncated varint")
	}
	return v, i + n, nil
}

func readBytes(buf []byte, i int) ([]byte, int, error) {
	l, n := binary.Uvarint(buf[i:])
	if n <= 0 {
		return nil, i, fmt.Errorf("truncated length")
	}
	i += n
	end := i + int(l)
	if end > len(buf) || end < i {
		return nil, i, fmt.Errorf("truncated bytes")
	}
	return buf[i:end], end, nil
}

func skipField(buf []byte, i int, wire uint64) (int, error) {
	switch wire {
	case 0:
		_, n := binary.Uvarint(buf[i:])
		if n <= 0 {
			return i, fmt.Errorf("truncated varint")
		}
		return i + n, nil
	case 2:
		_, m, err := readBytes(buf, i)
		return m, err
	default:
		return i, fmt.Errorf("unsupported wire type %d", wire)
	}
}

func encodeExecResult(requestID uint32, exitCode int32, durationMs uint32, stdout, stderr, errStr string) []byte {
	var b bytes.Buffer
	writeVarintField(&b, 1, uint64(requestID))
	writeVarintField(&b, 2, uint64(zigzag32(exitCode)))
	writeVarintField(&b, 3, uint64(durationMs))
	writeBytesField(&b, 4, []byte(stdout))
	writeBytesField(&b, 5, []byte(stderr))
	if errStr != "" {
		writeBytesField(&b, 6, []byte(errStr))
	}
	return b.Bytes()
}

func writeVarintField(b *bytes.Buffer, field int, v uint64) {
	writeUvarint(b, uint64(field)<<3|0)
	writeUvarint(b, v)
}

func writeBytesField(b *bytes.Buffer, field int, v []byte) {
	writeUvarint(b, uint64(field)<<3|2)
	writeUvarint(b, uint64(len(v)))
	b.Write(v)
}

func writeUvarint(b *bytes.Buffer, v uint64) {
	var tmp [binary.MaxVarintLen64]byte
	n := binary.PutUvarint(tmp[:], v)
	b.Write(tmp[:n])
}

func zigzag32(v int32) uint32 {
	return uint32((v << 1) ^ (v >> 31))
}
