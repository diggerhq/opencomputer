// A lease is one request's copy of its caller's credential, taken when the
// request is admitted (proxy.go). A request whose caller has no credential
// yet is held until its bind arrives, up to the hold cap.
//
// Invariants: a lease never changes, so a stream finishes on the credential
// it started with whatever is bound meanwhile; a binding's variables leave
// the table only inside a lease.
package main

import (
	"context"
	"time"
)

// holdResult says why Acquire returned without a lease.
type holdResult int

const (
	holdOK       holdResult = iota
	holdNotReady            // the caller's credential may still come → 503
	holdUnknown             // the binder knows no such caller → 401
	holdCanceled            // the client went away
)

type lease struct {
	s          *Bindings
	b          *binding
	sessionKey string
	cred       credential
	swapped    bool // first request on a credential that replaced another
	waited     bool // the request was held at least once
}

// Acquire waits (up to hold) until caller has a credential, then leases it.
func (s *Bindings) Acquire(ctx context.Context, caller string, hold time.Duration) (*lease, holdResult) {
	var timer *time.Timer
	for {
		s.mu.Lock()
		b := s.m[caller]
		if b != nil && b.credentialed {
			l := &lease{s: s, b: b, sessionKey: b.sessionKey, cred: b.cred, swapped: b.swapped, waited: timer != nil}
			b.swapped = false
			s.mu.Unlock()
			if timer != nil {
				timer.Stop()
			}
			return l, holdOK
		}
		ch := s.changed
		s.mu.Unlock()
		if timer == nil {
			timer = time.NewTimer(hold)
		}
		select {
		case <-ch:
		case <-ctx.Done():
			timer.Stop()
			return nil, holdCanceled
		case <-timer.C:
			s.mu.Lock()
			known := s.m[caller] != nil
			s.mu.Unlock()
			if known || !s.synced.Load() {
				return nil, holdNotReady
			}
			return nil, holdUnknown
		}
	}
}

// knownProfile is a known caller's profile (bound, or restored from disk;
// nil if it has none): the not-ready text is its own. Cold path: only after
// a hold timed out.
func (s *Bindings) knownProfile(caller string) *profile {
	s.mu.Lock()
	defer s.mu.Unlock()
	if b := s.m[caller]; b != nil {
		return b.cred.prof
	}
	return nil
}

// changes is closed at the table's next change.
func (s *Bindings) changes() <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.changed
}

// current: the caller is still bound to the lease's credential. A WebSocket
// closes between responses once it is not (websocket.go).
func (l *lease) current() bool {
	s := l.s
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.m[l.b.caller] == l.b && l.b.cred.equal(&l.cred)
}
