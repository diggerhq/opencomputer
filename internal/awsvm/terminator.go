package awsvm

import (
	"context"
	"errors"
	"log"
	"sync"
	"time"
)

// terminator.go — a paced, retrying queue for TerminateMicrovm.
//
// TerminateMicrovm is quota'd at 10/s. Every caller that destroyed a box by
// calling the API directly was therefore one burst away from failure, and the
// failure mode is the worst one available: a throttled terminate returns an
// error to the customer AND leaves the box running, so it bills and holds
// regional memory quota until the 8h service cap. Measured on dev — a delete of
// 112 sandboxes returned 11 × HTTP 500, each one a leaked box.
//
// That is also where a share of the "orphans" came from. The orphan sweep exists
// to catch boxes nothing owns, but it is a backstop with a 20-minute floor and a
// 25-per-pass cap; manufacturing orphans on every bulk delete and relying on the
// sweep to mop up is not a design, it is a leak with a janitor.
//
// So destroys are enqueued rather than called. The queue drains at the quota,
// retries throttles with backoff, and the caller returns as soon as the intent
// is recorded — which is honest, because AWS terminate is asynchronous anyway:
// the API acknowledges long before the box is actually gone.
//
// What this deliberately does NOT do is guarantee delivery across a process
// restart. A queued terminate lost to a crash becomes an orphan, and the sweep
// reclaims it — that is the layering: the queue makes leaks rare, the sweep makes
// them recoverable.

// terminateQueueDepth bounds the backlog. Sized well above any plausible burst
// (a benchmark destroying 100 sandboxes at once is 100 entries) so enqueue never
// blocks the caller in practice; if it ever fills, falling back to a synchronous
// terminate is better than dropping the box on the floor.
const terminateQueueDepth = 4096

// terminatePace is the interval between terminate calls. The quota is 10/s;
// 120ms leaves headroom for the pool's own retirement traffic, which shares it.
const terminatePace = 120 * time.Millisecond

// terminateRetries bounds attempts per box. Combined with the doubling backoff
// this spans well over a minute, which is far longer than any throttle episode
// observed on this account.
const terminateRetries = 6

// terminator serializes destroys onto one paced worker.
type terminator struct {
	client *Client
	queue  chan string

	start sync.Once
	stop  chan struct{}

	mu       sync.Mutex
	inflight map[string]struct{} // dedupes repeat destroys of the same box
}

func newTerminator(client *Client) *terminator {
	return &terminator{
		client:   client,
		queue:    make(chan string, terminateQueueDepth),
		stop:     make(chan struct{}),
		inflight: make(map[string]struct{}),
	}
}

// enqueue schedules a box for termination. Returns false if the queue is full,
// which tells the caller to terminate synchronously rather than lose the box.
//
// Duplicate ids are dropped: destroy is idempotent, and a customer double-click
// should not consume two slots of a rate-limited quota.
func (t *terminator) enqueue(microvmID string) bool {
	if t == nil || microvmID == "" {
		return false
	}
	t.start.Do(func() { go t.run() })

	t.mu.Lock()
	if _, dup := t.inflight[microvmID]; dup {
		t.mu.Unlock()
		return true
	}
	t.inflight[microvmID] = struct{}{}
	t.mu.Unlock()

	select {
	case t.queue <- microvmID:
		return true
	default:
		t.mu.Lock()
		delete(t.inflight, microvmID)
		t.mu.Unlock()
		log.Printf("awsvm: terminate queue full (%d) — falling back to a direct call for %s", terminateQueueDepth, microvmID)
		return false
	}
}

// depth reports the current backlog, for telemetry and tests.
func (t *terminator) depth() int {
	if t == nil {
		return 0
	}
	return len(t.queue)
}

func (t *terminator) run() {
	tick := time.NewTicker(terminatePace)
	defer tick.Stop()
	for {
		select {
		case <-t.stop:
			return
		case id := <-t.queue:
			t.terminateWithRetry(id)
			// Pace AFTER the call, so a burst cannot arrive faster than the
			// quota even when every terminate succeeds immediately.
			select {
			case <-tick.C:
			case <-t.stop:
				return
			}
		}
	}
}

func (t *terminator) terminateWithRetry(microvmID string) {
	defer func() {
		t.mu.Lock()
		delete(t.inflight, microvmID)
		t.mu.Unlock()
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()

	backoff := 250 * time.Millisecond
	for attempt := 1; ; attempt++ {
		err := t.client.Terminate(ctx, microvmID)
		if err == nil {
			return
		}
		// Only throttling is worth retrying: a box already gone, or one we are
		// not allowed to touch, answers identically however long we wait.
		if !errors.Is(err, ErrThrottled) || attempt >= terminateRetries {
			log.Printf("awsvm: terminate %s failed after %d attempt(s): %v — the orphan sweep is the backstop",
				microvmID, attempt, err)
			return
		}
		select {
		case <-time.After(backoff):
		case <-ctx.Done():
			log.Printf("awsvm: terminate %s abandoned after %d attempt(s) — box holds quota until the age cap", microvmID, attempt)
			return
		}
		backoff *= 2
	}
}

func (t *terminator) close() {
	if t == nil {
		return
	}
	select {
	case <-t.stop:
	default:
		close(t.stop)
	}
}

// ── shared with other backends ──────────────────────────────────────────────

// Terminator is the exported face of the paced destroy queue.
//
// It exists because the direct-exec backend (internal/awsvmlite) had exactly
// the bug this file was written to fix, and reimplementing it there would have
// been the second copy of a rate limiter for one shared quota. The quota is per
// ACCOUNT and region, not per backend — two unpaced callers racing it is the
// same failure as one.
//
// Deliberately a thin wrapper rather than exporting the type: the queue's
// lifecycle (the lazy start, the dedupe set) is not something a caller should
// be able to reach into, and Manager keeps using the unexported form unchanged.
type Terminator struct{ t *terminator }

// NewTerminator builds a paced destroy queue over a client. The worker starts
// lazily on the first Enqueue, so an idle backend costs nothing.
func NewTerminator(client *Client) *Terminator {
	return &Terminator{t: newTerminator(client)}
}

// Enqueue schedules a box for termination, returning false only when the queue
// is full — which tells the caller to terminate synchronously rather than lose
// the box entirely.
func (t *Terminator) Enqueue(microvmID string) bool {
	if t == nil {
		return false
	}
	return t.t.enqueue(microvmID)
}

// Depth reports the backlog, for telemetry.
func (t *Terminator) Depth() int {
	if t == nil {
		return 0
	}
	return t.t.depth()
}

// Close stops the worker.
func (t *Terminator) Close() {
	if t == nil {
		return
	}
	t.t.close()
}
