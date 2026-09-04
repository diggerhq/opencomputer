package awsvm

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	lambdamicrovms "github.com/aws/aws-sdk-go-v2/service/lambdamicrovms"
	mvtypes "github.com/aws/aws-sdk-go-v2/service/lambdamicrovms/types"
)

// termAPI records terminate calls and can fail the first N of them the way a
// throttled account does.
type termAPI struct {
	fakeAPI
	mu       sync.Mutex
	calls    []string
	failFor  map[string]int // id → remaining throttles to serve
	seenOnce map[string]int // id → total attempts
}

func (f *termAPI) TerminateMicrovm(_ context.Context, in *lambdamicrovms.TerminateMicrovmInput, _ ...func(*lambdamicrovms.Options)) (*lambdamicrovms.TerminateMicrovmOutput, error) {
	id := aws.ToString(in.MicrovmIdentifier)
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.seenOnce == nil {
		f.seenOnce = map[string]int{}
	}
	f.seenOnce[id]++
	if n := f.failFor[id]; n > 0 {
		f.failFor[id] = n - 1
		return nil, &mvtypes.ThrottlingException{}
	}
	f.calls = append(f.calls, id)
	return &lambdamicrovms.TerminateMicrovmOutput{}, nil
}

func (f *termAPI) done() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

func waitFor(t *testing.T, d time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return cond()
}

// A throttled terminate used to return an error to the customer AND leave the
// box running — it bills and holds regional quota until the 8h cap. Deleting 112
// sandboxes on dev produced 11 such leaks. The queue must retry until the box is
// actually gone.
func TestTerminateQueueRetriesThrottledDestroys(t *testing.T) {
	f := &termAPI{failFor: map[string]int{"mvm-1": 3}}
	c := NewClientWithAPI(f, Config{ImageIdentifier: "arn:image"})
	term := newTerminator(c)
	defer term.close()

	if !term.enqueue("mvm-1") {
		t.Fatal("enqueue refused")
	}
	if !waitFor(t, 10*time.Second, func() bool { return len(f.done()) == 1 }) {
		t.Fatalf("box never terminated through %d throttles — this is the leak", 3)
	}
	if got := f.seenOnce["mvm-1"]; got != 4 {
		t.Fatalf("attempts = %d, want 4 (3 throttled + 1 success)", got)
	}
}

// Destroy is idempotent, and a rate-limited quota must not be spent twice on the
// same box because a client retried or double-clicked.
func TestTerminateQueueDedupesInFlight(t *testing.T) {
	f := &termAPI{failFor: map[string]int{}}
	c := NewClientWithAPI(f, Config{ImageIdentifier: "arn:image"})
	term := newTerminator(c)
	defer term.close()

	for i := 0; i < 5; i++ {
		term.enqueue("mvm-dup")
	}
	if !waitFor(t, 5*time.Second, func() bool { return len(f.done()) >= 1 }) {
		t.Fatal("never terminated")
	}
	time.Sleep(300 * time.Millisecond)
	if n := len(f.done()); n != 1 {
		t.Fatalf("terminated the same box %d times — duplicate destroys burn a 10/s quota", n)
	}
}

// The whole point is pacing: a bulk delete must not fire every terminate at once
// against a 10/s quota, which is what produced the throttles in the first place.
func TestTerminateQueuePacesBulkDestroys(t *testing.T) {
	f := &termAPI{failFor: map[string]int{}}
	c := NewClientWithAPI(f, Config{ImageIdentifier: "arn:image"})
	term := newTerminator(c)
	defer term.close()

	const n = 8
	start := time.Now()
	for i := 0; i < n; i++ {
		term.enqueue(string(rune('a'+i)) + "-box")
	}
	if !waitFor(t, 15*time.Second, func() bool { return len(f.done()) == n }) {
		t.Fatalf("only %d of %d terminated", len(f.done()), n)
	}
	// n calls at terminatePace apart take at least (n-1) intervals.
	min := time.Duration(n-1) * terminatePace
	if elapsed := time.Since(start); elapsed < min {
		t.Fatalf("drained %d terminates in %s, faster than the %s the quota allows — pacing is not applied",
			n, elapsed, min)
	}
}
