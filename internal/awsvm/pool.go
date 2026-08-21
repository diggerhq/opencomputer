package awsvm

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"

	"google.golang.org/grpc/connectivity"
)

// pool.go — a warm pool of RUNNING MicroVMs.
//
// The shape here is dictated entirely by the service's rate limits, not by
// preference. Lambda MicroVMs allows (account+region defaults):
//
//	RunMicrovm      5/s     ResumeMicrovm   5/s
//	SuspendMicrovm  2/s     TerminateMicrovm 10/s
//	CreateMicrovmAuthToken 50/s
//
// A burst of 100 creates cannot call RunMicrovm — that is 20 seconds of
// launching. It cannot call ResumeMicrovm either, so the cheaper design of
// holding stock SUSPENDED (which bills snapshot storage instead of compute) is
// unavailable: waking 100 suspended boxes is throttled just as hard as
// launching them.
//
// What is left is the only shape that survives a burst: keep the stock RUNNING
// and make the claim path do ZERO AWS calls. The edge pops a pre-launched box
// with a pre-minted token and answers immediately; every rate-limited call
// happens on this background loop, minutes before the customer arrives.
//
// The costs of that choice, all of them real:
//   - stocked boxes bill compute the whole time they wait, not storage
//   - idle-suspend must be off, or stock silently drifts into SUSPENDED and the
//     next claim pays a throttled Resume
//   - every box dies at the 8h service cap (running+suspended combined,
//     adjustable=false), so the pool needs continuous rolling replacement
//   - auth tokens last at most 60 minutes, so stock has to be re-tokened in
//     place or it goes stale while waiting
type PoolConfig struct {
	// TargetStock is how many RUNNING boxes to keep ready.
	TargetStock int

	// MaxBoxAge retires a box before the service's hard 8h ceiling. Leave
	// headroom: a box that hits the cap is terminated by Lambda underneath us,
	// and a claim that lands on it fails the customer's create.
	MaxBoxAge time.Duration

	// LaunchInterval paces RunMicrovm calls. Must stay at or under the account's
	// RunMicrovm rate quota — exceeding it earns ThrottlingException, and a
	// throttled top-up means the pool silently runs dry under churn.
	LaunchInterval time.Duration

	// TokenRefreshMargin re-mints a stocked box's token this long before it
	// expires, so a claim never hands out a token about to die.
	TokenRefreshMargin time.Duration

	// ReadyTimeout bounds how long a launching box may stay PENDING before we
	// give up and terminate it. A box that never reaches RUNNING still burns
	// regional memory quota, so waiting forever quietly shrinks pool capacity.
	ReadyTimeout time.Duration

	// PreDialTimeout bounds establishing a stocked box's agent tunnel. Exceeding
	// it costs only a cold first exec on that box, never the box itself.
	PreDialTimeout time.Duration

	// MaxTotalBoxes caps pool stock PLUS everything claimed out of it, against
	// the regional memory quota. 0 disables the cap.
	//
	// TargetStock alone is not a safety property. It bounds what the pool holds,
	// not what exists: a claimed box leaves the stock, the filler sees a hole and
	// launches a replacement, so pool + live sandboxes grows without limit as
	// load rises. That is exactly how a 200-box pool alongside 300 live sandboxes
	// put this account over its 1024GB ceiling and turned every create into
	// ServiceQuotaExceeded — the filler was chasing its target while blind to the
	// boxes doing the actual work.
	//
	// With a budget set, the pool becomes something a burst can DRAIN rather than
	// a floor it fights: claims consume stock, refill waits until those boxes are
	// released, and the total never exceeds what the region will allow.
	MaxTotalBoxes int

	// InUse reports boxes alive outside the pool — claimed sandboxes still doing
	// work. Supplied by the owner because the pool deliberately forgets a box the
	// moment it is claimed; the manager is what tracks it afterwards.
	//
	// Nil means "nothing else exists", which is only true in tests.
	InUse func() int

	// InUseDetail explains the InUse number for the budget log — the terms it is
	// computed from, so a refill freeze names its own cause instead of needing a
	// live investigation to decompose. Optional; must be cheap and must not
	// block, since it runs inside the pool's own tick.
	InUseDetail func() string

	// RefillDelay is how long the filler stands down after finding itself at
	// MaxTotalBoxes.
	//
	// Standing down matters because the budget check alone only skips a tick.
	// At the ceiling that re-probes every LaunchInterval, so the instant any box
	// is released the pool launches a replacement and is immediately at the
	// ceiling again — it tracks the budget exactly, and every one of those
	// launches is a RunMicrovm call competing with the customer creates that are
	// cold precisely because the pool is empty. Measured on dev: 366 boxes
	// manufactured in 30 minutes against 28 "regional MicroVM quota exhausted"
	// creates, the pool and its own customers bidding for the same quota.
	//
	// A cooldown makes the pool yield instead. It re-probes once per delay, so
	// releases accumulate into real headroom before the filler spends quota on
	// them, and a burst's cold creates get the regional quota to themselves.
	// Time-bounded rather than event-driven on purpose: a delay armed by every
	// claim would be pushed forward indefinitely by sustained traffic and the
	// pool would never refill at all.
	RefillDelay time.Duration

	// OnExpire is called after a stale edge reservation has been terminated.
	//
	// Reserving for the edge binds a sandbox id to the box BEFORE any customer
	// claims it, so that routing and the warm tunnel resolve the instant the
	// edge answers a create. When the reservation dies instead of being claimed,
	// that binding has to die with it — otherwise the control plane keeps
	// routing a live sandbox id to a terminated box, and every operation on it
	// fails somewhere deep in the agent tunnel rather than with "not found".
	//
	// Called without the pool lock held, so implementations may take their own.
	OnExpire func(microvmID string)

	// OnMaintain runs on each maintenance tick, after the pool has warmed its
	// own stock.
	//
	// It exists because the pool cannot warm the boxes that matter most. An
	// edge reservation moves its agent channel to the manager (TrackClaimed) and
	// leaves p.stock, so a box staged in a PoolStock shard — the exact box the
	// next create will be handed — is invisible to warmTunnels. Those sit for
	// minutes with no traffic, their tunnels lapse, and the cost lands on the
	// customer's first exec, which is what TTI measures. Only the owner knows
	// which sandbox ids are reserved-but-unclaimed, so it does that warming.
	//
	// Called without the pool lock held.
	OnMaintain func()
}

func (c *PoolConfig) applyDefaults() {
	// Zero is a real setting, not "unset": it means run cold-create-only, with
	// no warm stock. Every caller resolves its own default before constructing
	// a PoolConfig (the control plane via envInt, the harness via a flag), so a
	// 0 arriving here is deliberate. Defaulting it up — as this did — silently
	// launched 20 boxes for an operator who asked for none, which is the same
	// zero-value trap that made OPENSANDBOX_MAX_WORKERS=0 keep provisioning.
	if c.TargetStock < 0 {
		c.TargetStock = 0
	}
	if c.MaxBoxAge <= 0 {
		// 8h service cap minus an hour of slack for retirement to keep up.
		c.MaxBoxAge = 7 * time.Hour
	}
	if c.LaunchInterval <= 0 {
		// 5/s is the default RunMicrovm quota; 250ms paces at 4/s to leave room
		// for retirement launches and any other caller in the account.
		c.LaunchInterval = 250 * time.Millisecond
	}
	if c.TokenRefreshMargin <= 0 {
		c.TokenRefreshMargin = 10 * time.Minute
	}
	if c.ReadyTimeout <= 0 {
		c.ReadyTimeout = 45 * time.Second
	}
	if c.PreDialTimeout <= 0 {
		c.PreDialTimeout = 30 * time.Second
	}
	if c.RefillDelay <= 0 {
		c.RefillDelay = time.Minute
	}
}

// StockEntry is one ready-to-claim box. Everything a caller needs to talk to it
// is here, which is the whole point: claiming touches no AWS API.
type StockEntry struct {
	MicrovmID string
	Endpoint  string
	Token     string

	// agent is a gRPC channel already dialled and connected through the
	// WebSocket tunnel. Establishing it costs ~1.4s (token mint, WS handshake,
	// HTTP/2 setup) against ~85ms for an exec on an established channel, so
	// leaving it to the first exec would put that 1.4s squarely on the
	// customer's create→first-command path. Doing it here spends it while the
	// box is idle in stock, for the same reason tokens are pre-minted.
	agent *agentConn

	tokenMintedAt time.Time
	launchedAt    time.Time
}

// reservation is a stocked box promised to the edge, with the moment it was
// promised so the reaper can tell a claim that is in flight from one that is
// never coming.
type reservation struct {
	entry *StockEntry
	at    time.Time
}

// reservationTTL bounds how long the edge may hold a box without binding it.
// Short enough that a dead DO does not quietly shrink the pool, but it MUST
// comfortably exceed the PoolStock DO's own ENTRY_TTL_MS (10 minutes), because
// a reservation the DO still counts as stock is one it will happily hand to a
// customer. Expiring first would mean the edge answering a create with a box
// this pool had already terminated — a 201 for a sandbox that does not exist.
// 15 minutes matches the QEMU edge_reserved reaper for the same reason.
const reservationTTL = 15 * time.Minute

// Pool keeps TargetStock boxes launched, tokened and fresh.
type Pool struct {
	client *Client
	cfg    PoolConfig

	// preDial establishes a box's agent tunnel while it waits in stock. It is a
	// field rather than a direct call so tests can disable it: dialling is real
	// network I/O against a real MicroVM endpoint, which a fake AWS API cannot
	// satisfy — without this seam the unit tests block on a doomed handshake.
	preDial func(ctx context.Context, microvmID, endpoint string) (*agentConn, error)

	mu    sync.Mutex
	stock []*StockEntry
	// budgetLoggedAt rate-limits the at-budget notice; see overBudget.
	budgetLoggedAt time.Time
	// reserved holds boxes promised to the edge's PoolStock DO but not yet
	// bound to a sandbox. They stay HERE rather than moving to the DO because
	// the pre-dialled tunnel is a live gRPC channel in this process — it cannot
	// be serialized to a Durable Object. The DO holds only the identity; the
	// control plane keeps the thing that makes a claim fast.
	//
	// A reservation is deliberately not a claim: nothing is bound, no sandbox
	// id exists yet, and an unclaimed one returns to stock. That is what makes
	// an edge that dies mid-create cost a box for one reaper interval instead
	// of until the 8h cap.
	reserved map[string]*reservation
	// backoffUntil suppresses launches after the account hits its regional
	// memory quota. Without it the ticker keeps firing doomed RunMicrovm calls
	// — a 402 fails instantly, so inflight drops straight back and the next
	// tick launches again, producing a permanent LaunchInterval-rate storm of
	// failures (measured on prod: ~4/s indefinitely, each with SDK retries
	// behind it, on a 2-vCPU control plane that also serves creates).
	backoffUntil time.Time
	// inflight counts launches that have called RunMicrovm but are still
	// waiting to reach RUNNING. Without it the ticker sees a low Depth() and
	// keeps launching, overshooting the target by however many boxes fit in one
	// boot time — each one burning memory quota we cannot get back quickly.
	inflight int
}

// AgentPort is the guest port this pool's tokens are scoped to. Callers handing
// a box's reach-info to something outside this process need it, because the
// credential is only valid for that one port.
func (p *Pool) AgentPort() int32 { return p.client.Config().AgentPort }

func NewPool(client *Client, cfg PoolConfig) *Pool {
	cfg.applyDefaults()
	p := &Pool{client: client, cfg: cfg}
	p.preDial = client.DialAgentConnected
	return p
}

// Claim removes a ready box from stock and returns it. No AWS calls, no
// blocking, no error path — a miss simply means the caller must fall back to a
// direct create (and eat the RunMicrovm rate limit) or fail fast.
func (p *Pool) Claim() (*StockEntry, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for len(p.stock) > 0 {
		e := p.stock[len(p.stock)-1]
		p.stock = p.stock[:len(p.stock)-1]
		// Skip anything that aged out while queued rather than handing a
		// customer a box Lambda is about to terminate underneath them.
		if time.Since(e.launchedAt) < p.cfg.MaxBoxAge {
			return e, true
		}
		go p.terminate(e)
	}
	return nil, false
}

// Reserve promises up to n boxes to the edge and returns them. The caller gets
// identity only — MicrovmID, Endpoint, Token — which is all the DO needs to
// hand a box to a customer; the tunnel stays here.
//
// Returns fewer than n (possibly none) when stock is short. That is not an
// error: the edge falls back to asking the control plane, which is the same
// path it uses when the DO is cold.
func (p *Pool) Reserve(n int) []*StockEntry {
	if n <= 0 {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.reserved == nil {
		p.reserved = make(map[string]*reservation)
	}
	now := time.Now()
	out := make([]*StockEntry, 0, n)
	for len(out) < n {
		if len(p.stock) == 0 {
			break
		}
		e := p.stock[len(p.stock)-1]
		p.stock = p.stock[:len(p.stock)-1]
		// Same age rule as Claim: never promise a box Lambda is about to
		// terminate underneath the customer.
		if time.Since(e.launchedAt) >= p.cfg.MaxBoxAge {
			go p.terminate(e)
			continue
		}
		p.reserved[e.MicrovmID] = &reservation{entry: e, at: now}
		out = append(out, e)
	}
	return out
}

// ClaimReserved binds a previously reserved box, returning the full entry so the
// caller can adopt its tunnel. Reports false if the reservation is unknown —
// already claimed, expired back to stock, or never made — which the caller must
// treat as a miss rather than a failure, because the edge can legitimately race
// the reaper.
func (p *Pool) ClaimReserved(microvmID string) (*StockEntry, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	r, ok := p.reserved[microvmID]
	if !ok {
		return nil, false
	}
	delete(p.reserved, microvmID)
	return r.entry, true
}

// ReleaseReserved returns an unclaimed reservation to stock — the edge deciding
// it does not need the box after all. Cheaper than letting it expire, and the
// box keeps its warm tunnel.
func (p *Pool) ReleaseReserved(microvmID string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	r, ok := p.reserved[microvmID]
	if !ok {
		return false
	}
	delete(p.reserved, microvmID)
	p.stock = append(p.stock, r.entry)
	return true
}

// AttachAgent gives a stocked box back its agent channel.
//
// Pairs with Manager.DetachAgent on the release path. TrackClaimed transfers a
// reservation's tunnel to the manager, so a reservation the edge hands back has
// none — and re-dialling it costs the next customer ~470ms on their first exec
// (measured: 549ms cold vs 76ms warm). Since the release path knows the channel
// is still good and that no customer ever held it, moving it back is strictly
// better than closing it and dialling again.
//
// warmTunnels re-dials anything that still ends up tunnel-less; this just keeps
// the common case from needing it, because the 30s maintenance tick loses the
// race when the DO releases a batch and immediately re-reserves it.
func (p *Pool) AttachAgent(microvmID string, a *agentConn) {
	if a == nil {
		return
	}
	p.mu.Lock()
	for _, e := range p.stock {
		if e.MicrovmID == microvmID && e.agent == nil {
			e.agent = a
			p.mu.Unlock()
			return
		}
	}
	p.mu.Unlock()
	// Left stock between the release and here — don't leak the channel.
	_ = a.Close()
}

// expireReservations TERMINATES promises the edge never redeemed. It does not
// return them to stock, and that distinction is a security boundary rather than
// a cleanup preference.
//
// A reservation carries a pre-minted auth token, handed to the DO. When a
// reservation goes stale we cannot tell "the DO died before handing this out"
// from "the DO gave it to a customer and the finalize was lost" — and in the
// second case the customer holds a live token for that box. Re-pooling it would
// hand a second customer a box the first can still reach: cross-tenant access.
// Burning a warm box is the cheap outcome; the other one is a breach.
//
// This mirrors the QEMU edge-claim reaper, which destroys stale edge_reserved
// rows for exactly this reason (see edge_claim.go). ReleaseReserved is the safe
// counterpart: there the edge is positively asserting it never handed the box
// out, which is knowledge this path does not have.
func (p *Pool) expireReservations() int {
	p.mu.Lock()
	stale := make([]*StockEntry, 0)
	for id, r := range p.reserved {
		if time.Since(r.at) < reservationTTL {
			continue
		}
		delete(p.reserved, id)
		stale = append(stale, r.entry)
	}
	p.mu.Unlock()

	for _, e := range stale {
		go p.terminate(e)
		// Drop the sandbox binding the reserve made, so nothing keeps routing a
		// live id to a box that no longer exists. Ordering does not matter — the
		// box is doomed either way — but this must not run under p.mu, because
		// the callback reaches back into the backend.
		if p.cfg.OnExpire != nil {
			p.cfg.OnExpire(e.MicrovmID)
		}
	}
	return len(stale)
}

// ReservedDepth reports outstanding reservations, for telemetry and for the
// sizing invariant.
func (p *Pool) ReservedDepth() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.reserved)
}

// Depth reports current stock, for telemetry and for the sizing invariant: the
// edge's shards must not target more stock in aggregate than the pool can hold,
// or shards starve while hoarding — the same failure that cost us 1045ms vs
// 174ms on the QEMU fleet.
func (p *Pool) Depth() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.stock)
}

// Run drives the maintenance loop until ctx is cancelled. Everything
// rate-limited lives here, deliberately far from any customer request.
func (p *Pool) Run(ctx context.Context) {
	log.Printf("awsvm: pool starting (target=%d maxAge=%s launchInterval=%s)",
		p.cfg.TargetStock, p.cfg.MaxBoxAge, p.cfg.LaunchInterval)

	launch := time.NewTicker(p.cfg.LaunchInterval)
	defer launch.Stop()
	maintain := time.NewTicker(30 * time.Second)
	defer maintain.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-launch.C:
			// One launch per tick is what keeps us under the RunMicrovm quota.
			// Topping up "as fast as possible" is exactly how you earn a
			// ThrottlingException storm.
			//
			// The launch itself runs in its own goroutine because it now waits
			// for the box to reach RUNNING. Doing that inline would pace the
			// pool at boot time rather than at the quota, turning a parallel
			// fill into a serial one.
			if p.launchSuppressed() {
				continue
			}
			// Budget before target: when a burst has drained the pool into live
			// sandboxes, the right move is to WAIT for them rather than launch
			// replacements alongside them. Refilling here is what doubles the
			// footprint and trips the regional quota.
			if p.overBudget() {
				// Stand down rather than re-probe at tick rate. Skipping the tick
				// alone leaves the filler glued to the ceiling: it wakes every
				// LaunchInterval, and the moment a single box is released it spends
				// a RunMicrovm on a replacement and is at the ceiling again. Those
				// launches contend for the same regional quota as the customer
				// creates that went cold because the pool was drained, so the pool
				// competes with the burst it exists to absorb. Backing off lets
				// releases pool up into real headroom first.
				p.standDown(p.cfg.RefillDelay)
				continue
			}
			if p.committed() < p.cfg.TargetStock {
				go func() {
					if err := p.launchOne(ctx); err != nil {
						// Quota exhaustion is a standing condition, not a
						// transient one: capacity frees up when boxes age out
						// or are terminated, on a scale of minutes. Retrying at
						// tick rate cannot fix it and merely burns CPU and API
						// budget, so stand down and re-probe once per cooldown.
						if errors.Is(err, ErrQuotaExceeded) {
							p.suppressLaunches(quotaCooldown, err)
							return
						}
						log.Printf("awsvm: pool launch failed: %v", err)
					}
				}()
			}
		case <-maintain.C:
			p.refreshTokens(ctx)
			p.retireAged(ctx)
			p.warmTunnels(ctx)
			if p.cfg.OnMaintain != nil {
				p.cfg.OnMaintain()
			}
			if n := p.expireReservations(); n > 0 {
				log.Printf("awsvm: pool re-pooled %d unclaimed edge reservation(s)", n)
			}
		}
	}
}

// quotaCooldown is how long the pool stops launching after the account reports
// its regional memory quota exhausted. Long enough that a full pool's worth of
// failures collapses into one probe per minute; short enough that capacity
// freed by retirement is picked up promptly.
const quotaCooldown = time.Minute

// launchSuppressed reports whether launches are standing down after a quota
// rejection. One probe per cooldown still gets through, so the pool refills on
// its own once capacity returns — no operator action, no restart.
func (p *Pool) launchSuppressed() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return time.Now().Before(p.backoffUntil)
}

// standDown pauses launches for d without logging, for callers that have
// already said why. Never shortens an existing pause: a quota backoff and a
// budget backoff can be armed in the same window, and the longer one is the one
// that reflects a condition we know has not cleared.
func (p *Pool) standDown(d time.Duration) {
	if d <= 0 {
		return
	}
	until := time.Now().Add(d)
	p.mu.Lock()
	if until.After(p.backoffUntil) {
		p.backoffUntil = until
	}
	p.mu.Unlock()
}

// suppressLaunches stands the launch loop down for d. Logged once per cooldown
// rather than once per attempt: the old behaviour buried every other log line
// on the cell under identical quota errors.
func (p *Pool) suppressLaunches(d time.Duration, cause error) {
	p.mu.Lock()
	already := time.Now().Before(p.backoffUntil)
	p.backoffUntil = time.Now().Add(d)
	depth := len(p.stock)
	p.mu.Unlock()
	if !already {
		log.Printf("awsvm: pool launches paused for %s — %v (depth=%d/%d)", d, cause, depth, p.cfg.TargetStock)
	}
}

// launchOne adds a single box to stock: run it, mint its token, park it.
// committed is stock plus launches still in flight — what the pool will have
// once everything settles, and therefore the right number to compare against
// the target when deciding whether to launch more.
// overBudget reports whether pool stock plus everything claimed out of it has
// reached MaxTotalBoxes, in which case the filler must stand down.
//
// Logged at most once per cooldown rather than per tick: hitting the budget is a
// normal steady state during a burst, not an incident, and a line every
// LaunchInterval would bury the log in it.
func (p *Pool) overBudget() bool {
	if p.cfg.MaxTotalBoxes <= 0 {
		return false
	}
	inUse := 0
	if p.cfg.InUse != nil {
		inUse = p.cfg.InUse()
	}
	total := p.committed() + inUse
	if total < p.cfg.MaxTotalBoxes {
		return false
	}
	// Gate on the refill delay rather than a fixed minute so the notice tracks
	// however long the filler is actually standing down, and at 9/10 of it so a
	// once-per-delay caller cannot alias against the window and go silent.
	p.mu.Lock()
	quiet := time.Since(p.budgetLoggedAt) < p.cfg.RefillDelay*9/10
	if !quiet {
		p.budgetLoggedAt = time.Now()
	}
	p.mu.Unlock()
	if !quiet {
		// Decomposed on purpose. "N in use + M committed" says the budget is
		// full but not which term is holding it, and the two have opposite
		// fixes: a stuck committed() means the pool is hoarding stock or has
		// launches wedged in flight, while a stuck in-use means bindings the
		// manager still counts for sandboxes that are gone. Diagnosing a refill
		// freeze from the undecomposed line took a full benchmark session and
		// several wrong answers, because every latency number measured during it
		// was taken against a capped pool without that being visible.
		p.mu.Lock()
		stock, inflight, reserved := len(p.stock), p.inflight, len(p.reserved)
		p.mu.Unlock()
		detail := ""
		if p.cfg.InUseDetail != nil {
			detail = " " + p.cfg.InUseDetail()
		}
		log.Printf("awsvm: pool at box budget (%d in use + %d committed >= %d) — refill paused %s to leave regional quota for creates [stock=%d inflight=%d reserved=%d%s]",
			inUse, p.committed(), p.cfg.MaxTotalBoxes, p.cfg.RefillDelay, stock, inflight, reserved, detail)
	}
	return true
}

func (p *Pool) committed() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	// Reservations count: they are boxes we own and will hand out. Omitting
	// them would make the filler see a hole that isn't there and launch
	// replacements for boxes already promised, overshooting the target by
	// however many creates the edge has in flight.
	return len(p.stock) + p.inflight + len(p.reserved)
}

func (p *Pool) launchOne(ctx context.Context) error {
	p.mu.Lock()
	p.inflight++
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		p.inflight--
		p.mu.Unlock()
	}()

	// Generous relative to boot: this bounds the whole launch including the wait
	// for RUNNING, and ReadyTimeout is the tighter budget inside it.
	runCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	// No client token: each pool box is a fresh VM with no caller-facing
	// identity to be idempotent against. Sandbox ids are assigned at claim.
	box, err := p.client.Run(runCtx, "")
	if err != nil {
		return err
	}

	// Do not park a box until Lambda says it is RUNNING. RunMicrovm returns
	// while the VM is still restoring, and a claim that lands on a PENDING box
	// gets 502 from the proxy — the pool's whole job is to absorb that wait so
	// the customer never sees it.
	ready, err := p.client.WaitRunning(runCtx, box.ID, p.cfg.ReadyTimeout)
	if err != nil {
		go p.terminateID(box.ID)
		return err
	}
	box = ready

	token, err := p.client.AuthToken(runCtx, box.ID)
	if err != nil {
		// A box we cannot token is useless as stock and would otherwise sit
		// burning quota and compute until the age cap.
		go p.terminateID(box.ID)
		return err
	}

	// Pre-establish the agent tunnel so the first exec is warm. A failure here
	// is not fatal: the box is still perfectly usable, the first exec just pays
	// the dial itself, which is strictly better than discarding a launched box.
	var agent *agentConn
	if p.preDial != nil {
		dialCtx, cancelDial := context.WithTimeout(runCtx, p.cfg.PreDialTimeout)
		a, derr := p.preDial(dialCtx, box.ID, box.Endpoint)
		cancelDial()
		if derr != nil {
			log.Printf("awsvm: pool pre-dial %s failed, box still usable cold: %v", box.ID, derr)
		} else {
			agent = a
			// Spend the box's first-shell cost here rather than on the
			// customer's first command — see agentConn.warmShell. Best effort:
			// a box that fails to warm is still a perfectly good box, it just
			// starts cold like it did before.
			warmCtx, cancelWarm := context.WithTimeout(runCtx, warmShellTimeout)
			if werr := agent.warmShell(warmCtx); werr != nil {
				log.Printf("awsvm: pool warm-up exec %s failed, box starts cold: %v", box.ID, werr)
			}
			cancelWarm()
		}
	}

	p.mu.Lock()
	p.stock = append(p.stock, &StockEntry{
		MicrovmID:     box.ID,
		Endpoint:      box.Endpoint,
		Token:         token,
		agent:         agent,
		tokenMintedAt: time.Now(),
		launchedAt:    time.Now(),
	})
	depth := len(p.stock)
	p.mu.Unlock()

	log.Printf("awsvm: pool +1 %s (depth=%d/%d)", box.ID, depth, p.cfg.TargetStock)
	return nil
}

// refreshTokens re-mints tokens that are approaching expiry. Tokens cap at 60
// minutes, so any box that waits in stock longer than that outlives its token;
// without this the pool fills with entries whose credentials are already dead.
// CreateMicrovmAuthToken is quota'd at 50/s, comfortably above stock size, so
// this can run in one pass.
func (p *Pool) refreshTokens(ctx context.Context) {
	cutoff := time.Duration(authTokenMaxMinutes)*time.Minute - p.cfg.TokenRefreshMargin

	p.mu.Lock()
	stale := make([]*StockEntry, 0)
	for _, e := range p.stock {
		if time.Since(e.tokenMintedAt) >= cutoff {
			stale = append(stale, e)
		}
	}
	p.mu.Unlock()

	for _, e := range stale {
		tokenCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		token, err := p.client.AuthToken(tokenCtx, e.MicrovmID)
		cancel()
		if err != nil {
			log.Printf("awsvm: pool token refresh %s: %v", e.MicrovmID, err)
			continue
		}
		p.mu.Lock()
		e.Token = token
		e.tokenMintedAt = time.Now()
		p.mu.Unlock()
	}
	if len(stale) > 0 {
		log.Printf("awsvm: pool refreshed %d token(s)", len(stale))
	}
}

// retireAged terminates stock approaching the 8h ceiling so the launch loop can
// replace it. Retiring early is the point: a box terminated by Lambda mid-claim
// is a failed create, and success rate multiplies the benchmark score directly.
func (p *Pool) retireAged(ctx context.Context) {
	p.mu.Lock()
	kept := p.stock[:0]
	var retire []*StockEntry
	for _, e := range p.stock {
		if time.Since(e.launchedAt) >= p.cfg.MaxBoxAge {
			retire = append(retire, e)
			continue
		}
		kept = append(kept, e)
	}
	p.stock = kept
	p.mu.Unlock()

	for _, e := range retire {
		p.terminate(e)
	}
	if len(retire) > 0 {
		log.Printf("awsvm: pool retired %d aged box(es)", len(retire))
	}
}

// warmTunnels keeps every stocked box's agent channel in READY, so the first
// exec after a claim does not pay to re-establish it.
//
// Pre-dialling at manufacture is not enough on its own. dialAgent sets
// PermitWithoutStream:false — deliberately, so an idle CUSTOMER sandbox is
// allowed to suspend instead of being held RUNNING by keepalive pings — which
// means a box waiting in stock sends no traffic at all and the proxy drops its
// WebSocket tunnel. gRPC keeps the ClientConn, so nothing looks broken and no
// re-dial is logged; the cost simply lands on the customer's first RPC as a
// silent tunnel re-handshake. Measured on dev: first exec 383ms vs 75ms warm,
// and TTI is defined by exactly that first call.
//
// Reconnecting is done with conn.Connect() rather than a probe RPC: it restores
// the transport without touching the guest, so this cannot be mistaken for
// sandbox activity by anything that watches for it. Only stock is warmed —
// claimed boxes keep the existing idle-and-suspend behaviour untouched.
func (p *Pool) warmTunnels(ctx context.Context) {
	p.mu.Lock()
	conns := make([]*agentConn, 0, len(p.stock))
	var missing []*StockEntry
	for _, e := range p.stock {
		if e.agent != nil {
			conns = append(conns, e.agent)
			continue
		}
		// No tunnel at all. The common cause is a round trip through the edge:
		// TrackClaimed transfers ownership of the channel to the manager (and
		// clears this field, so the pool can never close a live customer's
		// tunnel), then EdgeRelease hands the unused reservation back to stock —
		// and what returns has no tunnel and no way to get one. Measured on dev:
		// ~130 boxes released across 8 batches produced 134 reserves with
		// warm_tunnel=false against 136 with it, i.e. half of all creates were
		// paying a cold dial on their first exec.
		//
		// Re-dialling here rather than in ReleaseReserved is deliberate: stock
		// with no tunnel is wrong however it got that way, so healing it in the
		// maintenance tick covers every cause, including ones we have not found.
		if len(missing) < warmDialPerTick {
			missing = append(missing, e)
		}
	}
	p.mu.Unlock()

	// Keepalive: touch every stocked box so it never goes idle long enough for
	// AWS to suspend it. This is the expensive-on-purpose half of the trade —
	// an unsuspended box bills compute while it waits — and it is what keeps a
	// claim's first exec off the ~1s resume path.
	if ok, failed := pingAll(ctx, conns); ok+failed > 0 {
		log.Printf("awsvm: pool keepalive pinged %d stocked box(es) (%d failed)", ok, failed)
	}

	if p.preDial != nil {
		for _, e := range missing {
			dialCtx, cancel := context.WithTimeout(ctx, p.cfg.PreDialTimeout)
			a, err := p.preDial(dialCtx, e.MicrovmID, e.Endpoint)
			cancel()
			if err != nil {
				continue // still usable cold; try again next tick
			}
			// Re-check under the lock: the entry may have been reserved or
			// terminated while we dialled, and installing a tunnel on an entry
			// that has left stock would leak the channel.
			p.mu.Lock()
			stillStocked := false
			for _, s := range p.stock {
				if s == e && s.agent == nil {
					s.agent = a
					stillStocked = true
					break
				}
			}
			p.mu.Unlock()
			if !stillStocked {
				_ = a.Close()
			}
		}
		if len(missing) > 0 {
			log.Printf("awsvm: pool re-dialled tunnels for %d tunnel-less stocked box(es)", len(missing))
		}
	}

	rewarmed := 0
	for _, a := range conns {
		if a.conn == nil {
			continue
		}
		switch a.conn.GetState() {
		case connectivity.Ready, connectivity.Connecting:
			// Already warm, or already on its way.
		case connectivity.Shutdown:
			// Terminal — the entry is dead stock; retireAged/terminate owns it.
		default: // Idle, TransientFailure
			a.conn.Connect()
			rewarmed++
		}
	}
	if rewarmed > 0 {
		log.Printf("awsvm: pool re-warmed %d idle agent tunnel(s) of %d stocked", rewarmed, len(conns))
	}
}

func (p *Pool) terminate(e *StockEntry) {
	// Close the pre-dialled tunnel too, or retiring stock leaks a goroutine and
	// a socket per box.
	if e.agent != nil {
		_ = e.agent.Close()
	}
	p.terminateID(e.MicrovmID)
}

// terminateInterval paces TerminateMicrovm starts. The quota is 10/s; 8/s
// leaves room for the reconciler and customer destroys, which draw on the same
// bucket. Without pacing, draining a full pool fires every terminate at once
// and most of them come back throttled.
// warmDialPerTick bounds how many tunnel-less stock boxes are re-dialled per
// maintenance tick. Each dial is a real WebSocket+TLS handshake to the proxy, so
// healing a fully cold pool all at once would burst hundreds of them; spreading
// the work costs a few ticks and keeps the pool's own traffic predictable.
const warmDialPerTick = 32

const terminateInterval = 125 * time.Millisecond

// terminateAttempts bounds retries of a throttled terminate. Giving up leaks
// the box for up to the 8h service cap — it keeps billing and, worse, keeps
// holding the regional memory quota that caps pool depth. So a terminate is
// worth retrying properly rather than logging and walking away.
const terminateAttempts = 6

func (p *Pool) terminateID(id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	backoff := 250 * time.Millisecond
	for attempt := 1; ; attempt++ {
		err := p.client.Terminate(ctx, id)
		if err == nil {
			return
		}
		// Only throttling is worth retrying: a box that is already gone, or an
		// id we are not allowed to touch, will fail identically every time.
		if !errors.Is(err, ErrThrottled) || attempt >= terminateAttempts {
			log.Printf("awsvm: pool terminate %s (attempt %d): %v", id, attempt, err)
			return
		}
		select {
		case <-time.After(backoff):
		case <-ctx.Done():
			log.Printf("awsvm: pool terminate %s abandoned after %d attempt(s) — box will hold quota until the age cap", id, attempt)
			return
		}
		backoff *= 2
	}
}

// StockIDs returns the MicrovmIDs currently parked in stock. Used by the orphan
// sweep to tell a box we are deliberately holding from one nothing owns.
func (p *Pool) StockIDs() map[string]struct{} {
	p.mu.Lock()
	defer p.mu.Unlock()
	ids := make(map[string]struct{}, len(p.stock)+len(p.reserved))
	for _, e := range p.stock {
		ids[e.MicrovmID] = struct{}{}
	}
	// Reserved boxes are owned, just spoken for. Leaving them out would make
	// the orphan sweep classify every in-flight edge claim as abandoned and
	// terminate boxes out from under customers mid-create — the worst possible
	// bug in this file.
	for id := range p.reserved {
		ids[id] = struct{}{}
	}
	return ids
}

// Drain terminates all stock. Called on shutdown so a restarting filler does not
// abandon boxes — abandoned boxes hold both compute cost and regional quota
// until they hit the 8h cap.
func (p *Pool) Drain() {
	p.mu.Lock()
	stock := p.stock
	p.stock = nil
	// Reserved boxes are ours too. A shutdown that drained only stock would
	// abandon every outstanding reservation to the 8h cap — the same leak this
	// function exists to prevent, just through a different door.
	for id, r := range p.reserved {
		stock = append(stock, r.entry)
		delete(p.reserved, id)
	}
	p.mu.Unlock()

	// Paced, not a fan-out. Firing every terminate at once against a 10/s quota
	// means most come back throttled, and a throttled terminate used to be
	// logged and dropped — which is how a restart stranded most of a pool.
	// Starts are paced; each terminate then runs concurrently so its retries
	// don't serialize behind the next box.
	tick := time.NewTicker(terminateInterval)
	defer tick.Stop()
	var wg sync.WaitGroup
	for _, e := range stock {
		<-tick.C
		wg.Add(1)
		go func(e *StockEntry) {
			defer wg.Done()
			p.terminate(e)
		}(e)
	}
	wg.Wait()
	if len(stock) > 0 {
		log.Printf("awsvm: pool drained %d box(es)", len(stock))
	}
}
