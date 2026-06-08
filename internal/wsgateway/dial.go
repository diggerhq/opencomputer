package wsgateway

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"

	"github.com/gorilla/websocket"
)

// ErrUpstreamMigrating is the sentinel the ResolveWorker closure (in
// internal/api/ws_broker.go) returns wrapped via errors.Join when the
// cell-CP reports the sandbox is mid-migration. The broker's runRedial
// recognizes it and switches to the longer migration backoff cadence
// instead of burning the fast-ladder budget on a guaranteed-to-fail dial.
var ErrUpstreamMigrating = errors.New("upstream migrating")

// DialResult classifies an upstream dial outcome so the redial loop can
// pick the right backoff policy. Either Conn is non-nil (success), or
// one of the Terminal/Migrating flags drives the loop's next action.
type DialResult struct {
	Conn        *websocket.Conn
	Resp        *http.Response
	Terminal    bool   // 404 or 410 — resource gone permanently, close client with reason
	Migrating   bool   // 503 + body matches /migrating/ — switch to long backoff
	Status      int    // last response status (0 if dial threw before headers)
	BodySnippet string // first 200 bytes of error body if any, for logging
	Err         error  // the underlying error from gorilla/websocket
}

var migratingPattern = regexp.MustCompile(`(?i)migrating`)

// DialUpstream attempts a single WebSocket upgrade against workerWSURL,
// passing the bearer token as Authorization. Returns a DialResult the
// caller uses to decide whether to retry, swap to migration backoff, or
// give up with a terminal close.
func DialUpstream(workerWSURL, token string) DialResult {
	header := http.Header{}
	if token != "" {
		header.Set("Authorization", "Bearer "+token)
	}
	dialer := websocket.Dialer{
		HandshakeTimeout: HandshakeTimeout,
	}
	conn, resp, err := dialer.Dial(workerWSURL, header)
	if err == nil {
		return DialResult{Conn: conn, Resp: resp}
	}
	status := 0
	body := ""
	if resp != nil {
		status = resp.StatusCode
		body = snippet(resp.Body)
	}
	terminal := status == http.StatusNotFound || status == http.StatusGone
	migrating := status == http.StatusServiceUnavailable && migratingPattern.MatchString(body)
	return DialResult{
		Resp:        resp,
		Terminal:    terminal,
		Migrating:   migrating,
		Status:      status,
		BodySnippet: body,
		Err:         err,
	}
}

// Note returns a compact one-line description of the dial outcome for
// logging — chosen to mirror the DO's "status=X body=Y" format.
func (r DialResult) Note() string {
	if r.Conn != nil {
		return "ok"
	}
	parts := []string{fmt.Sprintf("status=%d", r.Status)}
	if r.BodySnippet != "" {
		parts = append(parts, "body="+r.BodySnippet)
	}
	if r.Err != nil && !errors.Is(r.Err, websocket.ErrBadHandshake) {
		parts = append(parts, "err="+r.Err.Error())
	}
	if r.Terminal {
		parts = append(parts, "(terminal)")
	}
	if r.Migrating {
		parts = append(parts, "(migrating)")
	}
	return strings.Join(parts, " ")
}

// snippet drains up to 200 bytes from r and returns it as a string for
// log/error-body use. Closes the body before returning.
func snippet(r io.ReadCloser) string {
	if r == nil {
		return ""
	}
	defer r.Close()
	buf := make([]byte, 200)
	n, _ := io.ReadFull(r, buf)
	if n == 0 {
		return ""
	}
	return strings.TrimSpace(string(buf[:n]))
}
