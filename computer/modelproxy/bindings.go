// Bindings: which caller serves which session with which credential. The
// binder is the source of truth; this table is the proxy's copy of it, fed
// over the control socket (frames.go).
//
// A credential is a profile (profile.go) and the values of its variables.
// `bind` names them as {profile, vars, key}: the key is the binder's own name
// for the credential (never the secret), echoed on `bound`, `observed` and
// telemetry. A bind with mode "refuse" makes the proxy answer the caller's
// requests with 401 and the bind's reason.
//
// Invariants:
//   - A caller serves one sessionKey from its bind to its release; a bind
//     naming another sessionKey is refused, never applied.
//   - A bind applies to the caller's next request. Streams in flight finish
//     on the credential they started with (lease.go).
//   - The same bind twice changes nothing and is answered `bound` again.
//   - Variables live only in memory; the persisted table (persist.go) has none.
//   - Entries restored from disk are "known, not credentialed": requests for
//     them are held until their bind arrives or the hold cap (then 503).
//   - Only `release` removes a binding. A closed control connection keeps
//     every binding and its variables; serving continues.
//   - A binding always has every variable its profile uses.
//   - Nothing is sent or logged while mu is held.
package main

import (
	"maps"
	"sync"
	"sync/atomic"
	"time"
)

const (
	modeProfile = "profile"
	modeRefuse  = "refuse"
)

type credential struct {
	refuse bool
	prof   *profile // nil for a refuse
	vars   map[string]string
	key    string
	reason string
}

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
	return modeProfile
}

type binding struct {
	caller       string
	sessionKey   string
	cred         credential
	credentialed bool
	swapped      bool // credential changed; not yet used by a request
}

func (b *binding) info() bindingInfo {
	return bindingInfo{Caller: b.caller, SessionKey: b.sessionKey, Mode: b.cred.mode(), Profile: b.cred.profileName(), Key: b.cred.key}
}

// sender delivers proxy → binder frames without blocking (control.go).
type sender interface{ send(v any) }

type Bindings struct {
	profiles *profiles
	out      sender
	dirty    func() // the table's persisted shape changed
	now      func() time.Time
	// synced: the binder has re-sent every bind since this start. Until then
	// a caller without a binding may only be one whose bind is on its way.
	synced atomic.Bool

	mu      sync.Mutex
	m       map[string]*binding
	changed chan struct{} // closed and replaced on every change: wakes held requests
}

func NewBindings(ps *profiles, out sender, dirty func()) *Bindings {
	if dirty == nil {
		dirty = func() {}
	}
	return &Bindings{profiles: ps, m: map[string]*binding{}, changed: make(chan struct{}), out: out, dirty: dirty, now: time.Now}
}

// broadcastLocked wakes every held request; callers hold mu.
func (s *Bindings) broadcastLocked() {
	close(s.changed)
	s.changed = make(chan struct{})
}

// Restore loads the persisted table at start: every entry known, none credentialed.
func (s *Bindings) Restore(entries []bindingInfo) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range entries {
		refuse := e.Mode == modeRefuse
		prof := s.profiles.get(e.Profile)
		if !isID(e.Caller) || e.SessionKey == "" || (prof == nil) != refuse {
			continue // a profile that is gone: the binder binds the caller again, or not
		}
		s.m[e.Caller] = &binding{caller: e.Caller, sessionKey: e.SessionKey, cred: credential{refuse: refuse, prof: prof, key: e.Key}}
	}
}

// Snapshot is the table without variables, in no particular order.
func (s *Bindings) Snapshot() []bindingInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]bindingInfo, 0, len(s.m))
	for _, b := range s.m {
		out = append(out, b.info())
	}
	return out
}

func (s *Bindings) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.m)
}

// Bind applies a `bind` and answers it: `bound`, or `refused` with why.
func (s *Bindings) Bind(m bindMsg) bool {
	c, code, msg := s.credentialOf(m)
	if code != "" {
		s.refuse(m, code, msg)
		return false
	}
	s.mu.Lock()
	b := s.m[m.Caller]
	if b != nil && b.sessionKey != m.SessionKey {
		s.mu.Unlock()
		s.refuse(m, refuseCallerInUse, "the caller is bound to another session")
		return false
	}
	action := "bind"
	switch {
	case b == nil:
		b = &binding{caller: m.Caller, sessionKey: m.SessionKey}
		s.m[m.Caller] = b
	case b.credentialed && b.cred.equal(&c):
		action = "" // the same bind again
	case b.credentialed:
		action = "swap"
		b.swapped = true // the next request is the first on the new credential
	}
	if action != "" {
		reshaped := !b.credentialed || b.cred.refuse != c.refuse || b.cred.key != c.key || b.cred.prof != c.prof
		b.cred, b.credentialed = c, true
		s.broadcastLocked()
		if reshaped {
			s.dirty()
		}
	}
	s.mu.Unlock()

	s.out.send(boundMsg{T: "bound", ID: m.ID, Caller: m.Caller, SessionKey: m.SessionKey, Key: c.key})
	if action != "" {
		s.out.send(s.bindingEvent(action, m.Caller, m.SessionKey, &c))
		logInfo("bound", "caller", m.Caller, "session_key", m.SessionKey, "mode", c.mode(), "profile", c.profileName(), "key", c.key, "action", action)
	}
	return true
}

// credentialOf checks a bind and reads its credential. A refusal's message
// may name a variable, never its value.
func (s *Bindings) credentialOf(m bindMsg) (c credential, code, msg string) {
	switch {
	case !isID(m.Caller):
		return c, refuseBadFrame, "caller must be 1 to 64 of A-Z a-z 0-9 . _ : -"
	case m.SessionKey == "":
		return c, refuseBadFrame, "missing sessionKey"
	case m.Mode == modeRefuse:
		return credential{refuse: true, reason: m.Reason}, "", ""
	case m.Mode != "":
		return c, refuseBadFrame, "unknown mode"
	}
	c = credential{prof: s.profiles.get(m.Profile), key: m.Key}
	switch {
	case c.prof == nil:
		return c, refuseUnknownProfile, "no such profile"
	case !isID(m.Key):
		return c, refuseBadKey, "key must be 1 to 64 of A-Z a-z 0-9 . _ : -"
	}
	c.vars = make(map[string]string, len(c.prof.vars))
	for _, v := range c.prof.vars { // only what the profile uses is kept
		val := m.Vars[v]
		switch {
		case val == "":
			return c, refuseMissingVar, "missing " + v
		case !validHeaderValue(val):
			return c, refuseMissingVar, v + " is not a header value"
		}
		c.vars[v] = val
	}
	return c, "", ""
}

func (s *Bindings) refuse(m bindMsg, code, msg string) {
	caller := truncate(m.Caller, 64)
	logWarn("bind refused", "caller", caller, "session_key", m.SessionKey, "code", code, "message", msg)
	s.out.send(refusedMsg{T: "refused", ID: m.ID, Caller: caller, Code: code, Message: msg})
	e := newEvent(s.now(), "model.binding")
	e.SessionKey, e.Outcome = m.SessionKey, "failed"
	e.Data = map[string]any{"action": "refused", "caller": caller, "code": code}
	s.out.send(e)
}

// bindingEvent is the model.binding telemetry event for a bind, swap or release.
func (s *Bindings) bindingEvent(action, caller, sessionKey string, c *credential) eventMsg {
	e := newEvent(s.now(), "model.binding")
	e.SessionKey, e.Profile, e.Outcome = sessionKey, c.profileName(), "completed"
	e.Data = map[string]any{"action": action, "caller": caller, "mode": c.mode()}
	if c.key != "" {
		e.Data["key"] = c.key
	}
	return e
}

// Release drops a caller's binding. Streams already in flight finish on the
// credential they started with.
func (s *Bindings) Release(caller string) {
	s.mu.Lock()
	b := s.m[caller]
	if b == nil {
		s.mu.Unlock()
		return
	}
	delete(s.m, caller)
	s.broadcastLocked()
	s.mu.Unlock()
	s.dirty()
	s.out.send(s.bindingEvent("release", caller, b.sessionKey, &b.cred))
	logInfo("released", "caller", caller, "session_key", b.sessionKey)
}

// Synced notes the binder's `synced`: every bind it has is here. Nothing is
// dropped (only `release` removes a binding) and nothing stops holding (a
// bind may still come a moment later); from now on a caller that stays
// without a binding is unknown (401), not early (503). Returns how many
// known callers still have no credential.
func (s *Bindings) Synced() (waiting int) {
	s.synced.Store(true)
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, b := range s.m {
		if !b.credentialed {
			waiting++
		}
	}
	return waiting
}

// isID: a caller or a key, 1 to 64 of A-Z a-z 0-9 . _ : -
func isID(s string) bool { return isName(s, "._:-") }
