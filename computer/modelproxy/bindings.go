// Bindings: which runner unit serves which session with which credential.
// The proxy is the source of truth for this table; the host feeds it over
// the control socket.
//
// A credential is a profile (profile.go) and the values of its variables.
// `bind` names them as {profile, vars, key}: the key is the host's own name
// for the credential (a fingerprint, never the secret), echoed on `bound`,
// `observed` and telemetry. A bind with mode "refuse" makes the proxy answer
// the unit's requests with 401 and the bind's reason.
//
// Hosts from before profiles send {mode, provider, token, accountId,
// fingerprint}: read as profile = provider (or -default-profile), vars
// token and accountId, key = fingerprint, and answered in the same terms.
//
// Invariants:
//   - A unit serves one sessionKey for its life; a bind naming another
//     sessionKey is refused, never applied.
//   - A new credential for a bound unit takes effect only while no stream is
//     in flight for that unit (at bind time, or when its last stream ends),
//     never mid-stream; `bound` is sent when it takes effect.
//   - Variables live only in memory; the persisted table (persist.go) has none.
//   - Entries restored from disk are "known, not credentialed": requests for
//     them are held until their bind arrives or the hold cap (then 503).
//   - Only `release` removes a binding. A closed control connection (host
//     restart) keeps every binding and its variables; serving continues.
//   - The profile is part of the credential: a bind that changes it is a
//     swap like any other, and a binding always has every variable its
//     profile uses.
package main

import (
	"context"
	"maps"
	"sync"
	"time"
)

const (
	modeRefuse = "refuse"
	// modeLegacy is what a host from before profiles calls a binding that
	// carries a credential.
	modeLegacy = "subscription"
)

type credential struct {
	refuse bool
	prof   *profile // nil: a refuse bind that names none
	vars   map[string]string
	key    string
	reason string
	// legacy: bound in the pre-profile terms; `bound` answers in them.
	legacy         bool
	legacyProvider string
}

// equal: the same credential (how it was bound aside).
func (c *credential) equal(o *credential) bool {
	return c.refuse == o.refuse && c.prof == o.prof && c.key == o.key && c.reason == o.reason && maps.Equal(c.vars, o.vars)
}

func (c *credential) profileName() string {
	if c.prof == nil {
		return ""
	}
	return c.prof.name
}

func (c *credential) mode() string {
	if c.refuse {
		return modeRefuse
	}
	return ""
}

type binding struct {
	unit         string
	sessionKey   string
	cred         credential
	credentialed bool
	pending      *credential
	inflight     int
	swapped      bool // credential changed; not yet used by a request
}

// persisted is a binding as written to disk and listed in `hello`: no
// variables. Fingerprint and Provider are how files from before profiles
// name Key and Profile; they are read, never written (persist.go).
type persisted struct {
	Unit        string `json:"unit"`
	SessionKey  string `json:"sessionKey"`
	Profile     string `json:"profile,omitempty"`
	Key         string `json:"key,omitempty"`
	Mode        string `json:"mode,omitempty"` // "refuse", or absent
	Fingerprint string `json:"fingerprint,omitempty"`
	Provider    string `json:"provider,omitempty"`
}

// sender delivers proxy→host messages without blocking (control.go).
type sender interface{ send(v any) }

type Bindings struct {
	profiles       *profiles
	defaultProfile string // -default-profile: a bind or file entry that names none

	mu      sync.Mutex
	m       map[string]*binding
	changed chan struct{} // closed and replaced on every change: wakes held requests
	out     sender
	dirty   func()         // the table's persisted shape changed
	prewarm func(*profile) // a unit was bound: pre-dial its upstream
	now     func() time.Time
}

func NewBindings(ps *profiles, defaultProfile string, out sender, dirty func()) *Bindings {
	if dirty == nil {
		dirty = func() {}
	}
	return &Bindings{profiles: ps, defaultProfile: defaultProfile, m: map[string]*binding{}, changed: make(chan struct{}), out: out, dirty: dirty, now: time.Now}
}

// broadcastLocked wakes every held request; callers hold mu.
func (s *Bindings) broadcastLocked() {
	close(s.changed)
	s.changed = make(chan struct{})
}

// changes is closed at the table's next change.
func (s *Bindings) changes() <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.changed
}

// Restore loads the persisted table at start: every entry known, none credentialed.
func (s *Bindings) Restore(entries []persisted) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range entries {
		if !isRunnerUnit(e.Unit) || e.SessionKey == "" {
			continue
		}
		name := firstNonEmpty(e.Profile, e.Provider, s.defaultProfile)
		prof := s.profiles.get(name)
		refuse := e.Mode == modeRefuse
		if prof == nil && !(refuse && name == "") {
			logWarn("bindings file: unknown profile; entry dropped", "unit", e.Unit, "profile", truncate(name, 40))
			continue
		}
		s.m[e.Unit] = &binding{unit: e.Unit, sessionKey: e.SessionKey, cred: credential{refuse: refuse, prof: prof, key: firstNonEmpty(e.Key, e.Fingerprint)}}
	}
}

// Snapshot is the persisted shape of the table, sorted by nothing in particular.
func (s *Bindings) Snapshot() []persisted {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]persisted, 0, len(s.m))
	for _, b := range s.m {
		out = append(out, persisted{Unit: b.unit, SessionKey: b.sessionKey, Profile: b.cred.profileName(), Key: b.cred.key, Mode: b.cred.mode()})
	}
	return out
}

func (s *Bindings) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.m)
}

// bindMsg is a host `bind`. Provider, Token, AccountID and Fingerprint are
// the pre-profile names (see the top of this file).
type bindMsg struct {
	Unit       string            `json:"unit"`
	SessionKey string            `json:"sessionKey"`
	Profile    string            `json:"profile,omitempty"`
	Vars       map[string]string `json:"vars,omitempty"`
	Key        string            `json:"key,omitempty"`
	Mode       string            `json:"mode,omitempty"` // "refuse", or absent
	Reason     string            `json:"reason,omitempty"`

	Provider    string `json:"provider,omitempty"`
	Token       string `json:"token,omitempty"`
	AccountID   string `json:"accountId,omitempty"`
	Fingerprint string `json:"fingerprint,omitempty"`
}

// Bind applies a host `bind`. Returns false when refused.
func (s *Bindings) Bind(m bindMsg) bool {
	c, bad := s.credentialOf(m)
	if bad != "" {
		s.refuse(m, c.profileName(), bad)
		return false
	}
	s.mu.Lock()
	b := s.m[m.Unit]
	if b != nil && b.sessionKey != m.SessionKey {
		s.mu.Unlock()
		s.refuse(m, c.profileName(), "unit bound to another session")
		return false
	}
	if b == nil {
		b = &binding{unit: m.Unit, sessionKey: m.SessionKey}
		s.m[m.Unit] = b
	}
	if b.credentialed && b.inflight > 0 && !b.cred.equal(&c) {
		b.pending = &c      // applied when the unit's last stream ends
		s.broadcastLocked() // a WebSocket on the old credential closes between responses (websocket.go)
		s.mu.Unlock()
		logInfo("bind pending until idle", "unit", m.Unit, "session_key", m.SessionKey, "mode", c.mode(), "profile", c.profileName(), "key", c.key)
		return true
	}
	reason := "bind"
	if b.credentialed && !b.cred.equal(&c) {
		reason = "swap"
	}
	s.applyLocked(b, c, reason)
	s.mu.Unlock()
	return true
}

// credentialOf checks a bind and reads its credential; bad is why it is
// refused ("" = it is not).
func (s *Bindings) credentialOf(m bindMsg) (c credential, bad string) {
	c = credential{refuse: m.Mode == modeRefuse, key: firstNonEmpty(m.Key, m.Fingerprint), reason: m.Reason,
		legacy: m.Profile == "", legacyProvider: m.Provider}
	name := firstNonEmpty(m.Profile, m.Provider, s.defaultProfile)
	c.prof = s.profiles.get(name)
	switch {
	case !isRunnerUnit(m.Unit):
		return c, "invalid unit"
	case m.SessionKey == "":
		return c, "missing sessionKey"
	case c.prof == nil && !(c.refuse && name == ""):
		return c, "unknown profile"
	case m.Mode != "" && m.Mode != modeRefuse && m.Mode != modeLegacy:
		return c, "unknown mode"
	}
	if c.refuse {
		c.key = ""
		return c, ""
	}
	c.vars = make(map[string]string, len(c.prof.vars))
	for _, v := range c.prof.vars { // only what the profile uses is kept
		val := m.Vars[v]
		if val == "" && v == "token" {
			val = m.Token
		}
		if val == "" && v == "accountId" {
			val = m.AccountID
		}
		switch {
		case val == "":
			return c, "missing " + v
		case !validHeaderValue(val):
			return c, "invalid " + v
		}
		c.vars[v] = val
	}
	return c, ""
}

func (s *Bindings) refuse(m bindMsg, profile, reason string) {
	logWarn("bind refused", "unit", m.Unit, "session_key", m.SessionKey, "profile", truncate(firstNonEmpty(m.Profile, m.Provider), 40), "reason", reason)
	s.out.send(refusedMsg{T: "refused", Unit: m.Unit, SessionKey: m.SessionKey, Reason: reason})
	// An unknown profile is not a dimension value: profile is "" then.
	e := s.bindingEvent("refused", m.Unit, m.SessionKey, m.Mode, "", profile)
	e.Outcome = "failed"
	s.out.send(e)
}

// bindingEvent is the model.binding telemetry event: the action (bind, swap,
// release, refused), unit, mode and key, and the profile as the envelope's
// `provider` dimension; never a variable.
func (s *Bindings) bindingEvent(action, unit, sessionKey, mode, key, profile string) eventMsg {
	e := newEvent(s.now(), "model.binding")
	e.SessionKey = sessionKey
	e.Provider = profile
	e.Outcome = "completed"
	e.Data = map[string]any{"action": action, "unit": unit}
	if mode != "" {
		e.Data["mode"] = mode
	}
	if key != "" {
		e.Data["fingerprint"] = key
	}
	return e
}

// applyLocked makes c the unit's effective credential and reports it.
func (s *Bindings) applyLocked(b *binding, c credential, reason string) {
	shapeChanged := !b.credentialed || b.cred.refuse != c.refuse || b.cred.key != c.key || b.cred.prof != c.prof
	b.cred, b.credentialed, b.pending = c, true, nil
	s.broadcastLocked()
	if shapeChanged {
		s.dirty()
	}
	bound := boundMsg{T: "bound", Unit: b.unit, SessionKey: b.sessionKey, Profile: c.profileName(), Key: c.key, Mode: c.mode()}
	if c.legacy {
		bound.Fingerprint, bound.Provider = c.key, c.legacyProvider
		if !c.refuse {
			bound.Mode = modeLegacy
		}
	}
	s.out.send(bound)
	s.out.send(s.bindingEvent(reason, b.unit, b.sessionKey, c.mode(), c.key, c.profileName()))
	if reason == "swap" {
		b.swapped = true // the next request is the first on the new credential
	}
	if reason == "bind" && !c.refuse && s.prewarm != nil {
		s.prewarm(c.prof)
	}
	logInfo("bound", "unit", b.unit, "session_key", b.sessionKey, "mode", c.mode(), "profile", c.profileName(), "key", c.key, "reason", reason)
}

// Release drops a unit's binding. Streams already in flight finish on the
// credential they started with.
func (s *Bindings) Release(unit string) {
	s.mu.Lock()
	b := s.m[unit]
	if b == nil {
		s.mu.Unlock()
		return
	}
	delete(s.m, unit)
	s.broadcastLocked()
	s.mu.Unlock()
	s.dirty()
	s.out.send(s.bindingEvent("release", unit, b.sessionKey, b.cred.mode(), b.cred.key, b.cred.profileName()))
	logInfo("released", "unit", unit, "session_key", b.sessionKey)
}

// Waiting is how many units still have no credential. The host's `synced`
// (every live bind re-sent) only logs it: nothing is dropped (only `release`
// removes a binding) and nothing stops holding, since a unit's bind may
// still come a moment later; a held request waits up to the cap regardless.
func (s *Bindings) Waiting() (waiting int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, b := range s.m {
		if !b.credentialed {
			waiting++
		}
	}
	return waiting
}

// holdResult says why Acquire returned without a lease.
type holdResult int

const (
	holdOK             holdResult = iota
	holdTimeoutKnown              // known unit, credential never arrived → 503
	holdTimeoutUnknown            // unit never bound → 401
	holdCanceled                  // the client went away
)

// lease is one request's hold on a unit's credential.
type lease struct {
	s          *Bindings
	b          *binding
	sessionKey string
	cred       credential
	counted    bool
	swapped    bool // first request on a credential that replaced another
	waited     bool // the request was held at least once
	// pending is the profile of a credential waiting for the unit to go
	// idle (a rebind mid-stream), read under the same lock as cred; nil when
	// there is none, or it names no profile (a refuse).
	pending *profile
}

// Acquire waits (up to hold) until unit has a credential, then returns it.
// A lease on a credential (not a refuse) counts as an in-flight stream until Done.
func (s *Bindings) Acquire(ctx context.Context, unit string, hold time.Duration) (*lease, holdResult) {
	var timer *time.Timer
	for {
		s.mu.Lock()
		b := s.m[unit]
		if b != nil && b.credentialed {
			l := &lease{s: s, b: b, sessionKey: b.sessionKey, cred: b.cred, swapped: b.swapped, waited: timer != nil}
			b.swapped = false
			if b.pending != nil {
				l.pending = b.pending.prof
			}
			if !b.cred.refuse {
				b.inflight++
				l.counted = true
			}
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
			known := s.m[unit] != nil
			s.mu.Unlock()
			if known {
				return nil, holdTimeoutKnown
			}
			return nil, holdTimeoutUnknown
		}
	}
}

// knownProfile is a known unit's profile (bound, or restored from disk; nil
// if it has none): the not-ready text is its own. Cold path: only after a
// hold timed out.
func (s *Bindings) knownProfile(unit string) *profile {
	s.mu.Lock()
	defer s.mu.Unlock()
	if b := s.m[unit]; b != nil {
		return b.cred.prof
	}
	return nil
}

// Done ends the lease; the unit's pending credential applies if this was its
// last stream.
func (l *lease) Done() {
	if !l.counted {
		return
	}
	s := l.s
	s.mu.Lock()
	defer s.mu.Unlock()
	l.b.inflight--
	if l.b.inflight == 0 && l.b.pending != nil && s.m[l.b.unit] == l.b {
		s.applyLocked(l.b, *l.b.pending, "swap")
	}
}

// current: the unit is still bound to the lease's credential, with no other
// waiting for it to go idle. A WebSocket closes once it is not (websocket.go).
func (l *lease) current() bool {
	s := l.s
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.m[l.b.unit] == l.b && l.b.pending == nil && l.b.cred.equal(&l.cred)
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if s != "" {
			return s
		}
	}
	return ""
}
