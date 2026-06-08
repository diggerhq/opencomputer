// Package wsgateway is the per-cell WebSocket broker that sits between
// clients (SDK, dashboard) and workers for PTY/exec/agent sessions.
//
// Replaces the CloudFlare-DO implementation that lived in
// cloudflare-workers/shared/sandbox_ws_gateway.ts on the websocket-edge
// branch. Same behavioral spec — multi-session per sandbox, redial on
// upstream close, exit-marker suppression, alarm-tick keepalive,
// cap-token cache, flap circuit breaker — implemented as a Go subsystem
// of the cell-CP (opensandbox-server) instead of a CF Durable Object.
//
// Why move out of CF: (1) the cell becomes self-hostable without depending
// on Cloudflare DO infrastructure, (2) single implementation maintained
// in one language, (3) the cell-CP orchestrates migration AND brokers WS
// from the same process, so future work can switch the migration handoff
// from reactive-redial to proactive-handoff via Go channels.
//
// Layering:
//
//   Client ── WS ── CF Worker ── WS ── cell-CP broker ── WS ── Worker ── gRPC ── Agent (in-VM)
//                  (auth, cap-mint,    (this package:        (handlers.go,
//                   transparent fwd)    redial, keepalive,    RebindFromAgent,
//                                       exit marker, etc.)    PTY/exec session
//                                                             map cache, etc.)
//
// The broker terminates the client WS on its end and opens an independent
// WS to the worker. If the worker WS dies (worker restart, migration
// release, network blip) the broker doesn't kill the client; it redials
// the worker and the client keeps its connection.
package wsgateway

import "time"

// AlarmIntervalMS is the keepalive ticker period — empty binary frame on
// every tick to both client and upstream WS, plus a sweep for idle
// sandbox actors that no longer hold any sessions. 30s matches the
// previous DO implementation and is well under CF Workers' ~100s
// fetch-WS idle drop threshold.
const AlarmInterval = 30 * time.Second

// Default redial cadence on upstream close — exponential then steady at
// 4s. Total budget ~25s before the redial loop gives up and closes the
// client. Same ladder as the DO; chosen so transient worker restarts
// (≤15s) and live migrations (≤2s) reliably succeed.
var RedialBackoffMS = []time.Duration{
	250 * time.Millisecond,
	500 * time.Millisecond,
	1 * time.Second,
	2 * time.Second,
	4 * time.Second,
	4 * time.Second,
	4 * time.Second,
	4 * time.Second,
	4 * time.Second,
	4 * time.Second,
}

// Migration-aware cadence: cross-cell live migration can take 30s+ on
// slow links. When the cell-CP-side dial returns 503 + body matches
// /migrating/, the redial loop switches to this steadier 2s × 30 cadence
// for the rest of the cycle.
const (
	MigrationBackoff     = 2 * time.Second
	MigrationMaxAttempts = 30
)

// Circuit breaker: a "redial cycle" is a single call to startRedial
// regardless of how many internal dial attempts it triggers. After this
// many cycles within REDIAL_FLAP_WINDOW the broker gives up and closes
// the client with 1011 / "upstream flapping". Prevents an upstream that
// keeps closing cleanly (e.g. a worker handler bug) from burning CF
// Worker subrequests indefinitely.
const (
	RedialFlapThreshold = 3
	RedialFlapWindow    = 60 * time.Second
)

// Cap-token cache: edge mints 120s HS256 JWTs. The broker reuses one
// across sessions in the same sandbox actor and across redials until it
// has less than CapRefreshAhead of life left.
const (
	CapLifetime     = 120 * time.Second
	CapRefreshAhead = 30 * time.Second
)

// HandshakeTimeout bounds the worker WS dial. Worker side is in-cluster
// (sub-millisecond RTT) so this only fires when the worker is actively
// unhealthy or being restarted.
const HandshakeTimeout = 10 * time.Second

// WriteTimeout bounds individual WS writes — prevents a slow consumer
// (client or upstream) from blocking the bridge goroutine indefinitely
// while still allowing for transient buffer pressure.
const WriteTimeout = 30 * time.Second

// ExecExitMarkerLen / ExecExitMarkerTag — the agent emits a 5-byte
// binary frame tagged 0x03 + 4-byte exit code immediately before closing
// a completed exec session. The broker watches for it to distinguish
// "session ended cleanly" (close client with 1000 / "exec completed")
// from "transient upstream loss" (redial).
const (
	ExecExitMarkerLen = 5
	ExecExitMarkerTag = 0x03
)
