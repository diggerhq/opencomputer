// Package awsvmlite is a second, deliberately minimal MicroVM backend.
//
// It exists because of one measurement. Lambda's proxy strips HTTP/2 trailers,
// and gRPC reports its status in trailers, so reaching osb-agent requires
// tunnelling gRPC inside a WebSocket. That tunnel is the source of an entire
// tier of machinery — a persistent channel per box, application-level
// keepalives, a re-dial ladder, eviction on repeated failure, and a Durable
// Object at the edge whose only job is to hold the socket open — and of the
// failure mode that tier produces: measured on dev, a box answering /healthz in
// 90ms with agentUp=true was simultaneously logged by the control plane as
// tunnel-less, with re-dial timing out at its full 30s budget.
//
// A plain HTTP request has no trailers to lose. Verified directly against a live
// box before this package was written: GET /healthz returned 200 five times out
// of five through the proxy, and a POST with a JSON body reached osb-agent
// intact (it answered 415, from inside the guest). So the tunnel is not required
// to talk to a MicroVM; it is required only to speak gRPC to one.
//
// This backend therefore does the smallest possible thing on the hot path:
//
//	create   pop a pre-launched box off a warm set, or launch one
//	exec     one HTTPS POST to /osb/run on the hook port, connection reused
//	destroy  TerminateMicrovm
//	warm     a real GET /healthz on an interval, which is the only kind of
//	         traffic AWS's idle accounting can see
//
// No WebSocket. No persistent channel. No keepalive ping. No re-dial. No
// Durable Object. No pool sharding. Nothing to decay.
//
// EVERYTHING ELSE — files, stats, reboot, and reaching a port the customer is
// listening on — lives in dataplane.go and is reached the same way, one request
// at a time, off the hot path. That was originally given up along with the
// tunnel, on the assumption that osb-agent's API required gRPC end to end. It
// does not: the trailer problem belongs to the PROXY HOP, and the guest can
// speak loopback gRPC to the agent behind it. cmd/microvm-hooks translates, so
// this backend reaches the agent's full API without carrying gRPC across the
// proxy even once.
//
// What remains genuinely absent: PTY and streaming exec sessions (both want a
// bidirectional stream, which is a WebSocket away but not built), checkpoints
// and fork (a MicroVM image is produced by an API, not captured from a running
// box), and per-sandbox resource limits (sizing belongs to the image).
package awsvmlite

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/opensandbox/opensandbox/internal/awsvm"
	"github.com/opensandbox/opensandbox/internal/sandbox"
	"github.com/opensandbox/opensandbox/internal/storage"
)

const (
	// runCmdPath must match cmd/microvm-hooks.
	runCmdPath = "/osb/run"
	// healthPath is the keep-warm probe. Cheap, side-effect free, and served by
	// the guest rather than the proxy, so a 200 proves the whole path.
	healthPath = "/healthz"

	// idleConnTimeout is how long an unused connection to a box is kept. It is a
	// constant rather than an inline field because Config.applyDefaults has to
	// keep the touch interval underneath it — see the reasoning there.
	idleConnTimeout = 90 * time.Second

	// defaultTouchInterval is comfortably under idleConnTimeout, and far under
	// the 8h AWS idle window the touch also serves. The binding constraint is
	// the connection, not the suspension.
	defaultTouchInterval = 60 * time.Second
)

// Config is everything this backend can be told. Short on purpose: a knob here
// is a thing that can be set wrong, and the point of this package is that there
// is almost nothing to get wrong.
type Config struct {
	// SuspendedCap bounds how many sandboxes may sit hibernated at once. 0
	// takes the default. See hibernate.go for the quota arithmetic behind it —
	// a parked box holds a slot the warm pool cannot have and cannot be
	// reclaimed, so this is what stops hibernation eating the pool.
	SuspendedCap int

	// WarmTarget is how many pre-launched boxes to hold. 0 disables the warm
	// set, and every create cold-launches (~3s, per AWS's own published
	// benchmark) instead of ~0.
	WarmTarget int

	// LaunchInterval paces RunMicrovm against the account's rate quota.
	LaunchInterval time.Duration

	// ReadyTimeout bounds how long a launching box may stay PENDING.
	ReadyTimeout time.Duration

	// TouchInterval is how often each warm box receives a real proxy request.
	//
	// This is the entire keep-warm mechanism. AWS suspends a MicroVM after
	// maxIdleDurationSeconds with no INBOUND REQUESTS THROUGH THE PROXY
	// ENDPOINT — traffic inside an already-established connection does not
	// count, which is why the agent path's in-tunnel pings never deferred a
	// suspension. A GET here does, by definition.
	TouchInterval time.Duration

	// ExecTimeout bounds one exec at the HTTP layer, independent of the
	// command's own timeout. Generous: if the box has already suspended, this
	// request is what resumes it, and Lambda holds it for a snapshot restore.
	ExecTimeout time.Duration
}

func (c *Config) applyDefaults() {
	if c.LaunchInterval <= 0 {
		c.LaunchInterval = 250 * time.Millisecond
	}
	if c.ReadyTimeout <= 0 {
		c.ReadyTimeout = 90 * time.Second
	}
	if c.TouchInterval <= 0 {
		c.TouchInterval = defaultTouchInterval
	}
	// The touch keeps TWO things alive, and only one of them is obvious.
	//
	// AWS's idle accounting is the stated purpose. But the touch is also a real
	// HTTPS request, so it is what holds this box's keep-alive connection open —
	// and a connection that lapses costs ~180ms of TCP+TLS on whichever exec
	// happens to be first through it.
	//
	// Touching less often than idleConnTimeout therefore guarantees the lapse:
	// the connection dies partway through every gap and the next exec pays for
	// it. Measured on dev with touch=300s against idleConnTimeout=90s — the
	// connection was dead for 210s of every 300s cycle, and CP-side exec
	// round-trips came back bimodal at ~83ms or ~260ms with the guest reporting
	// 11-13ms in both cases.
	if c.TouchInterval >= idleConnTimeout {
		c.TouchInterval = idleConnTimeout - 30*time.Second
	}
	if c.ExecTimeout <= 0 {
		c.ExecTimeout = 60 * time.Second
	}
}

// Box is a MicroVM this backend can reach. Everything needed to talk to it is
// here, which is the whole point: an exec touches no AWS API and no other
// process.
type Box struct {
	MicrovmID string
	Endpoint  string
	Token     string
	Port      int32

	// Meta is set when the box is bound to a sandbox, and is empty for one
	// still sitting in the warm set.
	Meta Meta

	launchedAt time.Time
	boundAt    time.Time
	// lastTouch is when the KEEPALIVE last poked this box. It exists to stop
	// AWS suspending idle stock and says nothing about the customer.
	lastTouch time.Time
	// lastUsed is when the CUSTOMER last did something. Deliberately separate
	// from lastTouch: the keepalive touches every box on a timer, so an idle
	// policy driven by lastTouch would find every sandbox permanently busy and
	// never expire anything. See MarkUsed.
	lastUsed time.Time
	// idleTimeout is how long this sandbox may sit unused before it is parked.
	// Zero means no timeout — the sandbox runs until killed or until the
	// provider's own hard cap ends it. See SetIdleTimeout for why a value
	// beyond that cap is refused rather than stored.
	idleTimeout time.Duration
}

// Meta is the part of a sandbox's config this backend still has to remember
// after the box is handed over: what to call the sandbox and what to bill it at.
//
// Nothing else from SandboxConfig survives the claim, and that is the honest
// position — warm stock is manufactured from one image before anyone asks for
// it, so a box cannot carry per-request sizing. Recording what was DELIVERED
// (see Manager.Claim) rather than what was requested is what keeps metering
// truthful about that.
type Meta struct {
	Template string
	MemoryMB int
	CPUCount int
}

// RunRequest mirrors cmd/microvm-hooks' runCmdRequest. Field-for-field with
// types.ProcessConfig so a customer's exec is forwarded, not translated.
type RunRequest struct {
	Cmd        string            `json:"cmd"`
	Args       []string          `json:"args,omitempty"`
	Env        map[string]string `json:"envs,omitempty"`
	Cwd        string            `json:"cwd,omitempty"`
	TimeoutSec int               `json:"timeoutSec,omitempty"`
}

// RunResult mirrors cmd/microvm-hooks' runCmdResponse.
type RunResult struct {
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	ExitCode   int    `json:"exitCode"`
	DurationMs int64  `json:"durationMs"`
	TimedOut   bool   `json:"timedOut,omitempty"`
}

// Manager holds the warm set and the sandbox→box bindings.
type Manager struct {
	client *awsvm.Client
	cfg    Config
	http   *http.Client

	mu    sync.Mutex
	warm  []*Box
	bound map[string]*Box // sandboxID → box
	// store is where checkpoint and template archives live. Set once at
	// construction; nil on a cell with no blob storage configured, which makes
	// checkpoints and templates unavailable rather than crashing.
	store *storage.CheckpointStore

	// term paces destroys against the 10/s TerminateMicrovm quota. See the
	// comment on terminate() for what calling the API directly cost.
	term *awsvm.Terminator

	// lifecycleObs receives the usage-metering boundaries — destroy, hibernate,
	// wake. nil until the control plane wires its ticker in, and nil in tests,
	// so every call site must guard. See SetLifecycleObserver.
	lifecycleObs sandbox.LifecycleObserver

	// lastBox remembers which host a sandbox held, for a short while after the
	// binding is dropped. It exists for exactly one reader: the event
	// publisher, which stamps each usage tick with a worker_id resolved from
	// the live binding.
	//
	// The closing tick is emitted DURING Destroy and drained a beat later, by
	// which time the binding is gone — so the publisher fell back to a generic
	// id, and events-ingest dropped the tick because it disagreed with the
	// sandbox's row. The last slice of every destroyed sandbox went unbilled
	// for that reason alone, even once the terminal-status guard was fixed.
	lastBox map[string]lastBoxEntry

	// suspended is the set of sandboxes parked by Hibernate, and the time each
	// was parked. Kept here rather than on the Box because two unrelated loops
	// have to consult it and both fail silently without it: billing (a
	// suspended box still reports Alive() to AWS) and touchIdle (a probe
	// auto-resumes whatever it touches). See hibernate.go.
	suspended map[string]time.Time
	// lastStateLog rate-limits the periodic state line — see logState.
	lastStateLog time.Time
	// inflight counts launches in progress, so the filler targets committed
	// boxes rather than landed ones and does not overshoot WarmTarget by
	// however many are mid-launch.
	inflight int
}

func New(client *awsvm.Client, cfg Config) *Manager {
	cfg.applyDefaults()
	return &Manager{
		client: client,
		cfg:    cfg,
		term:   awsvm.NewTerminator(client),
		bound:  map[string]*Box{},
		http: &http.Client{
			Timeout: cfg.ExecTimeout,
			// Connection reuse is the single most important line in this file.
			// Measured from off-region, a cold GET through the proxy cost 270ms
			// of which ~180ms was TCP connect + TLS. Amortising that handshake
			// across a keep-alive pool is what turns an exec into a request
			// rather than a connection.
			Transport: &http.Transport{
				MaxIdleConns:        512,
				MaxIdleConnsPerHost: 4,
				IdleConnTimeout:     idleConnTimeout,
				ForceAttemptHTTP2:   true,
				TLSClientConfig:     &tls.Config{MinVersion: tls.VersionTLS12},
			},
		},
	}
}

// Depth reports how many boxes are ready to hand out — the warm set, which is
// the only unclaimed state a box can be in.
func (m *Manager) Depth() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.warm)
}

// Run drives the warm set: top it up, and keep every box in it non-idle.
func (m *Manager) Run(ctx context.Context) {
	log.Printf("awsvmlite: starting (warm target=%d touch=%s)", m.cfg.WarmTarget, m.cfg.TouchInterval)
	launch := time.NewTicker(m.cfg.LaunchInterval)
	defer launch.Stop()
	// Derived from the interval, not fixed. A box becomes due at TouchInterval
	// and is only touched on the next tick, so a coarse tick adds its whole
	// period to the real gap — with a 30s tick against a 60s interval that is up
	// to 90s, which is exactly idleConnTimeout, putting the thing back inside the
	// window applyDefaults just moved it out of.
	touchTick := m.cfg.TouchInterval / 4
	if touchTick < 5*time.Second {
		touchTick = 5 * time.Second
	}
	touch := time.NewTicker(touchTick)
	defer touch.Stop()
	for {
		select {
		case <-ctx.Done():
			return

		case <-launch.C:
			m.mu.Lock()
			committed := len(m.warm) + m.inflight
			m.mu.Unlock()
			if committed >= m.cfg.WarmTarget {
				continue
			}
			go func() {
				if err := m.launchOne(ctx); err != nil {
					log.Printf("awsvmlite: launch failed: %v", err)
				}
			}()
		case <-touch.C:
			// Periodic state line.
			//
			// Added because this backend was diagnosable only when something
			// happened, so a QUIET manager was completely opaque. That cost
			// real time — a keepalive touching 49 boxes while AWS showed 100
			// running was impossible to explain with nothing printing the
			// split. A steady heartbeat is what makes "the filler thinks it is
			// at target" and "the pool is empty" distinguishable at a glance.
			m.logState()
			// In its own goroutine: a touch against an already-suspended box is
			// held by Lambda for the length of a restore, and blocking the tick
			// on that would stall the filler behind it.
			go m.touchIdle(ctx)
		}
	}
}

// launchOne manufactures one warm box.
//
// Compare internal/awsvm's equivalent, which additionally pre-dials a gRPC
// channel and forces it to READY. That part is absent here — there is no channel
// to pre-dial.
//
// The warm shell it also runs IS kept, because dropping it was measured and it
// was expensive: see the call below. An earlier version of this comment claimed
// the agent path made the first exec pay for the login shell too. It does not —
// it pre-pays it at manufacture, exactly as this now does.
func (m *Manager) launchOne(ctx context.Context) error {
	b, err := m.launchBox(ctx, "")
	if err != nil {
		return err
	}
	m.mu.Lock()
	m.warm = append(m.warm, b)
	depth := len(m.warm)
	m.mu.Unlock()
	log.Printf("awsvmlite: warm +1 %s (depth=%d/%d)", b.MicrovmID, depth, m.cfg.WarmTarget)
	return nil
}

// launchBox manufactures one box and returns it, warmed but unowned.
//
// image selects the size tier; "" is the default (pooled) image. Split out of
// launchOne so an off-tier create can reuse every step of it — the wait for
// RUNNING, the auth token, the warm shell — without touching the warm set,
// which holds default-size boxes only.
func (m *Manager) launchBox(ctx context.Context, image string) (*Box, error) {
	m.mu.Lock()
	m.inflight++
	m.mu.Unlock()
	defer func() {
		m.mu.Lock()
		m.inflight--
		m.mu.Unlock()
	}()

	runCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	box, err := m.client.RunImage(runCtx, "", image)
	if err != nil {
		return nil, err
	}
	// Do not hand out a box before Lambda says RUNNING: the proxy answers 502
	// for a VM that is still restoring, and absorbing that wait is the whole
	// reason a warm set exists.
	ready, err := m.client.WaitRunning(runCtx, box.ID, m.cfg.ReadyTimeout)
	if err != nil {
		go m.terminate(box.ID)
		return nil, err
	}
	token, err := m.client.AuthToken(runCtx, ready.ID)
	if err != nil {
		go m.terminate(ready.ID)
		return nil, err
	}

	b := &Box{
		MicrovmID:  ready.ID,
		Endpoint:   ready.Endpoint,
		Token:      token,
		Port:       m.client.Config().AgentPort,
		launchedAt: time.Now(),
	}
	// Pay the login shell here, once, instead of on the customer's first
	// command. Measured on dev before this existed: first exec rt=2218ms of
	// which cmd=2147ms was spent INSIDE the guest, against 81ms/13ms for every
	// exec after it on the same box. That is `sh -lc` faulting in the shell and
	// sourcing the whole profile chain on a box that has never run one — not
	// network, and not something a faster data plane can fix.
	//
	// Best effort: a box that cannot run this is probably broken, but the claim
	// path will find that out for itself, and refusing to stock it here would
	// turn a slow first command into no box at all.
	if err := m.warmShell(runCtx, b); err != nil {
		log.Printf("awsvmlite: warm shell on %s failed (%v) — stocking anyway; its first exec will be slow", b.MicrovmID, err)
	} else {
		// It opened the connection and it was inbound proxy traffic, so the box
		// starts its life already touched rather than immediately due.
		b.lastTouch = time.Now()
	}
	return b, nil
}

// Claim binds a warm box to a sandbox id, or launches one if the set is empty.
//
// Returns the box and whether it came from the warm set — the caller wants that
// in its timing, because the two differ by the entire cold-launch cost.
func (m *Manager) Claim(ctx context.Context, sandboxID string, meta Meta) (*Box, bool, error) {
	// The size the customer ASKED for, before delivered() rewrites it to what
	// the image provides. That rewrite is what makes metering truthful, and it
	// is also what would hide an off-tier request from the check below.
	requested := meta.MemoryMB
	meta = m.delivered(meta)

	// Only the default size is pooled. Another tier is a different IMAGE — the
	// memory of a MicroVM is a property of the image it launched from, not a
	// knob — so it cannot come off the warm set and has to cold-launch (~3s).
	// That is the deliberate trade: one deep pool for the common size beats N
	// shallow pools that all miss.
	if m.client != nil && !m.client.Config().IsDefaultTier(requested) {
		b, err := m.claimOffTier(ctx, sandboxID, requested, meta)
		return b, false, err
	}

	m.mu.Lock()
	if b := m.popLocked(sandboxID, meta); b != nil {
		m.mu.Unlock()
		return b, true, nil
	}
	m.mu.Unlock()

	if err := m.launchOne(ctx); err != nil {
		return nil, false, fmt.Errorf("awsvmlite: cold launch for %s: %w", sandboxID, err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if b := m.popLocked(sandboxID, meta); b != nil {
		return b, false, nil
	}
	// The box we just launched was taken by a concurrent claim. Rare, and the
	// caller retrying is better than launching again inside a lock.
	return nil, false, fmt.Errorf("awsvmlite: no box available for %s", sandboxID)
}

// claimOffTier cold-launches a box of a non-default size and binds it.
//
// Refuses rather than substituting when the tier is not offered. A silent
// downgrade would bill a customer for the size they asked for and hand them a
// smaller box, which is the one failure worth a hard error here.
func (m *Manager) claimOffTier(ctx context.Context, sandboxID string, requestedMB int, meta Meta) (*Box, error) {
	image, deliveredMB, ok := m.client.Config().ImageForMemory(requestedMB)
	if !ok {
		return nil, fmt.Errorf("awsvmlite: no image offers %d MB", requestedMB)
	}
	start := time.Now()
	b, err := m.launchBox(ctx, image)
	if err != nil {
		return nil, fmt.Errorf("awsvmlite: cold launch %d MB for %s: %w", requestedMB, sandboxID, err)
	}
	// Metered at what the tier image actually delivers, same rule as the
	// default path.
	meta.MemoryMB = deliveredMB
	b.Meta = meta
	b.boundAt = time.Now()
	m.mu.Lock()
	m.bound[sandboxID] = b
	m.mu.Unlock()
	log.Printf("awsvmlite: OFF-TIER CREATE %s -> %s (%d MB) in %s",
		sandboxID, b.MicrovmID, deliveredMB, time.Since(start).Round(time.Millisecond))
	return b, nil
}

// popLocked moves one box from the warm set to a sandbox. Caller holds m.mu.
func (m *Manager) popLocked(sandboxID string, meta Meta) *Box {
	n := len(m.warm)
	if n == 0 {
		return nil
	}
	b := m.warm[n-1]
	m.warm = m.warm[:n-1]
	b.Meta = meta
	b.boundAt = time.Now()
	m.bound[sandboxID] = b
	return b
}

// deliveredCPUCount is what a box actually provides, and the only value that
// may reach metering. CPU is not selectable on this runtime; it scales with the
// memory tier, so there is one honest number to record rather than a per-tier
// table we cannot verify from inside the guest.
const deliveredCPUCount = 1

// delivered resolves what the customer will actually get, which is not always
// what they asked for: every box in the warm set is built from one image, so a
// request for another tier is served at the image's size or not at all.
//
// Recorded as delivered rather than requested because this is what metering
// reads. Billing a 4 GB box as the 16 GB that was asked for is a silent
// overcharge, and billing it as 0 is a silent free ride.
func (m *Manager) delivered(meta Meta) Meta {
	// Nil-safe on the client: this is pure
	// bookkeeping and is reached from tests that never talk to AWS, so a missing
	// client should degrade to defaults rather than panic on the claim path.
	if m != nil && m.client != nil {
		cfg := m.client.Config()
		if _, mb, ok := cfg.ImageForMemory(meta.MemoryMB); ok && mb > 0 {
			meta.MemoryMB = mb
		} else if meta.MemoryMB <= 0 {
			meta.MemoryMB = cfg.DefaultMemoryMB
		}
	}
	// CPU gets the same treatment as memory, and for the same reason. This
	// platform has no CPU knob at all — RunMicrovmInput carries no vCPU field,
	// and cpu-configurations at image-publish time takes an architecture and
	// nothing else. CPU is allocated as a function of memory.
	//
	// So a customer-supplied cpuCount cannot be honoured, and carrying it
	// through would put a number the customer chose into the usage record this
	// function exists to keep truthful — the CPU equivalent of billing a 4 GB
	// box as the 16 GB that was asked for. It is discarded rather than
	// recorded.
	//
	// Logged when a request is dropped, because "cpuCount did nothing" is
	// otherwise invisible: the create succeeds, the sandbox is correct, and
	// only the meter would have been wrong.
	if meta.CPUCount != deliveredCPUCount {
		if meta.CPUCount > 0 {
			log.Printf("awsvmlite: cpuCount=%d requested but this runtime does not size CPU — metering as %d",
				meta.CPUCount, deliveredCPUCount)
		}
		meta.CPUCount = deliveredCPUCount
	}
	return meta
}

// Adopt rebinds a sandbox to a box that already exists, rebuilding a binding
// this process lost.
//
// A control plane restart drops the whole map while the boxes keep running, and
// the persisted worker_id is the only surviving link between the two. Without
// this the sandboxes are simultaneously unreachable (nothing routes to them) and
// unreapable (nothing knows to terminate them), so they bill and hold regional
// quota until the 8h cap.
//
// Reports false when AWS says the box is gone, which is the caller's cue to
// close the row rather than keep a sandbox nobody can serve.
func (m *Manager) Adopt(ctx context.Context, sandboxID, microvmID string, meta Meta) (bool, error) {
	box, err := m.client.Get(ctx, microvmID)
	if err != nil {
		return false, err
	}
	if !box.Alive() {
		return false, nil
	}
	token, err := m.client.AuthToken(ctx, box.ID)
	if err != nil {
		return false, err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.bound[sandboxID] = &Box{
		MicrovmID:  box.ID,
		Endpoint:   box.Endpoint,
		Token:      token,
		Port:       m.client.Config().AgentPort,
		Meta:       m.delivered(meta),
		launchedAt: box.StartedAt,
		// The row's own start time is not carried here: this is a re-bind, and
		// what callers ask boundAt is "since when could this process serve it".
		boundAt: time.Now(),
	}
	return true, nil
}

// Bound snapshots every sandbox this process is serving, for callers that walk
// the population — metering, and the reconciler.
func (m *Manager) Bound() map[string]Box {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]Box, len(m.bound))
	for id, b := range m.bound {
		out[id] = *b
	}
	return out
}

// BoundAt reports when a sandbox was bound, for status reporting.
func (b Box) BoundAt() time.Time { return b.boundAt }

// Bindings snapshots sandboxID → MicrovmID for callers that reconcile against
// persisted rows.
func (m *Manager) Bindings() map[string]string {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make(map[string]string, len(m.bound))
	for id, b := range m.bound {
		out[id] = b.MicrovmID
	}
	return out
}

// Forget drops a binding without terminating anything. For a sandbox whose box
// AWS has already taken.
func (m *Manager) Forget(sandboxID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.bound, sandboxID)
}

// Alive asks AWS whether a sandbox's box still exists.
//
// Deliberately not a read of the local map: this is what gates billing, and the
// local map is exactly the thing that goes stale when a box dies underneath us.
// A sandbox we cannot prove is alive must not be metered.
func (m *Manager) Alive(ctx context.Context, sandboxID string) (bool, error) {
	b, ok := m.BoxFor(sandboxID)
	if !ok {
		return false, nil
	}
	box, err := m.client.Get(ctx, b.MicrovmID)
	if err != nil {
		return false, err
	}
	return box.Alive(), nil
}

// BoxFor returns the box bound to a sandbox.
// DeadlineFor reports when the provider will destroy the host behind a sandbox,
// or the zero time if this process cannot know.
//
// Zero is returned rather than a guess for two distinct reasons, and both end
// up written to a database row that readers treat as terminal once passed:
// the sandbox may not be bound here, or the host's launch time may be unknown.
// Guessing in either case expires a live customer's sandbox.
func (m *Manager) DeadlineFor(sandboxID string) time.Time {
	b, ok := m.BoxFor(sandboxID)
	if !ok || m == nil || m.client == nil {
		return time.Time{}
	}
	return m.client.Config().Deadline(b.launchedAt)
}

func (m *Manager) BoxFor(sandboxID string) (*Box, bool) {
	m.mu.Lock()
	b, ok := m.bound[sandboxID]
	m.mu.Unlock()
	if ok {
		return b, true
	}
	// Not found, and deliberately not guessed at. An exec can reach the cell
	// BEFORE its finalize lands, and the only honest answer then is that this
	// process does not yet know which box the sandbox holds. Surfacing a clean
	// not-found is what keeps it from returning somebody else's box.
	return nil, false
}

// Exec runs one command in a sandbox and returns its result.
//
// This is the whole data plane. One request, one response, over a connection the
// transport above almost always already holds.
func (m *Manager) Exec(ctx context.Context, sandboxID string, req RunRequest) (*RunResult, error) {
	// Exec reaches the box directly rather than through call(), so it stamps
	// activity itself. Missing it here would mean a sandbox doing nothing but
	// running commands looked idle. See idle.go.
	m.MarkUsed(sandboxID)
	b, ok := m.BoxFor(sandboxID)
	if !ok {
		return nil, fmt.Errorf("awsvmlite: no box bound to %s", sandboxID)
	}
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}
	started := time.Now()
	resp, err := m.do(ctx, b, http.MethodPost, runCmdPath, body)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	// The host-side round trip, logged per exec because it is the ONLY leg this
	// backend controls. Everything else in a customer's measurement is geography
	// — client to edge, edge to control plane, control plane to region — and
	// without this number a slow exec cannot be told apart from a cell sitting on
	// the wrong side of the country from its boxes.
	roundTrip := time.Since(started)
	if resp.StatusCode != http.StatusOK {
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return nil, fmt.Errorf("awsvmlite: exec on %s: http %d: %s",
			sandboxID, resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	var out RunResult
	if err := json.NewDecoder(io.LimitReader(resp.Body, 8<<20)).Decode(&out); err != nil {
		return nil, fmt.Errorf("awsvmlite: exec on %s: decode: %w", sandboxID, err)
	}
	// An exec IS inbound proxy traffic and it IS a use of the connection, so it
	// satisfies everything the touch exists to satisfy. Without this, a busy
	// sandbox would still be probed on schedule — pointless load against the box
	// its customer is actively using.
	m.stampTouch(b)
	// rt is the whole request; cmd is what the guest spent running it. The
	// difference is network plus proxy, and it is the number this backend exists
	// to make small.
	log.Printf("awsvmlite: exec %s rt=%dms cmd=%dms exit=%d",
		sandboxID, roundTrip.Milliseconds(), out.DurationMs, out.ExitCode)
	return &out, nil
}

// stampTouch records that a box just served real traffic.
func (m *Manager) stampTouch(b *Box) {
	m.mu.Lock()
	b.lastTouch = time.Now()
	m.mu.Unlock()
}

// warmShellTimeout bounds the manufacture-time warm-up. Generous, because on a
// cold box this is the slowest thing that will ever run on it.
const warmShellTimeout = 30 * time.Second

// warmShell runs one throwaway command so the customer's first exec doesn't pay
// for the login shell. See the call site in launchOne for the measurement.
//
// `|| true` so a box without node still gets its profile sourced and still
// reports success — the point is the shell, not the binary.
func (m *Manager) warmShell(ctx context.Context, b *Box) error {
	ctx, cancel := context.WithTimeout(ctx, warmShellTimeout)
	defer cancel()
	body, err := json.Marshal(RunRequest{
		Cmd:        "node --version >/dev/null 2>&1 || true",
		TimeoutSec: int(warmShellTimeout / time.Second),
	})
	if err != nil {
		return err
	}
	resp, err := m.do(ctx, b, http.MethodPost, runCmdPath, body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("http %d", resp.StatusCode)
	}
	return nil
}

// DrainWarm terminates every box in the warm set and returns how many it
// released. Bound sandboxes are untouched — they belong to customers.
//
// Called on shutdown. Without it a redeploy abandons the whole warm set, and
// every abandoned box bills compute and holds regional memory quota — the real
// ceiling on how deep the set can be — until the 8h service cap. That is a leak
// per rollout, not per incident.
func (m *Manager) DrainWarm(ctx context.Context) int {
	m.mu.Lock()
	warm := m.warm
	m.warm = nil
	// Bound boxes are left alone: they belong to customers, and the reconciler
	// re-adopts them on the way back up.
	m.mu.Unlock()

	// ENQUEUED, NOT FANNED OUT. This used to launch 16 concurrent terminates
	// against a 10/s quota, log whatever was throttled, and then return
	// len(warm) as though all of them had died. On a full pool that is most of
	// a pool leaked on every restart — still billing, still holding quota,
	// while the log line said it released them all.
	//
	// The queue drains at the quota and retries throttles, so a drain now
	// records the intent for every box and the worker sees it through. It
	// deliberately does not block on completion: AWS terminate is asynchronous
	// anyway, and a shutdown path that waited would delay the restart it is
	// part of.
	for _, b := range warm {
		m.terminate(b.MicrovmID)
	}

	// AND WAIT FOR THE QUEUE TO DRAIN. This is the shutdown path: enqueueing and
	// returning would let the process exit with the backlog still in memory,
	// which loses every box that had not yet been called — strictly worse than
	// the unpaced version this replaced, because at least that one made the
	// calls before dying.
	//
	// Bounded by the caller's context (Close gives it 30s). Whatever is still
	// queued when that expires is left to the orphan sweep, which is the same
	// layering the agent path uses: the queue makes leaks rare, the sweep makes
	// them recoverable.
	if m.term != nil {
		for m.term.Depth() > 0 {
			select {
			case <-ctx.Done():
				log.Printf("awsvmlite: drain deadline reached with %d terminate(s) still queued — "+
					"the orphan sweep will reclaim them", m.term.Depth())
				return len(warm)
			case <-time.After(100 * time.Millisecond):
			}
		}
	}
	return len(warm)
}

// Destroy terminates a sandbox's box and forgets the binding.
// SetLifecycleObserver registers the usage-metering hooks, mirroring what the
// QEMU manager does with its own.
//
// It lives HERE, on the manager, rather than at the API layer that owns the
// ticker, because this is where a box actually dies. A sandbox is destroyed by
// the customer's DELETE, by the idle sweep, by a drain at shutdown, and by the
// reconciler — wiring the hook into any one caller bills some of those and
// silently misses the rest, which is exactly the bug this closes.
func (m *Manager) SetLifecycleObserver(obs sandbox.LifecycleObserver) {
	if m == nil {
		return
	}
	m.mu.Lock()
	m.lifecycleObs = obs
	m.mu.Unlock()
}

// lastBoxRetention bounds how long a destroyed sandbox's host id is
// remembered. Only the closing usage tick reads it, and that is drained within
// seconds, so this is generous — sized to survive a slow publisher rather than
// to be a cache.
const lastBoxRetention = 10 * time.Minute

type lastBoxEntry struct {
	microvmID string
	at        time.Time
}

// WorkerIDFor resolves the host a sandbox is on, or was on very recently.
//
// The recency half is what lets the closing usage tick be attributed. Callers
// that need to ROUTE must use BoxFor instead — a destroyed sandbox must never
// look reachable.
func (m *Manager) WorkerIDFor(sandboxID string) (string, bool) {
	if m == nil {
		return "", false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if b, ok := m.bound[sandboxID]; ok {
		return b.MicrovmID, true
	}
	if e, ok := m.lastBox[sandboxID]; ok && time.Since(e.at) < lastBoxRetention {
		return e.microvmID, true
	}
	return "", false
}

func (m *Manager) Destroy(ctx context.Context, sandboxID string) error {
	m.mu.Lock()
	b, ok := m.bound[sandboxID]
	delete(m.bound, sandboxID)
	if ok {
		if m.lastBox == nil {
			m.lastBox = map[string]lastBoxEntry{}
		}
		m.lastBox[sandboxID] = lastBoxEntry{microvmID: b.MicrovmID, at: time.Now()}
		// Prune here rather than on a timer: destroys are the only thing that
		// grows this map, so they are also the only place it can leak.
		for id, e := range m.lastBox {
			if time.Since(e.at) >= lastBoxRetention {
				delete(m.lastBox, id)
			}
		}
	}
	obs := m.lifecycleObs
	m.mu.Unlock()
	if !ok {
		// Not an error — a destroy for something already gone is idempotent —
		// but it IS the shape of a silent non-billing, so say it. If a caller
		// unbinds before calling here, every sandbox it destroys is free.
		log.Printf("awsvmlite: destroy %s: no binding held — nothing to bill or terminate", sandboxID)
		return nil
	}
	// Bill the slice since the last sample before the box goes. The usage
	// ticker samples every 20s and prices what it sees, so a sandbox that lived
	// and died between two samples was never seen and billed nothing at all.
	// Short-lived sandboxes are the normal shape of traffic here.
	//
	// Delivered size and bind time, both read from the box while it still
	// exists — after the Terminate there is nothing left to price the slice at.
	if obs == nil {
		// Loud because it is invisible otherwise: the sandbox is destroyed
		// correctly and simply never charged for.
		log.Printf("awsvmlite: destroy %s: NO lifecycle observer — final usage slice NOT billed", sandboxID)
	} else {
		obs.OnSandboxDestroy(sandboxID, b.Meta.MemoryMB, b.Meta.CPUCount, b.boundAt)
		log.Printf("awsvmlite: destroy %s: billed final slice (%dMB/%dcpu since %s)",
			sandboxID, b.Meta.MemoryMB, b.Meta.CPUCount, b.boundAt.Format(time.RFC3339))
	}
	return m.client.Terminate(ctx, b.MicrovmID)
}

// do issues one authenticated request through a box's proxy endpoint.
//
// The token is read from the box rather than minted per call: tokens last up to
// an hour and Client.AuthToken caches and refreshes them, so an exec never waits
// on the AWS control plane.
func (m *Manager) do(ctx context.Context, b *Box, method, path string, body []byte) (*http.Response, error) {
	host := hostOnly(b.Endpoint)
	var rdr io.Reader
	if body != nil {
		rdr = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, "https://"+host+path, rdr)
	if err != nil {
		return nil, err
	}
	req.Header.Set("X-aws-proxy-auth", m.token(ctx, b))
	req.Header.Set("X-aws-proxy-port", fmt.Sprintf("%d", b.Port))
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	return m.http.Do(req)
}

// touchIdle sends a real inbound request through the proxy of every box due
// for one — warm stock and bound sandboxes alike — so neither AWS's idle timer
// nor our keep-alive connection lapses. See Config.TouchInterval.
//
// A failed touch is not itself proof the box is bad — a 502 covers a box
// mid-resume — so a failure is never enough to evict on. But "it fails its next
// claim" was not a sufficient answer either: nothing removed a dead box from the
// warm set, so Depth() kept counting it, the filler saw itself at target and
// launched nothing, and every claim popped a corpse. AWS terminates a microvm at
// its 8h service cap, so the whole pool reaches that state at once, roughly 8h
// after it was filled, and stays there until someone restarts this process.
//
// So: touch failures are only a SUSPICION. Each one is confirmed against AWS,
// and only a box AWS reports as gone is evicted — which is what lets the filler
// see the gap and refill it.
func (m *Manager) touchIdle(ctx context.Context) {
	now := time.Now()
	m.mu.Lock()
	due := make([]*Box, 0, len(m.warm)+len(m.bound))
	// Warm stock AND bound sandboxes. Covering only the warm set was wrong in
	// both directions this touch matters: a customer's sandbox that sits idle
	// loses its keep-alive connection like any other box, so their next command
	// pays the handshake — and nothing was refreshing AWS's idle timer for it
	// either, which is the failure that ends in a suspended box and a full
	// snapshot restore rather than a slow request.
	for _, b := range m.warm {
		if b.lastTouch.IsZero() || now.Sub(b.lastTouch) >= m.cfg.TouchInterval {
			due = append(due, b)
		}
	}
	for id, b := range m.bound {
		// NEVER touch a parked sandbox. Lambda auto-resumes a suspended box on
		// any inbound request, so probing one would wake it within a tick of
		// being hibernated — the customer would be billed for a sandbox they
		// explicitly parked, and nothing in the logs would say why.
		if _, parked := m.suspended[id]; parked {
			continue
		}
		if b.lastTouch.IsZero() || now.Sub(b.lastTouch) >= m.cfg.TouchInterval {
			due = append(due, b)
		}
	}
	m.mu.Unlock()
	if len(due) == 0 {
		return
	}

	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		ok      int
		failed  int
		sample  error
		touched []*Box
		suspect []*Box
	)
	sem := make(chan struct{}, 16)
	for _, b := range due {
		wg.Add(1)
		go func(b *Box) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()

			err := func() error {
				resp, err := m.do(ctx, b, http.MethodGet, healthPath, nil)
				if err != nil {
					return err
				}
				defer resp.Body.Close()
				// Drain before closing or the connection cannot be reused,
				// which would defeat the point of the shared transport.
				_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
				if resp.StatusCode != http.StatusOK {
					return fmt.Errorf("http %d", resp.StatusCode)
				}
				return nil
			}()

			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				failed++
				if sample == nil {
					sample = fmt.Errorf("%s: %w", b.MicrovmID, err)
				}
				suspect = append(suspect, b)
				return
			}
			ok++
			touched = append(touched, b)
		}(b)
	}
	wg.Wait()

	// Stamped under the manager lock, and only on success: every other reader of
	// lastTouch holds m.mu, and a box whose touches keep failing must stay due
	// on every tick rather than drift quietly toward suspension.
	if len(touched) > 0 {
		stamp := time.Now()
		m.mu.Lock()
		for _, b := range touched {
			b.lastTouch = stamp
		}
		m.mu.Unlock()
	}

	msg := fmt.Sprintf("awsvmlite: touched %d/%d box(es), %d failed", ok, len(due), failed)
	if sample != nil {
		msg += fmt.Sprintf("; first failure %v", sample)
	}
	log.Print(msg)

	if len(suspect) > 0 {
		m.evictDead(ctx, suspect)
	}
}

// evictDead asks AWS about boxes whose touch failed and drops the ones that are
// genuinely gone from the warm set.
//
// Only warm stock is evicted. A bound box belongs to a customer, and its row is
// the reconciler's business — dropping it here would strand the sandbox rather
// than close it.
func (m *Manager) evictDead(ctx context.Context, suspect []*Box) {
	var (
		wg   sync.WaitGroup
		mu   sync.Mutex
		dead = make(map[string]struct{}, len(suspect))
	)
	sem := make(chan struct{}, 16)
	for _, b := range suspect {
		wg.Add(1)
		go func(b *Box) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			box, err := m.client.Get(ctx, b.MicrovmID)
			// An error here is ambiguous — a throttle reads the same as a gone
			// box — so it is left alone and re-checked on the next tick. Only a
			// definite not-alive is acted on.
			if err != nil || box.Alive() {
				return
			}
			mu.Lock()
			dead[b.MicrovmID] = struct{}{}
			mu.Unlock()
		}(b)
	}
	wg.Wait()
	if len(dead) == 0 {
		return
	}

	m.mu.Lock()
	evicted := m.dropWarmLocked(dead)
	depth := len(m.warm)
	m.mu.Unlock()

	if evicted > 0 {
		log.Printf("awsvmlite: evicted %d dead box(es) from warm (depth=%d/%d) — filler will replace them",
			evicted, depth, m.cfg.WarmTarget)
	}
}

// terminate destroys a box, PACED.
//
// TerminateMicrovm is quota'd at 10/s and a throttled terminate is the worst
// failure available: it returns an error AND leaves the box running, so it
// bills and holds regional memory quota until the 8h cap. The agent path
// learned this the hard way — internal/awsvm/terminator.go records a delete of
// 112 sandboxes returning 11 × HTTP 500, each one a leaked box — and this
// backend was calling the API directly, logging the failure, and moving on.
//
// The quota is per account and region, so both backends share one. Enqueueing
// rather than calling is what keeps them from racing it.
func (m *Manager) terminate(id string) {
	if m.term != nil && m.term.Enqueue(id) {
		return
	}
	// Queue full (or no queue, in tests): better a direct call than losing the
	// box entirely.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := m.client.Terminate(ctx, id); err != nil {
		log.Printf("awsvmlite: terminate %s: %v", id, err)
	}
}

// hostOnly strips scheme and any trailing path from an endpoint.
func hostOnly(endpoint string) string {
	h := strings.TrimPrefix(strings.TrimPrefix(endpoint, "https://"), "http://")
	if i := strings.IndexByte(h, '/'); i >= 0 {
		return h[:i]
	}
	return h
}

// logState prints the warm/bound split on every touch tick.
//
// Rate-limited to once a minute: the tick is every few seconds, and the useful
// signal is a trend, not a stream. Logged even when nothing changed — a stuck
// count IS the symptom worth seeing, and a filler that believes it is at target
// while the pool is empty looks identical to a healthy one without this line.
func (m *Manager) logState() {
	m.mu.Lock()
	warm, bound := len(m.warm), len(m.bound)
	last := m.lastStateLog
	now := time.Now()
	if now.Sub(last) < time.Minute {
		m.mu.Unlock()
		return
	}
	m.lastStateLog = now
	inflight := m.inflight
	m.mu.Unlock()
	log.Printf("awsvmlite: state warm=%d bound=%d inflight=%d depth=%d/%d",
		warm, bound, inflight, warm, m.cfg.WarmTarget)
}

// dropWarmLocked removes the named boxes from the warm set and reports how many
// went. Caller holds m.mu.
//
// Split out from evictDead so the part that can silently corrupt the pool — the
// slice rebuild — is testable without an AWS client. Bound boxes are not
// considered: this only ever shortens warm stock.
func (m *Manager) dropWarmLocked(dead map[string]struct{}) int {
	if len(dead) == 0 {
		return 0
	}
	kept := m.warm[:0]
	evicted := 0
	for _, b := range m.warm {
		if _, gone := dead[b.MicrovmID]; gone {
			evicted++
			continue
		}
		kept = append(kept, b)
	}
	// Clear the tail so evicted boxes are not retained by the backing array.
	for i := len(kept); i < len(m.warm); i++ {
		m.warm[i] = nil
	}
	m.warm = kept
	return evicted
}

// CloseTerminator stops the paced destroy worker. Call it AFTER DrainWarm, or
// the queue is torn down with the drain still in it.
func (m *Manager) CloseTerminator() {
	if m.term != nil {
		m.term.Close()
	}
}

// LiveMicrovmIDs returns the ids of every box AWS still considers alive.
//
// ONE call for the whole fleet, deliberately. The reconciler needs a liveness
// answer for every sandbox it holds, and asking per sandbox is a GetMicrovm per
// bound box per tick — which at a few hundred sandboxes is a rate-limit problem
// invented to solve a bookkeeping one.
//
// An error is returned rather than an empty set, because the two mean opposite
// things: "nothing is alive" would tell the caller to drop every binding it
// has. See the caller — it skips the sweep entirely when this fails.
func (m *Manager) LiveMicrovmIDs(ctx context.Context) (map[string]struct{}, error) {
	if m == nil || m.client == nil {
		// An error, not an empty set — see the note above. Reached in tests and
		// on a cell whose client failed to build.
		return nil, fmt.Errorf("awsvmlite: no AWS client configured")
	}
	boxes, err := m.client.List(ctx)
	if err != nil {
		return nil, err
	}
	live := make(map[string]struct{}, len(boxes))
	for _, b := range boxes {
		if b.Alive() {
			live[b.ID] = struct{}{}
		}
	}
	return live, nil
}

// SetCheckpointStore attaches the blob store used by checkpoints and template
// restores. Call before the manager serves traffic.
func (m *Manager) SetCheckpointStore(store *storage.CheckpointStore) {
	m.store = store
}
