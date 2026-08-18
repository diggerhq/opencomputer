package awsvm

import (
	"context"
	"log"
	"sync"
	"time"
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
	// inflight counts launches that have called RunMicrovm but are still
	// waiting to reach RUNNING. Without it the ticker sees a low Depth() and
	// keeps launching, overshooting the target by however many boxes fit in one
	// boot time — each one burning memory quota we cannot get back quickly.
	inflight int
}

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
			if p.committed() < p.cfg.TargetStock {
				go func() {
					if err := p.launchOne(ctx); err != nil {
						log.Printf("awsvm: pool launch failed: %v", err)
					}
				}()
			}
		case <-maintain.C:
			p.refreshTokens(ctx)
			p.retireAged(ctx)
		}
	}
}

// launchOne adds a single box to stock: run it, mint its token, park it.
// committed is stock plus launches still in flight — what the pool will have
// once everything settles, and therefore the right number to compare against
// the target when deciding whether to launch more.
func (p *Pool) committed() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.stock) + p.inflight
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

func (p *Pool) terminate(e *StockEntry) {
	// Close the pre-dialled tunnel too, or retiring stock leaks a goroutine and
	// a socket per box.
	if e.agent != nil {
		_ = e.agent.Close()
	}
	p.terminateID(e.MicrovmID)
}

func (p *Pool) terminateID(id string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := p.client.Terminate(ctx, id); err != nil {
		log.Printf("awsvm: pool terminate %s: %v", id, err)
	}
}

// Drain terminates all stock. Called on shutdown so a restarting filler does not
// abandon boxes — abandoned boxes hold both compute cost and regional quota
// until they hit the 8h cap.
func (p *Pool) Drain() {
	p.mu.Lock()
	stock := p.stock
	p.stock = nil
	p.mu.Unlock()

	var wg sync.WaitGroup
	for _, e := range stock {
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
