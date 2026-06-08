package wsgateway

import (
	"errors"
	"log"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// Session owns one client WebSocket and brokers it against the upstream
// worker WS. The upstream conn changes across redials; the client conn
// is fixed for the session's lifetime. All writes to either conn are
// serialized via clientMu/upstreamMu — gorilla/websocket connections
// are not goroutine-safe for concurrent writes.
//
// The Run() method is the per-session goroutine entry point. It handles
// initial dial, starts upstream + client read pumps, drives the redial
// loop on upstream close, and cleans up.
type Session struct {
	actor     *sandboxActor
	sandboxID string
	sessionID string
	cellPath  string

	// isExec drives v6 exit-marker tracking. Set once from the path —
	// /exec/ or /agent/ → true; /pty/ → false.
	isExec bool

	clientWS *websocket.Conn
	clientMu sync.Mutex // serializes writes to clientWS

	upstreamMu sync.RWMutex
	upstreamWS *websocket.Conn

	// workerWSURL is the cell-CP→worker URL. Recomputed on each redial
	// from the worker registry so a worker_id change (mid-flight migration
	// that completed) routes correctly.
	workerWSURLFn func() (string, string, error) // returns (url, token, error)

	// v6 exec-exit marker. Set when a 5-byte 0x03+exitCode frame arrives
	// from upstream. On the next upstream close, the broker closes the
	// client cleanly instead of redialing.
	execExited atomic.Bool

	// Circuit breaker — bounded slice of recent startRedial timestamps.
	flapMu      sync.Mutex
	redialTimes []time.Time

	closeOnce sync.Once
	done      chan struct{}
}

// Run is the per-session goroutine entry. Blocks until the session
// terminates. Caller is the sandbox actor; it removes the session
// from its map after Run returns.
func (s *Session) Run() {
	defer s.close()

	// Initial dial.
	url, token, err := s.workerWSURLFn()
	if err != nil {
		log.Printf("wsgateway: initial url resolve failed sandbox=%s session=%s: %v", s.sandboxID, s.sessionID, err)
		s.closeClient(websocket.CloseInternalServerErr, "upstream resolve failed")
		return
	}
	dial := DialUpstream(url, token)
	if dial.Conn == nil {
		log.Printf("wsgateway: initial dial failed sandbox=%s session=%s %s", s.sandboxID, s.sessionID, dial.Note())
		if dial.Terminal {
			s.closeClient(websocket.CloseNormalClosure, terminalReason(dial))
		} else {
			s.closeClient(websocket.CloseInternalServerErr, "upstream connect failed")
		}
		return
	}
	s.setUpstream(dial.Conn)

	log.Printf("wsgateway: opened sandbox=%s session=%s path=%s", s.sandboxID, s.sessionID, s.cellPath)

	// Start client reader (reads from client, writes to current upstream).
	clientDone := make(chan struct{})
	go s.pumpClientToUpstream(clientDone)

	// Start upstream reader. Loop here so a redial can restart it with a
	// new upstream while the same client conn stays attached.
	upstreamDone := make(chan struct{})
	go s.pumpUpstreamToClient(dial.Conn, upstreamDone)

	for {
		select {
		case <-clientDone:
			// Client went away; tear down upstream and exit.
			s.upstreamClose(websocket.CloseNormalClosure, "client closed")
			return

		case <-upstreamDone:
			// Upstream closed. If exec exited, that's the natural end.
			if s.execExited.Load() {
				log.Printf("wsgateway: exec exited — closing client sandbox=%s session=%s", s.sandboxID, s.sessionID)
				s.closeClient(websocket.CloseNormalClosure, "exec completed")
				return
			}
			// Circuit breaker — too many flaps in the window.
			if !s.recordRedial() {
				log.Printf("wsgateway: redial flap threshold hit sandbox=%s session=%s — closing client", s.sandboxID, s.sessionID)
				s.closeClient(websocket.CloseInternalServerErr, "upstream flapping")
				return
			}
			// Drive the redial loop. New upstream conn replaces the old;
			// kick off a new pump goroutine. Pass clientDone so the loop
			// bails immediately if the client disconnects mid-backoff
			// instead of wasting the full ~25s window.
			newUp, terminal, reason, ok := s.runRedial(clientDone)
			if !ok {
				log.Printf("wsgateway: redial exhausted sandbox=%s session=%s", s.sandboxID, s.sessionID)
				if terminal {
					s.closeClient(websocket.CloseNormalClosure, reason)
				} else {
					s.closeClient(websocket.CloseInternalServerErr, "upstream unrecoverable")
				}
				return
			}
			s.setUpstream(newUp)
			upstreamDone = make(chan struct{})
			go s.pumpUpstreamToClient(newUp, upstreamDone)

		case <-s.done:
			return
		}
	}
}

// pumpClientToUpstream reads frames from the client WS and writes them
// to whichever upstream is currently bound on the session. Exits when
// the client closes or errors; signals via done.
//
// Frames sent during a redial window (upstream temporarily nil or
// closed) are dropped silently — matches the DO's behavior. Bidirectional
// buffering of client→upstream is a deliberate non-goal here (the
// session would have to choose how much to buffer; SDK retries handle it).
func (s *Session) pumpClientToUpstream(done chan struct{}) {
	defer close(done)
	for {
		mt, data, err := s.clientWS.ReadMessage()
		if err != nil {
			return
		}
		s.upstreamMu.RLock()
		u := s.upstreamWS
		s.upstreamMu.RUnlock()
		if u == nil {
			continue // drop during redial window
		}
		if err := writeOne(u, &s.upstreamMu, mt, data); err != nil {
			// Don't return — upstream might come back via redial. The
			// upstream reader will detect the close and trigger redial.
			continue
		}
	}
}

// pumpUpstreamToClient reads from the specific upstream conn passed in
// (does NOT swap on redial — a fresh goroutine is started for each new
// upstream by the session main loop). Forwards every frame to the
// client. Watches for the exec exit marker.
func (s *Session) pumpUpstreamToClient(upstream *websocket.Conn, done chan struct{}) {
	defer close(done)
	for {
		mt, data, err := upstream.ReadMessage()
		if err != nil {
			return
		}
		// v6 exec-exit detection. 5-byte binary frame, leading 0x03.
		if s.isExec && mt == websocket.BinaryMessage && len(data) == ExecExitMarkerLen && data[0] == ExecExitMarkerTag {
			s.execExited.Store(true)
		}
		if err := writeOne(s.clientWS, &s.clientMu, mt, data); err != nil {
			return
		}
	}
}

// runRedial walks the backoff ladder, dialing the upstream each tick.
// Returns (conn, terminal, reason, ok). On terminal failure (sandbox
// stopped, 404/410), terminal=true and reason carries the close message;
// ok=false. On success, ok=true and conn is the new upstream. On
// exhausted attempts or client disconnect during backoff, ok=false and
// terminal=false.
//
// Switches to migration cadence on first 503/migrating.
//
// clientDone is the channel pumpClientToUpstream closes when the client
// disconnects — selected on during each backoff sleep so we don't spend
// 25s+ in a dead loop when the user already hung up.
func (s *Session) runRedial(clientDone <-chan struct{}) (*websocket.Conn, bool, string, bool) {
	log.Printf("wsgateway: redial start sandbox=%s session=%s", s.sandboxID, s.sessionID)

	inMigration := false
	attempt := 0
	for {
		var delay time.Duration
		var limit int
		if inMigration {
			delay = MigrationBackoff
			limit = MigrationMaxAttempts
		} else {
			if attempt >= len(RedialBackoffMS) {
				return nil, false, "", false
			}
			delay = RedialBackoffMS[attempt]
			limit = len(RedialBackoffMS)
		}
		if attempt >= limit {
			return nil, false, "", false
		}

		select {
		case <-time.After(delay):
		case <-clientDone:
			log.Printf("wsgateway: redial: client gone during backoff sandbox=%s session=%s", s.sandboxID, s.sessionID)
			return nil, false, "", false
		case <-s.done:
			return nil, false, "", false
		}

		url, token, err := s.workerWSURLFn()
		if err != nil {
			log.Printf("wsgateway: redial: url resolve failed sandbox=%s session=%s: %v", s.sandboxID, s.sessionID, err)
			// Cell-CP says the sandbox is gone for good (DELETEd, stopped,
			// errored, never existed). Close the client cleanly with the
			// reason from the wrapped error instead of burning attempts.
			if errors.Is(err, ErrUpstreamTerminal) {
				reason := terminalReasonFromErr(err)
				log.Printf("wsgateway: redial: cell reports terminal (resolve, reason=%q) — closing client sandbox=%s", reason, s.sandboxID)
				return nil, true, reason, false
			}
			// Cell-CP signaling "currently migrating" → switch to the
			// longer cadence (no point burning fast-ladder attempts at a
			// resolve that's deterministically going to fail until the
			// migration commits).
			if errors.Is(err, ErrUpstreamMigrating) && !inMigration {
				log.Printf("wsgateway: redial: cell reports migrating (resolve) — switching to migration backoff sandbox=%s", s.sandboxID)
				inMigration = true
				attempt = 0
				continue
			}
			attempt++
			continue
		}

		log.Printf("wsgateway: redial: attempt %d/%d sandbox=%s session=%s → %s%s",
			attempt+1, limit, s.sandboxID, s.sessionID, url,
			func() string {
				if inMigration {
					return " (migrating)"
				}
				return ""
			}())

		dial := DialUpstream(url, token)
		if dial.Conn != nil {
			log.Printf("wsgateway: redial: success on attempt %d sandbox=%s session=%s", attempt+1, s.sandboxID, s.sessionID)
			return dial.Conn, false, "", true
		}
		log.Printf("wsgateway: redial: attempt %d failed — %s", attempt+1, dial.Note())
		if dial.Terminal {
			return nil, true, terminalReason(dial), false
		}
		if dial.Migrating && !inMigration {
			log.Printf("wsgateway: redial: switching to migration backoff sandbox=%s session=%s", s.sandboxID, s.sessionID)
			inMigration = true
			attempt = 0
			continue
		}
		attempt++
	}
}

// recordRedial appends the current time to the recent-cycles slice and
// returns true if we're still under the flap threshold within the
// window. Returns false when threshold is reached → caller closes client.
func (s *Session) recordRedial() bool {
	s.flapMu.Lock()
	defer s.flapMu.Unlock()
	now := time.Now()
	cutoff := now.Add(-RedialFlapWindow)
	pruned := s.redialTimes[:0]
	for _, t := range s.redialTimes {
		if t.After(cutoff) {
			pruned = append(pruned, t)
		}
	}
	s.redialTimes = pruned
	if len(s.redialTimes) >= RedialFlapThreshold {
		return false
	}
	s.redialTimes = append(s.redialTimes, now)
	return true
}

// Keepalive sends an empty binary frame on both ends. Called by the
// sandbox actor's ticker every AlarmInterval. Empty frames are no-ops
// on every receiver — see the file header in the worker handlers and
// the agent for proof. Defends middleboxes against idle drop.
func (s *Session) Keepalive() {
	s.upstreamMu.RLock()
	u := s.upstreamWS
	s.upstreamMu.RUnlock()
	if u != nil {
		_ = writeOne(u, &s.upstreamMu, websocket.BinaryMessage, nil)
	}
	_ = writeOne(s.clientWS, &s.clientMu, websocket.BinaryMessage, nil)
}

// setUpstream swaps the bound upstream conn atomically. Old conn is NOT
// closed here — caller decides whether the old conn is already closed
// (the usual case after redial) or needs a goodbye frame (rare).
func (s *Session) setUpstream(c *websocket.Conn) {
	s.upstreamMu.Lock()
	s.upstreamWS = c
	s.upstreamMu.Unlock()
}

// closeClient sends a close frame to the client and tears down the
// session. Idempotent.
func (s *Session) closeClient(code int, reason string) {
	s.clientMu.Lock()
	_ = s.clientWS.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(code, reason),
		time.Now().Add(time.Second),
	)
	s.clientMu.Unlock()
	_ = s.clientWS.Close()
}

// upstreamClose tears down the current upstream conn (used when the
// client disconnects so the worker also sees an upstream close).
func (s *Session) upstreamClose(code int, reason string) {
	s.upstreamMu.Lock()
	u := s.upstreamWS
	s.upstreamWS = nil
	s.upstreamMu.Unlock()
	if u == nil {
		return
	}
	_ = u.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(code, reason),
		time.Now().Add(time.Second),
	)
	_ = u.Close()
}

// close is the session's terminal cleanup. Closes both conns, signals
// done, and notifies the actor so it can drop the entry.
func (s *Session) close() {
	s.closeOnce.Do(func() {
		close(s.done)
		_ = s.clientWS.Close()
		s.upstreamMu.Lock()
		u := s.upstreamWS
		s.upstreamWS = nil
		s.upstreamMu.Unlock()
		if u != nil {
			_ = u.Close()
		}
		s.actor.removeSession(s)
	})
}

// writeOne sends a single WS message holding the given lock, with a
// bounded deadline. Returns error on write failure or closed conn so
// the caller can decide whether to drop, retry, or tear down. Accepts
// sync.Locker so callers can pass either a *sync.Mutex (clientMu) or
// the write half of a *sync.RWMutex (upstreamMu).
func writeOne(c *websocket.Conn, mu sync.Locker, mt int, data []byte) error {
	mu.Lock()
	defer mu.Unlock()
	_ = c.SetWriteDeadline(time.Now().Add(WriteTimeout))
	return c.WriteMessage(mt, data)
}

// terminalReasonFromErr extracts a clean close-reason from an error
// wrapped with ErrUpstreamTerminal. The wrapped echo.HTTPError carries
// a message like "sandbox sb-xxx has been stopped" or
// "sandbox sb-xxx not found" — we want the verb only, not the noisy
// sandbox ID echoed back to clients. Falls back to a generic reason
// when the wrapped error doesn't match a known shape.
func terminalReasonFromErr(err error) string {
	msg := err.Error()
	lower := strings.ToLower(msg)
	switch {
	case strings.Contains(lower, "stopped"):
		return "sandbox stopped"
	case strings.Contains(lower, "not found"):
		return "sandbox not found"
	default:
		return "sandbox unavailable"
	}
}

// terminalReason maps a terminal-status DialResult into the close
// reason string sent to the client. Mirrors the DO's wording so
// clients that pattern-match on the reason continue to work.
func terminalReason(dial DialResult) string {
	if strings.Contains(strings.ToLower(dial.BodySnippet), "stopped") {
		return "sandbox stopped"
	}
	if dial.Status == 0 {
		return "cell gone"
	}
	return "cell " + httpStatusText(dial.Status)
}

func httpStatusText(s int) string {
	switch s {
	case 404:
		return "404"
	case 410:
		return "410"
	default:
		return "unavailable"
	}
}
