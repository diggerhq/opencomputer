// Concurrency caps, both counted between admission and the request's end:
//   - per caller (-max-inflight-per-caller, held requests included): one
//     session cannot queue enough hanging requests to starve the others;
//   - per profile `concurrency` key (profile.go): every caller whose binding
//     expands the key alike shares it, so one upstream credential is never
//     driven harder than its limit however many sessions use it. A
//     WebSocket counts each response it carries, not the connection
//     (websocket.go): its handshake is refused at the cap, but an idle
//     tunnel holds no slot.
//
// Over either → 429 with Retry-After: 1 (proxy.go). A zero cap, or a nil
// counter (a profile without `concurrency`), is no limit.
package main

import "sync"

// inflight counts requests per key under a cap.
type inflight struct {
	limit int // 0 = none

	mu sync.Mutex
	n  map[string]int
}

func newInflight(limit int) *inflight {
	return &inflight{limit: limit, n: map[string]int{}}
}

// enter counts a request against key's cap; false when key is at it.
func (c *inflight) enter(key string) bool {
	if c == nil || c.limit <= 0 {
		return true
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.n[key] >= c.limit {
		return false
	}
	c.n[key]++
	return true
}

// add counts a request against key whatever its cap: a response on a
// WebSocket already open cannot be refused (websocket.go).
func (c *inflight) add(key string) {
	if c == nil || c.limit <= 0 {
		return
	}
	c.mu.Lock()
	c.n[key]++
	c.mu.Unlock()
}

func (c *inflight) leave(key string) {
	if c == nil || c.limit <= 0 {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.n[key] <= 1 {
		delete(c.n, key)
	} else {
		c.n[key]--
	}
}
