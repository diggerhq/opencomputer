package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strconv"
	"sync"
	"time"

	"github.com/google/uuid"
)

// apiKeyValidator is the slice of the store this cache needs. Narrowing it to
// an interface is what lets the caching and expiry rules be tested without a
// live Postgres.
type apiKeyValidator interface {
	ValidateAPIKey(ctx context.Context, keyPlaintext string) (uuid.UUID, *uuid.UUID, error)
}

// apikey_cache.go — memoized API-key validation.
//
// Every authenticated request used to cost two Postgres round trips before any
// handler ran: a SELECT to resolve the key and an inline UPDATE to stamp
// last_used. Under a burst-100 that is 200+ queries arriving at once against a
// pool that idles at five connections, so most requests pay for a fresh
// connection — TCP plus a Postgres auth handshake — before they can even ask
// the question.
//
// Measured on dev (eastus2 CP, burst-100, direct to Go, Caddy bypassed):
//
//	create   gotot=309ms  auth=309ms  tot=0ms
//	exec     gotot=449ms  auth=429ms  mgrexec=18ms
//
// The handler work was already at zero. Authentication was the entire cost.
//
// The tradeoff this makes explicit: a revoked or deleted key stays valid for up
// to the TTL. That is why the TTL is short and tunable rather than generous,
// and why failures are cached far more briefly than successes — a key that was
// just created must not be locked out.
type apiKeyCache struct {
	mu  sync.RWMutex
	m   map[string]apiKeyEntry
	ttl time.Duration
}

type apiKeyEntry struct {
	orgID  uuid.UUID
	userID *uuid.UUID
	ok     bool
	exp    time.Time
}

// negTTL bounds how long a rejection is remembered. Short enough that a
// freshly minted key works almost immediately, long enough that a client
// looping on a bad key cannot use it to hammer Postgres.
const negTTL = 2 * time.Second

// defaultAPIKeyTTL is the positive-entry lifetime, and therefore the worst-case
// window in which a revoked key still works.
const defaultAPIKeyTTL = 30 * time.Second

func newAPIKeyCache() *apiKeyCache {
	ttl := defaultAPIKeyTTL
	if v := os.Getenv("OPENSANDBOX_APIKEY_CACHE_TTL_MS"); v != "" {
		if ms, err := strconv.Atoi(v); err == nil && ms >= 0 {
			ttl = time.Duration(ms) * time.Millisecond
		}
	}
	return &apiKeyCache{m: make(map[string]apiKeyEntry), ttl: ttl}
}

// validate resolves a key, consulting the cache first.
//
// A TTL of zero disables caching entirely, which keeps the old behaviour
// available without a rebuild if revocation latency ever matters more than
// burst latency.
func (c *apiKeyCache) validate(ctx context.Context, store apiKeyValidator, key string) (uuid.UUID, *uuid.UUID, bool) {
	if c.ttl <= 0 {
		orgID, userID, err := store.ValidateAPIKey(ctx, key)
		return orgID, userID, err == nil
	}

	// Key the map by digest rather than the secret itself, so a heap dump of a
	// long-lived process does not hand over live API keys.
	ck := hashFor(key)

	now := time.Now()
	c.mu.RLock()
	e, found := c.m[ck]
	c.mu.RUnlock()
	if found && now.Before(e.exp) {
		if e.ok {
			// last_used is refreshed only on a miss, so it now tracks the key
			// to TTL resolution instead of being rewritten on every request.
			// That is a deliberate loss of precision in exchange for removing
			// a database write from the hot path.
			return e.orgID, e.userID, true
		}
		return uuid.Nil, nil, false
	}

	orgID, userID, err := store.ValidateAPIKey(ctx, key)
	ent := apiKeyEntry{orgID: orgID, userID: userID, ok: err == nil}
	if ent.ok {
		ent.exp = now.Add(c.ttl)
	} else {
		ent.exp = now.Add(negTTL)
	}

	c.mu.Lock()
	// Bound the map. Keys are per-org and few, but an attacker spraying random
	// keys would otherwise grow it without limit; dropping everything is
	// cheaper than tracking an eviction order and costs one slow request.
	if len(c.m) > 4096 {
		c.m = make(map[string]apiKeyEntry, 64)
	}
	c.m[ck] = ent
	c.mu.Unlock()

	return orgID, userID, ent.ok
}

// hashFor digests a key for use as a map key.
func hashFor(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}
