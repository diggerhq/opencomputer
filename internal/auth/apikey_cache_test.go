package auth

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

type fakeValidator struct {
	mu    sync.Mutex
	calls int
	org   uuid.UUID
	err   error
}

func (f *fakeValidator) ValidateAPIKey(ctx context.Context, key string) (uuid.UUID, *uuid.UUID, error) {
	f.mu.Lock()
	f.calls++
	f.mu.Unlock()
	if f.err != nil {
		return uuid.Nil, nil, f.err
	}
	return f.org, nil, nil
}

func (f *fakeValidator) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls
}

func TestAPIKeyCache_HitAvoidsStore(t *testing.T) {
	fv := &fakeValidator{org: uuid.New()}
	c := &apiKeyCache{m: map[string]apiKeyEntry{}, ttl: time.Minute}

	for i := 0; i < 5; i++ {
		org, _, ok := c.validate(context.Background(), fv, "k")
		if !ok || org != fv.org {
			t.Fatalf("iteration %d: got ok=%v org=%v", i, ok, org)
		}
	}
	if fv.count() != 1 {
		t.Fatalf("expected 1 store call across 5 validations, got %d", fv.count())
	}
}

// The burst is the whole reason this cache exists, so the concurrent case is
// the one that matters: many goroutines hitting a cold entry at once must all
// get the right answer.
func TestAPIKeyCache_ConcurrentColdStart(t *testing.T) {
	fv := &fakeValidator{org: uuid.New()}
	c := &apiKeyCache{m: map[string]apiKeyEntry{}, ttl: time.Minute}

	var wg sync.WaitGroup
	errs := make(chan error, 100)
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			org, _, ok := c.validate(context.Background(), fv, "k")
			if !ok || org != fv.org {
				errs <- fmt.Errorf("ok=%v org=%v", ok, org)
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
}

func TestAPIKeyCache_Expiry(t *testing.T) {
	fv := &fakeValidator{org: uuid.New()}
	c := &apiKeyCache{m: map[string]apiKeyEntry{}, ttl: 20 * time.Millisecond}

	c.validate(context.Background(), fv, "k")
	c.validate(context.Background(), fv, "k")
	if fv.count() != 1 {
		t.Fatalf("expected the second call to hit cache, got %d store calls", fv.count())
	}
	time.Sleep(30 * time.Millisecond)
	c.validate(context.Background(), fv, "k")
	if fv.count() != 2 {
		t.Fatalf("expected re-validation after TTL, got %d store calls", fv.count())
	}
}

// A rejection must not be remembered for the full positive TTL, or a key
// created moments after a failed probe would stay locked out.
func TestAPIKeyCache_RejectionExpiresFast(t *testing.T) {
	fv := &fakeValidator{err: fmt.Errorf("invalid API key")}
	c := &apiKeyCache{m: map[string]apiKeyEntry{}, ttl: time.Hour}

	if _, _, ok := c.validate(context.Background(), fv, "bad"); ok {
		t.Fatal("expected rejection")
	}
	if _, _, ok := c.validate(context.Background(), fv, "bad"); ok {
		t.Fatal("expected cached rejection")
	}
	if fv.count() != 1 {
		t.Fatalf("expected the rejection to be cached, got %d store calls", fv.count())
	}
	if got := c.m[hashFor("bad")].exp.Sub(time.Now()); got > negTTL {
		t.Fatalf("rejection cached for %v, want <= %v", got, negTTL)
	}
}

// TTL zero must bypass the cache entirely, so revocation latency can be traded
// back for correctness without a rebuild.
func TestAPIKeyCache_DisabledByZeroTTL(t *testing.T) {
	fv := &fakeValidator{org: uuid.New()}
	c := &apiKeyCache{m: map[string]apiKeyEntry{}, ttl: 0}

	c.validate(context.Background(), fv, "k")
	c.validate(context.Background(), fv, "k")
	if fv.count() != 2 {
		t.Fatalf("expected caching disabled, got %d store calls", fv.count())
	}
}
