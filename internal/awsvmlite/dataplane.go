package awsvmlite

// dataplane.go — everything a customer can do to a sandbox that is not exec.
//
// Files, stats, reboot and preview ports, reached the same way exec is: one
// authenticated HTTPS request to the box's own endpoint, answered by
// cmd/microvm-hooks inside the guest. There is no tunnel here either.
//
// WHY THIS IS POSSIBLE NOW AND WAS NOT BEFORE. The direct path gave these up
// because the agent speaks gRPC and Lambda's proxy strips the HTTP/2 trailers
// gRPC reports status in — a reply arrives with the work done and the result
// missing. That is a property of the PROXY HOP. Inside the guest, loopback gRPC
// to the agent is fine, so the hook server translates: plain JSON out here,
// gRPC in there. See cmd/microvm-hooks/oc.go.
//
// NOTHING HERE IS ON THE HOT PATH. Create claims a warm box and exec is still a
// single POST to runCmdPath; no handler below is reached by either, and the
// shared transport they use is the one exec already keeps warm.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/opensandbox/opensandbox/internal/sandbox"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// The guest front door. These must match cmd/microvm-hooks/oc.go.
//
// The /oc prefix is the new one; the guest still serves the older /osb paths
// for exec and claim, which is what lets an image roll without a lockstep
// control-plane deploy. Everything defined here is new, so it is /oc only —
// there is no older caller to keep working.
const (
	ocFSRead     = "/oc/fs/read"
	ocFSWrite    = "/oc/fs/write"
	ocFSList     = "/oc/fs/list"
	ocFSMkdir    = "/oc/fs/mkdir"
	ocFSRemove   = "/oc/fs/rm"
	ocFSExists   = "/oc/fs/exists"
	ocFSStat     = "/oc/fs/stat"
	ocFSDownload = "/oc/fs/download"
	ocFSUpload   = "/oc/fs/upload"
	ocStats      = "/oc/stats"
	ocReboot     = "/oc/reboot"
	ocEnvs       = "/oc/envs"
)

// fsTimeout bounds a buffered filesystem call from this side. The guest applies
// its own; this one exists so a wedged box cannot pin a control-plane request.
const fsTimeout = 60 * time.Second

// rebootTimeout covers killing the workload and waiting for the agent to come
// back. Well above the ~1s it takes, because reporting a failed reboot for one
// that actually succeeded leaves the customer's view and the box disagreeing.
const rebootTimeout = 45 * time.Second

// fsRequest is the body every buffered filesystem endpoint takes.
type fsRequest struct {
	Path    string `json:"path"`
	Content []byte `json:"content,omitempty"`
	Mode    uint32 `json:"mode,omitempty"`
}

// call issues one request to a bound sandbox's guest and decodes the reply into
// out (nil to discard it).
//
// The single place the box lookup, the status check and the error shaping live,
// so a new endpoint is one method rather than forty lines of the same handling.
func (m *Manager) call(ctx context.Context, sandboxID, method, path string, body, out any) error {
	// Every customer-facing dataplane op funnels through here — files, stats,
	// reboot, exec sessions, PTY create — so this is where activity is
	// recorded. Deliberately NOT in do(), which the keepalive also uses: the
	// keepalive must never look like the customer. See idle.go.
	m.MarkUsed(sandboxID)
	b, ok := m.BoxFor(sandboxID)
	if !ok {
		return fmt.Errorf("awsvmlite: no box bound to %s", sandboxID)
	}
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return err
		}
	}
	resp, err := m.do(ctx, b, method, path, payload)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return httpError{
			status: resp.StatusCode,
			op:     path,
			msg:    strings.TrimSpace(string(msg)),
		}
	}
	// Any successful call is real inbound proxy traffic on this box, so it
	// counts as a touch — a sandbox being actively used through files alone
	// should not also be probed on schedule.
	m.stampTouch(b)

	if out == nil {
		return nil
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 64<<20)).Decode(out)
}

// httpError carries the guest's status code back to the API layer.
//
// The code is the payload. cmd/microvm-hooks maps the agent's gRPC codes onto
// HTTP deliberately so that "no such file" survives the trip as a 404; throwing
// that away here and returning a bare error would collapse it back into a 500
// and make the SDK retry a read that can never succeed.
type httpError struct {
	status int
	op     string
	msg    string
}

func (e httpError) Error() string {
	return fmt.Sprintf("awsvmlite: %s: http %d: %s", e.op, e.status, e.msg)
}

// StatusCode exposes the guest's status for the API layer's error mapping.
func (e httpError) StatusCode() int { return e.status }

// NotFound reports whether this was the guest saying the path does not exist.
func (e httpError) NotFound() bool { return e.status == http.StatusNotFound }

// ── filesystem ──────────────────────────────────────────────────────────────

func (m *Manager) ReadFile(ctx context.Context, sandboxID, path string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, fsTimeout)
	defer cancel()
	var out struct {
		Content []byte `json:"content"`
	}
	if err := m.call(ctx, sandboxID, http.MethodPost, ocFSRead, fsRequest{Path: path}, &out); err != nil {
		return "", err
	}
	return string(out.Content), nil
}

func (m *Manager) WriteFile(ctx context.Context, sandboxID, path, content string) error {
	ctx, cancel := context.WithTimeout(ctx, fsTimeout)
	defer cancel()
	return m.call(ctx, sandboxID, http.MethodPost, ocFSWrite,
		fsRequest{Path: path, Content: []byte(content)}, nil)
}

func (m *Manager) ListDir(ctx context.Context, sandboxID, path string) ([]types.EntryInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, fsTimeout)
	defer cancel()
	var out struct {
		Entries []types.EntryInfo `json:"entries"`
	}
	if err := m.call(ctx, sandboxID, http.MethodPost, ocFSList, fsRequest{Path: path}, &out); err != nil {
		return nil, err
	}
	return out.Entries, nil
}

func (m *Manager) MakeDir(ctx context.Context, sandboxID, path string) error {
	ctx, cancel := context.WithTimeout(ctx, fsTimeout)
	defer cancel()
	return m.call(ctx, sandboxID, http.MethodPost, ocFSMkdir, fsRequest{Path: path}, nil)
}

func (m *Manager) Remove(ctx context.Context, sandboxID, path string) error {
	ctx, cancel := context.WithTimeout(ctx, fsTimeout)
	defer cancel()
	return m.call(ctx, sandboxID, http.MethodPost, ocFSRemove, fsRequest{Path: path}, nil)
}

func (m *Manager) Exists(ctx context.Context, sandboxID, path string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, fsTimeout)
	defer cancel()
	var out struct {
		Exists bool `json:"exists"`
	}
	if err := m.call(ctx, sandboxID, http.MethodPost, ocFSExists, fsRequest{Path: path}, &out); err != nil {
		return false, err
	}
	return out.Exists, nil
}

func (m *Manager) Stat(ctx context.Context, sandboxID, path string) (*types.FileInfo, error) {
	ctx, cancel := context.WithTimeout(ctx, fsTimeout)
	defer cancel()
	var out types.FileInfo
	if err := m.call(ctx, sandboxID, http.MethodPost, ocFSStat, fsRequest{Path: path}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ── streaming filesystem ────────────────────────────────────────────────────
//
// Neither of these buffers the file. Only trailers die on the proxy hop; a body
// streams through it untouched, which is what makes a large transfer possible
// on a path that cannot carry gRPC.

// ReadFileStream returns an open body the caller must close, plus the size when
// the guest reported one (-1 when it did not).
func (m *Manager) ReadFileStream(ctx context.Context, sandboxID, path string) (io.ReadCloser, int64, error) {
	b, ok := m.BoxFor(sandboxID)
	if !ok {
		return nil, 0, fmt.Errorf("awsvmlite: no box bound to %s", sandboxID)
	}
	// No timeout on the context: this is a download of unknown size and the
	// caller owns how long it is willing to wait. A deadline here would cut a
	// large but perfectly healthy transfer off mid-file.
	resp, err := m.do(ctx, b, http.MethodGet,
		ocFSDownload+"?path="+urlQueryEscape(path), nil)
	if err != nil {
		return nil, 0, err
	}
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		resp.Body.Close()
		return nil, 0, httpError{status: resp.StatusCode, op: ocFSDownload, msg: strings.TrimSpace(string(msg))}
	}
	m.stampTouch(b)
	size := int64(-1)
	if cl := resp.Header.Get("Content-Length"); cl != "" {
		if n, err := strconv.ParseInt(cl, 10, 64); err == nil {
			size = n
		}
	}
	return resp.Body, size, nil
}

// WriteFileStream streams r into the guest and reports how many bytes landed.
func (m *Manager) WriteFileStream(ctx context.Context, sandboxID, path string, mode uint32, r io.Reader) (int64, error) {
	b, ok := m.BoxFor(sandboxID)
	if !ok {
		return 0, fmt.Errorf("awsvmlite: no box bound to %s", sandboxID)
	}
	q := ocFSUpload + "?path=" + urlQueryEscape(path)
	if mode != 0 {
		q += "&mode=" + strconv.FormatUint(uint64(mode), 8)
	}
	resp, err := m.doStream(ctx, b, http.MethodPut, q, r)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return 0, httpError{status: resp.StatusCode, op: ocFSUpload, msg: strings.TrimSpace(string(msg))}
	}
	m.stampTouch(b)
	var out struct {
		BytesWritten int64 `json:"bytesWritten"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&out); err != nil {
		return 0, err
	}
	return out.BytesWritten, nil
}

// ── environment ─────────────────────────────────────────────────────────────

// SetEnvs applies the sandbox's environment to everything it subsequently runs.
//
// ON THE CREATE PATH, and therefore the one thing in this file that has to
// justify its latency. It costs exactly one request, and only when a create
// actually carried envs — the caller skips it otherwise (see liteBackend.
// Activate), so the default-shape create the benchmark measures is untouched.
//
// It has to happen before the create returns rather than in the background: the
// customer's first exec can arrive the instant they have the sandbox id, and an
// environment that arrives afterwards would apply to some of their commands and
// not others, non-deterministically.
func (m *Manager) SetEnvs(ctx context.Context, sandboxID string, envs map[string]string) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	return m.call(ctx, sandboxID, http.MethodPost, ocEnvs,
		map[string]any{"envs": envs}, nil)
}

// ── monitoring ──────────────────────────────────────────────────────────────

func (m *Manager) Stats(ctx context.Context, sandboxID string) (*sandbox.SandboxStats, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	var out sandbox.SandboxStats
	if err := m.call(ctx, sandboxID, http.MethodGet, ocStats, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ── reboot ──────────────────────────────────────────────────────────────────

// Reboot restarts the sandbox's workload in place.
//
// Not a kernel restart — there is no way to restart a MicroVM's guest kernel,
// and the agent-path backend's answer to that was to launch a REPLACEMENT box
// and copy the workspace across (a ~3.3s floor plus the size of the workspace,
// losing anything installed outside /home/sandbox). This kills every process
// the sandbox user owns and restarts the agent instead: nothing of the
// customer's is running afterwards, no shell state or listening port survives,
// and the disk is untouched — so it preserves strictly more than the old path
// did, in a fraction of the time and without moving a byte.
func (m *Manager) Reboot(ctx context.Context, sandboxID string) error {
	ctx, cancel := context.WithTimeout(ctx, rebootTimeout)
	defer cancel()
	return m.call(ctx, sandboxID, http.MethodPost, ocReboot, nil, nil)
}

// ── endpoint ────────────────────────────────────────────────────────────────

// PreviewTarget returns what a caller needs to reach a port inside the guest:
// the box's HTTPS host, its proxy auth token, and the proxy port header value.
//
// The path prefix is the caller's to add (see ocPortPrefix in the guest). This
// returns the pieces rather than a URL because the proxy hop needs two headers
// that a URL cannot carry.
func (m *Manager) PreviewTarget(sandboxID string) (host, token string, proxyPort int32, err error) {
	b, ok := m.BoxFor(sandboxID)
	if !ok {
		return "", "", 0, fmt.Errorf("awsvmlite: no box bound to %s", sandboxID)
	}
	// Refreshed, not Box.Token: a preview URL is reached long after the box was
	// launched, which is precisely when the launch-time token is dead.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return hostOnly(b.Endpoint), m.token(ctx, b), b.Port, nil
}

// doStream is do() for a request whose body is a stream of unknown length.
//
// Separate from do() rather than a parameter on it: do() marshals a []byte and
// sets Content-Length from it, and the whole point here is to have neither. Go
// sends this chunked, which the proxy forwards unchanged.
func (m *Manager) doStream(ctx context.Context, b *Box, method, path string, body io.Reader) (*http.Response, error) {
	host := hostOnly(b.Endpoint)
	req, err := http.NewRequestWithContext(ctx, method, "https://"+host+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-aws-proxy-auth", m.token(ctx, b))
	req.Header.Set("X-aws-proxy-port", strconv.FormatInt(int64(b.Port), 10))
	req.Header.Set("Content-Type", "application/octet-stream")
	return m.http.Do(req)
}

// urlQueryEscape escapes a path for use in a query string.
//
// Spelled out rather than reaching for url.Values because a path is the one
// argument every one of these endpoints takes, and getting it wrong is silent:
// an unescaped `&` or `#` in a filename truncates the path and the guest
// operates on the wrong file.
func urlQueryEscape(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '-', c == '_', c == '.', c == '~', c == '/':
			b.WriteByte(c)
		default:
			b.WriteString(fmt.Sprintf("%%%02X", c))
		}
	}
	return b.String()
}

// token returns a currently-valid proxy auth token for a box.
//
// NOT Box.Token, which is the token minted when the box was launched and is
// frozen there forever. AWS caps these at 60 minutes, so a box that sits in the
// warm set or stays bound for longer than that carries a DEAD credential — and
// every request against it then fails with a proxy 403, permanently, because
// nothing refreshes it and nothing evicts on 403 either.
//
// Found on dev by dropping the warm pool to 1: the single box sat for an hour,
// and every operation on the sandbox that claimed it failed while freshly
// created sandboxes passed. A deep pool hides this completely — boxes churn
// well inside an hour — which is exactly why it survived every burst benchmark.
// A real customer's sandbox would have stopped working after an hour.
//
// Client.AuthToken already caches per box and re-mints at 75% of lifetime, so
// this is a map lookup on all but roughly one call per box per 45 minutes.
func (m *Manager) token(ctx context.Context, b *Box) string {
	if m.client == nil {
		// Unit tests build a Manager with no AWS client; the launch-time value
		// is all there is, and there is no proxy to reject it.
		return b.Token
	}
	tok, err := m.client.AuthToken(ctx, b.MicrovmID)
	if err != nil {
		// Fall back rather than fail: a stale token might still be inside its
		// hour, and a transient AWS error must not take out a live sandbox.
		log.Printf("awsvmlite: refresh auth token for %s: %v (using the launch-time token)", b.MicrovmID, err)
		return b.Token
	}
	return tok
}
