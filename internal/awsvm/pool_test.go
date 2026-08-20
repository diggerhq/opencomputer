package awsvm

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/lambdamicrovms"
	"github.com/aws/aws-sdk-go-v2/service/lambdamicrovms/types"
)

// poolAPI counts the AWS calls the pool makes, so the tests can assert on the
// property that actually matters: claiming must not touch AWS at all.
type poolAPI struct {
	API
	mu         sync.Mutex
	runs       int
	gets       int
	tokens     int
	terminates []string
	// runErr, when set, makes every RunMicrovm fail with it — for exercising
	// the launch loop's reaction to a standing AWS-side rejection.
	runErr error
	// terminateFailures throttles that many TerminateMicrovm calls before
	// letting one through, reproducing a quota-pressed account.
	terminateFailures int
}

func (f *poolAPI) RunMicrovm(_ context.Context, _ *lambdamicrovms.RunMicrovmInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.RunMicrovmOutput, error) {
	f.mu.Lock()
	f.runs++
	id := fmt.Sprintf("mvm-%d", f.runs)
	runErr := f.runErr
	f.mu.Unlock()
	if runErr != nil {
		return nil, runErr
	}
	return &lambdamicrovms.RunMicrovmOutput{
		MicrovmId: aws.String(id),
		Endpoint:  aws.String(id + ".microvm.aws.dev"),
		ImageArn:  aws.String("arn:image"),
	}, nil
}

// GetMicrovm reports RUNNING immediately. Real boxes spend seconds PENDING —
// that gap is exactly why the pool waits before stocking a box — but these
// tests are about call accounting, not boot timing, so waiting here would only
// make them slow.
func (f *poolAPI) GetMicrovm(_ context.Context, in *lambdamicrovms.GetMicrovmInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.GetMicrovmOutput, error) {
	f.mu.Lock()
	f.gets++
	f.mu.Unlock()
	id := aws.ToString(in.MicrovmIdentifier)
	return &lambdamicrovms.GetMicrovmOutput{
		MicrovmId: aws.String(id),
		Endpoint:  aws.String(id + ".microvm.aws.dev"),
		ImageArn:  aws.String("arn:image"),
		State:     types.MicrovmStateRunning,
	}, nil
}

func (f *poolAPI) CreateMicrovmAuthToken(_ context.Context, in *lambdamicrovms.CreateMicrovmAuthTokenInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.CreateMicrovmAuthTokenOutput, error) {
	f.mu.Lock()
	f.tokens++
	n := f.tokens
	f.mu.Unlock()
	return &lambdamicrovms.CreateMicrovmAuthTokenOutput{
		AuthToken: map[string]string{"X-aws-proxy-auth": fmt.Sprintf("jwe-%d", n)},
	}, nil
}

func (f *poolAPI) TerminateMicrovm(_ context.Context, in *lambdamicrovms.TerminateMicrovmInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.TerminateMicrovmOutput, error) {
	f.mu.Lock()
	// Throttle the first terminateFailures calls, as a quota-pressed account
	// does. Only successes are recorded, so a test asserting on terminates is
	// asserting the box actually went away.
	if f.terminateFailures > 0 {
		f.terminateFailures--
		f.mu.Unlock()
		return nil, &types.ThrottlingException{}
	}
	f.terminates = append(f.terminates, aws.ToString(in.MicrovmIdentifier))
	f.mu.Unlock()
	return &lambdamicrovms.TerminateMicrovmOutput{}, nil
}

func (f *poolAPI) counts() (int, int, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.runs, f.tokens, len(f.terminates)
}

func testPool(t *testing.T, cfg PoolConfig) (*Pool, *poolAPI) {
	t.Helper()
	f := &poolAPI{}
	c := NewClientWithAPI(f, Config{ImageIdentifier: "arn:image"})
	p := NewPool(c, cfg)
	// No real endpoints behind the fake API, so pre-dialling would block on a
	// handshake that can never complete. The claim-path accounting these tests
	// assert on is unaffected.
	p.preDial = nil
	return p, f
}

// The whole design rests on this: a claim must make ZERO AWS calls. Any call on
// this path reintroduces the 5/s RunMicrovm / ResumeMicrovm ceiling and a
// burst-100 becomes a 20-second launch window.
func TestClaimMakesNoAWSCalls(t *testing.T) {
	p, f := testPool(t, PoolConfig{TargetStock: 5})
	for i := 0; i < 5; i++ {
		if err := p.launchOne(context.Background()); err != nil {
			t.Fatalf("launchOne: %v", err)
		}
	}
	runsBefore, tokensBefore, termsBefore := f.counts()

	for i := 0; i < 5; i++ {
		e, ok := p.Claim()
		if !ok {
			t.Fatalf("claim %d missed on a full pool", i)
		}
		if e.Endpoint == "" || e.Token == "" {
			t.Fatalf("claim returned an entry without endpoint/token: %+v", e)
		}
	}

	runs, tokens, terms := f.counts()
	if runs != runsBefore || tokens != tokensBefore || terms != termsBefore {
		t.Fatalf("claiming hit AWS: runs %d→%d tokens %d→%d terminates %d→%d",
			runsBefore, runs, tokensBefore, tokens, termsBefore, terms)
	}
}

// An empty pool must fail fast rather than block or launch inline — the caller
// decides whether to eat a rate-limited direct create.
func TestClaimOnEmptyPoolMisses(t *testing.T) {
	p, f := testPool(t, PoolConfig{TargetStock: 1})
	if _, ok := p.Claim(); ok {
		t.Fatal("claim succeeded on an empty pool")
	}
	if runs, _, _ := f.counts(); runs != 0 {
		t.Fatalf("empty claim triggered %d RunMicrovm call(s)", runs)
	}
}

// Boxes die at the 8h service cap whether we like it or not. Handing one out
// near the ceiling means Lambda terminates it under the customer, so aged stock
// must be skipped and cleaned up instead.
func TestClaimSkipsAndTerminatesAgedStock(t *testing.T) {
	p, f := testPool(t, PoolConfig{TargetStock: 2, MaxBoxAge: time.Hour})
	for i := 0; i < 2; i++ {
		if err := p.launchOne(context.Background()); err != nil {
			t.Fatalf("launchOne: %v", err)
		}
	}
	p.mu.Lock()
	for _, e := range p.stock {
		e.launchedAt = time.Now().Add(-2 * time.Hour)
	}
	p.mu.Unlock()

	if _, ok := p.Claim(); ok {
		t.Fatal("claim handed out a box past MaxBoxAge")
	}
	// Termination is fired asynchronously; give it a moment.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, _, terms := f.counts(); terms == 2 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	_, _, terms := f.counts()
	t.Fatalf("aged stock not terminated: %d of 2", terms)
}

// Stock that outlives its token is worse than no stock: the claim succeeds and
// the customer's first request fails auth.
func TestRefreshTokensRemintsStaleEntries(t *testing.T) {
	p, f := testPool(t, PoolConfig{TargetStock: 2, TokenRefreshMargin: 10 * time.Minute})
	for i := 0; i < 2; i++ {
		if err := p.launchOne(context.Background()); err != nil {
			t.Fatalf("launchOne: %v", err)
		}
	}
	_, tokensAfterLaunch, _ := f.counts()

	p.mu.Lock()
	for _, e := range p.stock {
		e.tokenMintedAt = time.Now().Add(-55 * time.Minute) // inside the margin
		// Force a client-cache miss too, else AuthToken returns the cached value.
		delete(p.client.tokens, e.MicrovmID)
	}
	p.mu.Unlock()

	p.refreshTokens(context.Background())

	_, tokensNow, _ := f.counts()
	if tokensNow != tokensAfterLaunch+2 {
		t.Fatalf("re-minted %d token(s), want 2", tokensNow-tokensAfterLaunch)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, e := range p.stock {
		if time.Since(e.tokenMintedAt) > time.Minute {
			t.Fatal("entry still carries a stale tokenMintedAt after refresh")
		}
	}
}

// A restarting filler must not abandon boxes: they hold compute cost and
// regional quota until the 8h cap.
func TestDrainTerminatesAllStock(t *testing.T) {
	p, f := testPool(t, PoolConfig{TargetStock: 3})
	for i := 0; i < 3; i++ {
		if err := p.launchOne(context.Background()); err != nil {
			t.Fatalf("launchOne: %v", err)
		}
	}
	p.Drain()

	if got := p.Depth(); got != 0 {
		t.Fatalf("depth after drain = %d, want 0", got)
	}
	if _, _, terms := f.counts(); terms != 3 {
		t.Fatalf("drain terminated %d box(es), want 3", terms)
	}
}

// The launch loop must respect the RunMicrovm quota. Defaults pace under 5/s.
func TestDefaultLaunchIntervalStaysUnderRunQuota(t *testing.T) {
	var cfg PoolConfig
	cfg.applyDefaults()
	rate := float64(time.Second) / float64(cfg.LaunchInterval)
	if rate > 5.0 {
		t.Fatalf("default launch rate %.1f/s exceeds the RunMicrovm quota of 5/s", rate)
	}
	if cfg.MaxBoxAge >= 8*time.Hour {
		t.Fatalf("MaxBoxAge %s leaves no headroom under the 8h service cap", cfg.MaxBoxAge)
	}
}

// TargetStock 0 means "no warm stock, cold-create only" — a real operating mode
// now that a pool miss launches a box instead of failing. It used to be
// defaulted up to 20, which launched twenty boxes for an operator who asked for
// none, and quietly invalidated any test of the cold path.
func TestZeroTargetStockKeepsPoolEmpty(t *testing.T) {
	p, f := testPool(t, PoolConfig{TargetStock: 0})
	_ = f
	if got := p.cfg.TargetStock; got != 0 {
		t.Fatalf("TargetStock 0 became %d — pool would stock boxes nobody asked for", got)
	}
	if d := p.Depth(); d != 0 {
		t.Fatalf("empty-target pool reported depth %d", d)
	}
	if _, ok := p.Claim(); ok {
		t.Fatal("claimed a box from a pool configured to hold none")
	}
}

// A quota-exhausted account must not be retried at tick rate. RunMicrovm fails
// instantly with 402, so inflight drops straight back and the next tick launches
// again — an unbounded failure storm that cannot possibly succeed, since quota
// only frees on the scale of minutes. Observed on prod as ~4 failed launches per
// second, indefinitely, on the same 2-vCPU host that serves customer creates.
func TestQuotaExhaustionPausesLaunches(t *testing.T) {
	p, f := testPool(t, PoolConfig{TargetStock: 5, LaunchInterval: 5 * time.Millisecond})
	f.mu.Lock()
	f.runErr = &types.ServiceQuotaExceededException{}
	f.mu.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	go p.Run(ctx)
	// Long enough for ~60 ticks. Pre-fix this produced ~60 RunMicrovm calls.
	time.Sleep(300 * time.Millisecond)
	cancel()

	runs, _, _ := f.counts()
	if runs > 5 {
		t.Fatalf("quota-exhausted pool kept launching: %d RunMicrovm calls in 300ms (want it to stand down after the first)", runs)
	}
	if runs == 0 {
		t.Fatal("pool never attempted a launch, so the test proves nothing")
	}
	if !p.launchSuppressed() {
		t.Fatal("launches not suppressed after a quota rejection")
	}
}

// A throttled terminate must not be dropped. TerminateMicrovm is quota'd at
// 10/s, so draining a full pool reliably trips it — and the old code logged the
// throttle and moved on, abandoning the box. An abandoned box keeps billing and
// keeps holding regional memory quota until the 8h cap, which is precisely what
// starved the pool at 129/200 while the launch loop failed 4x/s on 402s.
func TestDrainRetriesThrottledTerminates(t *testing.T) {
	p, f := testPool(t, PoolConfig{TargetStock: 2})
	for i := 0; i < 2; i++ {
		if err := p.launchOne(context.Background()); err != nil {
			t.Fatalf("launchOne: %v", err)
		}
	}
	// Every box gets throttled twice before AWS accepts the terminate.
	f.mu.Lock()
	f.terminateFailures = 4
	f.mu.Unlock()

	p.Drain()

	if _, _, terms := f.counts(); terms != 2 {
		t.Fatalf("drain confirmed %d terminate(s) through throttling, want 2 — the rest leaked", terms)
	}
	if got := p.Depth(); got != 0 {
		t.Fatalf("depth after drain = %d, want 0", got)
	}
}

// Stock and tracked sandboxes are the pool's "owned" set; the orphan sweep
// subtracts them from what AWS reports. If StockIDs under-reports, the sweep
// would consider live warm stock unowned and terminate it.
func TestStockIDsReportsEveryParkedBox(t *testing.T) {
	p, _ := testPool(t, PoolConfig{TargetStock: 3})
	for i := 0; i < 3; i++ {
		if err := p.launchOne(context.Background()); err != nil {
			t.Fatalf("launchOne: %v", err)
		}
	}
	ids := p.StockIDs()
	if len(ids) != 3 {
		t.Fatalf("StockIDs returned %d id(s), want 3 — a missing id would let the sweep reap live stock", len(ids))
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, e := range p.stock {
		if _, ok := ids[e.MicrovmID]; !ok {
			t.Fatalf("stocked box %s missing from StockIDs", e.MicrovmID)
		}
	}
}

// A reservation is owned stock, not free stock. Every accounting path has to
// agree on that, and each of these assertions corresponds to a distinct way the
// pool could quietly destroy itself.
func TestReservationsHoldTheirInvariants(t *testing.T) {
	p, f := testPool(t, PoolConfig{TargetStock: 4})
	for i := 0; i < 4; i++ {
		if err := p.launchOne(context.Background()); err != nil {
			t.Fatalf("launchOne: %v", err)
		}
	}

	got := p.Reserve(3)
	if len(got) != 3 {
		t.Fatalf("Reserve(3) returned %d", len(got))
	}
	if p.Depth() != 1 {
		t.Fatalf("stock after reserving 3 of 4 = %d, want 1", p.Depth())
	}
	// committed must still see all four, or the filler launches replacements
	// for boxes that were merely promised.
	if c := p.committed(); c != 4 {
		t.Fatalf("committed = %d, want 4 (reservations are owned)", c)
	}
	// The orphan sweep keys off StockIDs. A reserved box missing here would be
	// terminated mid-create.
	ids := p.StockIDs()
	if len(ids) != 4 {
		t.Fatalf("StockIDs = %d, want 4 (stock + reserved)", len(ids))
	}
	for _, e := range got {
		if _, ok := ids[e.MicrovmID]; !ok {
			t.Fatalf("reserved box %s absent from StockIDs — the sweep would reap it", e.MicrovmID)
		}
	}

	// Claim binds exactly one, and only once.
	e0 := got[0]
	if _, ok := p.ClaimReserved(e0.MicrovmID); !ok {
		t.Fatal("ClaimReserved missed a live reservation")
	}
	if _, ok := p.ClaimReserved(e0.MicrovmID); ok {
		t.Fatal("ClaimReserved returned the same reservation twice")
	}

	// Release puts one back as usable stock.
	if !p.ReleaseReserved(got[1].MicrovmID) {
		t.Fatal("ReleaseReserved missed a live reservation")
	}
	if p.Depth() != 2 {
		t.Fatalf("stock after release = %d, want 2", p.Depth())
	}

	// A stale reservation is DESTROYED, never returned to stock: its token may
	// already be in a customer's hands, and re-issuing the box would be
	// cross-tenant access. Burning a warm box is the cheap failure.
	stockBefore := p.Depth()
	p.mu.Lock()
	for _, r := range p.reserved {
		r.at = time.Now().Add(-2 * reservationTTL)
	}
	p.mu.Unlock()
	if n := p.expireReservations(); n != 1 {
		t.Fatalf("expireReservations retired %d, want 1", n)
	}
	if p.ReservedDepth() != 0 {
		t.Fatalf("reservations outstanding after expiry: %d", p.ReservedDepth())
	}
	if p.Depth() != stockBefore {
		t.Fatalf("stock grew from %d to %d — an expired reservation was re-pooled, which can hand a live token to a second tenant",
			stockBefore, p.Depth())
	}
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, _, terms := f.counts(); terms >= 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, _, terms := f.counts(); terms < 1 {
		t.Fatal("expired reservation was neither re-pooled nor terminated — it leaks quota")
	}
}

// A reservation binds a sandbox id to a box before any customer claims it, so
// the control plane can route that id the instant the edge answers a create.
// When the reservation dies instead, the binding has to die with it — otherwise
// a live sandbox id keeps resolving to a terminated box and every operation on
// it fails deep in the agent tunnel instead of cleanly.
func TestExpiringReservationNotifiesTheOwner(t *testing.T) {
	var mu sync.Mutex
	var forgot []string
	p, _ := testPool(t, PoolConfig{
		TargetStock: 2,
		OnExpire: func(microvmID string) {
			mu.Lock()
			defer mu.Unlock()
			forgot = append(forgot, microvmID)
		},
	})
	for i := 0; i < 2; i++ {
		if err := p.launchOne(context.Background()); err != nil {
			t.Fatalf("launchOne: %v", err)
		}
	}
	got := p.Reserve(2)
	if len(got) != 2 {
		t.Fatalf("Reserve(2) returned %d", len(got))
	}

	p.mu.Lock()
	for _, r := range p.reserved {
		r.at = time.Now().Add(-2 * reservationTTL)
	}
	p.mu.Unlock()
	if n := p.expireReservations(); n != 2 {
		t.Fatalf("expireReservations retired %d, want 2", n)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(forgot) != 2 {
		t.Fatalf("OnExpire fired %d time(s), want 2 — a binding survived its box", len(forgot))
	}
	for _, e := range got {
		found := false
		for _, id := range forgot {
			if id == e.MicrovmID {
				found = true
			}
		}
		if !found {
			t.Errorf("OnExpire never reported %s — its sandbox id still routes to a dead box", e.MicrovmID)
		}
	}
}

// The edge's PoolStock DO holds reserved boxes in its own stock for up to
// ENTRY_TTL_MS (10 minutes, cloudflare-workers/api-edge/src/pool_stock.ts)
// before releasing them. If this pool expired a reservation first it would
// terminate a box the DO still believes it owns, and the next create to pop that
// entry would get a 201 for a sandbox that does not exist.
//
// This is a real bug that shipped in the first cut of the reservation layer,
// where the TTL was 2 minutes. The margin belongs to us, so pin it.
func TestReservationTTLOutlivesTheEdgeStockTTL(t *testing.T) {
	const doEntryTTL = 10 * time.Minute
	if reservationTTL <= doEntryTTL {
		t.Fatalf("reservationTTL=%s does not exceed the DO's stock TTL (%s) — the edge would hand out terminated boxes",
			reservationTTL, doEntryTTL)
	}
}

// TargetStock bounds what the pool HOLDS, not what exists. A claimed box leaves
// the stock, so a target-only filler launches a replacement alongside every box
// doing real work — pool + live sandboxes grows without limit as load rises.
// That is how a 200-box pool alongside 300 live sandboxes put this account past
// its 1024GB regional ceiling and turned every create into ServiceQuotaExceeded.
//
// With a budget the pool becomes drainable: claims consume stock and refill
// waits for those boxes to be released.
func TestPoolStopsRefillingAtTheBoxBudget(t *testing.T) {
	inUse := 0
	p, f := testPool(t, PoolConfig{
		TargetStock:   10,
		MaxTotalBoxes: 12,
		InUse:         func() int { return inUse },
	})

	// Nothing claimed: the pool fills to its target as usual.
	for i := 0; i < 10; i++ {
		if p.overBudget() {
			t.Fatalf("refused to fill at stock=%d with nothing claimed", p.Depth())
		}
		if err := p.launchOne(context.Background()); err != nil {
			t.Fatalf("launchOne: %v", err)
		}
	}
	if p.Depth() != 10 {
		t.Fatalf("stock = %d, want 10", p.Depth())
	}

	// A burst claims eight. Stock drops to 2, and a target-only filler would
	// launch eight replacements — 10 stock + 8 claimed = 18 boxes, half again
	// over the budget of 12.
	for i := 0; i < 8; i++ {
		if _, ok := p.Claim(); !ok {
			t.Fatalf("claim %d missed", i)
		}
		inUse++
	}
	if p.Depth() != 2 {
		t.Fatalf("stock after 8 claims = %d, want 2", p.Depth())
	}

	// Refill is allowed up to the budget, not up to the target: 8 claimed + 2
	// stock = 10, so exactly 2 more boxes may be launched.
	for i := 0; i < 2; i++ {
		if p.overBudget() {
			t.Fatalf("stopped refilling at %d claimed + %d committed, under the budget of 12", inUse, p.committed())
		}
		if err := p.launchOne(context.Background()); err != nil {
			t.Fatalf("launchOne: %v", err)
		}
	}
	// Now at the ceiling. This is the assertion that matters: the pool is 6 short
	// of its target and must still refuse, because the missing boxes are alive as
	// customer sandboxes rather than gone.
	if total := p.committed() + inUse; total != 12 {
		t.Fatalf("total = %d, want 12", total)
	}
	if !p.overBudget() {
		t.Fatalf("pool kept refilling at the budget: %d claimed + %d committed, target %d — this is the overrun that exhausted the region",
			inUse, p.committed(), 10)
	}

	// As the burst drains, refill resumes.
	inUse = 5
	if p.overBudget() {
		t.Fatalf("still refusing to refill at %d claimed + %d committed, under the budget of 12", inUse, p.committed())
	}
	if err := p.launchOne(context.Background()); err != nil {
		t.Fatalf("launchOne after release: %v", err)
	}
	if f.runs == 0 {
		t.Fatal("no launches recorded")
	}
}

// A pool with no budget configured must behave exactly as before — cells that
// nobody has sized should not silently stop filling.
func TestPoolWithoutBudgetAlwaysRefills(t *testing.T) {
	p, _ := testPool(t, PoolConfig{TargetStock: 3})
	if p.overBudget() {
		t.Fatal("unbudgeted pool refused to refill")
	}
}

// Refusing to launch at the budget is not the same as standing down. Before the
// backoff, the filler re-evaluated the budget every LaunchInterval, so the
// instant any box was released it spent a RunMicrovm on a replacement and was at
// the ceiling again — tracking the budget exactly, and bidding for the same
// regional quota as the customer creates that had gone cold because the pool was
// drained. Measured on dev: 366 boxes manufactured in 30 minutes alongside 28
// creates rejected with "regional MicroVM quota exhausted".
//
// The observable difference is how often the loop asks. This counts that.
func TestAtBudgetTheFillerStandsDownInsteadOfProbingEveryTick(t *testing.T) {
	var probes int64
	const (
		interval = time.Millisecond
		delay    = 150 * time.Millisecond
		window   = 750 * time.Millisecond
	)
	p, f := testPool(t, PoolConfig{
		TargetStock:    50,
		MaxTotalBoxes:  10,
		LaunchInterval: interval,
		RefillDelay:    delay,
		// Pinned at the ceiling for the whole window: the burst has not drained.
		InUse: func() int { atomic.AddInt64(&probes, 1); return 10 },
	})

	ctx, cancel := context.WithCancel(context.Background())
	go p.Run(ctx)
	time.Sleep(window)
	cancel()

	got := atomic.LoadInt64(&probes)
	// One probe per delay, so ~5 across the window. Without the backoff the loop
	// evaluates the budget once per LaunchInterval — ~750, two orders of
	// magnitude more, every one of them a candidate launch.
	if max := int64(window/delay) + 3; got > max {
		t.Fatalf("budget evaluated %d times in %s, want at most %d — the filler is still spinning at tick rate, which is what makes it race customer creates for the regional quota",
			got, window, max)
	}
	if got == 0 {
		t.Fatal("budget never evaluated — the filler stood down permanently and would not refill when the burst drains")
	}
	if runs, _, _ := f.counts(); runs != 0 {
		t.Fatalf("launched %d box(es) while at the budget", runs)
	}
}

// The stand-down must never shorten an existing pause. A budget backoff landing
// during a quota backoff would otherwise let the pool resume launching straight
// into a quota that has not recovered.
func TestStandDownNeverShortensAnExistingPause(t *testing.T) {
	p, _ := testPool(t, PoolConfig{TargetStock: 1})

	p.suppressLaunches(time.Hour, errors.New("regional quota exhausted"))
	p.standDown(time.Millisecond)

	if !p.launchSuppressed() {
		t.Fatal("a short budget backoff cancelled a long quota backoff — the pool would relaunch into an exhausted quota")
	}
}
