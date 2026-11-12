package main

import (
	"context"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
)

// A host from before profiles binds in its own terms (mode, provider, token,
// accountId, fingerprint). With -default-profile the proxy reads them, and
// answers in them too; requests are served as for any binding.
func TestPreProfileHost(t *testing.T) {
	var mHits, aHits atomic.Int64
	got, gotAlt := make(chan seen, 1), make(chan seen, 1)
	h := newHarness(t, recordingUpstream(&mHits, got), harnessOpts{alt: recordingUpstream(&aHits, gotAlt), defaultProfile: mainProfile,
		restore: []persisted{{Unit: "sp-runner-old001.service", SessionKey: "s0", Mode: modeLegacy, Fingerprint: "fp0", Provider: altProfile}}})
	k := h.dialControl()
	hello := <-k.msgs
	if b := hello["bindings"].([]any)[0].(map[string]any); b["profile"] != altProfile || b["key"] != "fp0" || b["fingerprint"] != "fp0" || b["provider"] != altProfile {
		t.Fatalf("hello binding %v", b)
	}

	k.send(map[string]any{"t": "bind", "unit": testUnit, "sessionKey": "s1", "mode": modeLegacy, "token": "tokA", "fingerprint": "fpA"})
	b := k.waitFor(isT("bound"))
	if b["mode"] != modeLegacy || b["fingerprint"] != "fpA" || b["provider"] != nil || b["profile"] != mainProfile || b["key"] != "fpA" {
		t.Fatalf("bound %v", b)
	}
	if st := doReq(t, h, testUnit, h.messagesReq(context.Background())); st != 200 {
		t.Fatalf("status %d", st)
	}
	if s := <-got; s.header.Get("Authorization") != "Bearer tokA" {
		t.Fatalf("upstream saw %v", s.header)
	}

	k.send(map[string]any{"t": "bind", "unit": altUnit, "sessionKey": "s2", "mode": modeLegacy, "provider": altProfile, "token": "tokC", "accountId": altAccount, "fingerprint": "fpC"})
	b = k.waitFor(isT("bound"))
	if b["mode"] != modeLegacy || b["fingerprint"] != "fpC" || b["provider"] != altProfile || b["profile"] != altProfile {
		t.Fatalf("bound %v", b)
	}
	if st := doReq(t, h, altUnit, h.responsesReq(context.Background())); st != 200 {
		t.Fatalf("status %d", st)
	}
	if s := <-gotAlt; s.header.Get("Authorization") != "Bearer tokC" || s.header.Get("X-Account") != altAccount {
		t.Fatalf("upstream saw %v", s.header)
	}

	k.send(map[string]any{"t": "bind", "unit": "sp-runner-ref001.service", "sessionKey": "s3", "mode": "refuse", "reason": "no"})
	if b := k.waitFor(isT("bound")); b["mode"] != "refuse" || b["fingerprint"] != nil {
		t.Fatalf("bound %v", b)
	}

	// The next connection's hello names every binding both ways; the default
	// profile's has no `provider`, as such a host expects.
	k2 := h.dialControl()
	hello = <-k2.msgs
	byUnit := map[string]map[string]any{}
	for _, b := range hello["bindings"].([]any) {
		b := b.(map[string]any)
		byUnit[b["unit"].(string)] = b
	}
	if b := byUnit[testUnit]; b["profile"] != mainProfile || b["fingerprint"] != "fpA" || b["provider"] != nil {
		t.Fatalf("hello binding %v", b)
	}
	if b := byUnit[altUnit]; b["profile"] != altProfile || b["fingerprint"] != "fpC" || b["provider"] != altProfile {
		t.Fatalf("hello binding %v", b)
	}
}

// Without -default-profile a bind must name its profile; a bind in the new
// terms never gets the old ones back.
func TestProfileRequiredWithoutDefault(t *testing.T) {
	h := newHarness(t, recordingUpstream(new(atomic.Int64), nil), harnessOpts{})
	k := h.dialControl()
	k.send(map[string]any{"t": "bind", "unit": testUnit, "sessionKey": "s1", "mode": modeLegacy, "token": "tokA", "fingerprint": "fpA"})
	if m := k.waitFor(isT("refused")); m["reason"] != "unknown profile" {
		t.Fatalf("refused %v", m)
	}
	k.send(map[string]any{"t": "bind", "unit": testUnit, "sessionKey": "s1", "profile": mainProfile, "mode": "other", "vars": map[string]string{"token": "t"}})
	if m := k.waitFor(isT("refused")); m["reason"] != "unknown mode" {
		t.Fatalf("refused %v", m)
	}
	k.bind(testUnit, "s1", "tokA", "fpA")
	if b := k.waitFor(isT("bound")); b["mode"] != nil || b["fingerprint"] != nil || b["provider"] != nil || b["key"] != "fpA" {
		t.Fatalf("bound %v", b)
	}
}

// Bindings files from before profiles load: version 1 (no provider) as
// -default-profile, version 2 by its provider; an entry whose profile is
// not loaded is dropped. What is written back is version 3.
func TestBindingsFileVersions(t *testing.T) {
	ps, err := loadProfiles("profiles")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		file, def string
		want      map[string]string // unit → profile/key/mode
	}{
		{`{"version":1,"bindings":[{"unit":"sp-runner-a.service","sessionKey":"s1","mode":"subscription","fingerprint":"f1"},
			{"unit":"sp-runner-b.service","sessionKey":"s2","mode":"refuse"}]}`, "claude-oauth",
			map[string]string{"sp-runner-a.service": "claude-oauth/f1/", "sp-runner-b.service": "claude-oauth//refuse"}},
		{`{"version":2,"bindings":[{"unit":"sp-runner-a.service","sessionKey":"s1","mode":"subscription","fingerprint":"f1","provider":"openai-key"},
			{"unit":"sp-runner-b.service","sessionKey":"s2","mode":"subscription","fingerprint":"f2"},
			{"unit":"sp-runner-c.service","sessionKey":"s3","mode":"subscription","fingerprint":"f3","provider":"gone"},
			{"unit":"not-a-runner","sessionKey":"s4","provider":"openai-key"}]}`, "claude-oauth",
			map[string]string{"sp-runner-a.service": "openai-key/f1/", "sp-runner-b.service": "claude-oauth/f2/"}},
		{`{"version":1,"bindings":[{"unit":"sp-runner-a.service","sessionKey":"s1","mode":"subscription","fingerprint":"f1"},
			{"unit":"sp-runner-b.service","sessionKey":"s2","mode":"refuse"}]}`, "",
			map[string]string{"sp-runner-b.service": "//refuse"}},
		{`{"version":3,"bindings":[{"unit":"sp-runner-a.service","sessionKey":"s1","profile":"openrouter","key":"k1"}]}`, "",
			map[string]string{"sp-runner-a.service": "openrouter/k1/"}},
		{`{"version":9,"bindings":[{"unit":"sp-runner-a.service","sessionKey":"s1","profile":"openrouter","key":"k1","later":true}]}`, "",
			map[string]string{"sp-runner-a.service": "openrouter/k1/"}},
	} {
		path := filepath.Join(t.TempDir(), "bindings.json")
		if err := os.WriteFile(path, []byte(c.file), 0o600); err != nil {
			t.Fatal(err)
		}
		entries, err := loadBindings(path)
		if err != nil {
			t.Fatal(err)
		}
		b := NewBindings(ps, c.def, &sink{}, nil)
		b.Restore(entries)
		snap := b.Snapshot()
		got := map[string]string{}
		for _, e := range snap {
			got[e.Unit] = e.Profile + "/" + e.Key + "/" + e.Mode
			if e.Fingerprint != "" || e.Provider != "" {
				t.Errorf("an old name written back: %+v", e)
			}
		}
		if len(got) != len(c.want) {
			t.Errorf("%s: got %v", c.file, got)
		}
		for u, w := range c.want {
			if got[u] != w {
				t.Errorf("%s: %s = %q, want %q", c.file, u, got[u], w)
			}
		}
		if err := writeBindings(path, snap); err != nil {
			t.Fatal(err)
		}
		raw, _ := os.ReadFile(path)
		if string(raw[:len(`{"version":3,`)]) != `{"version":3,` {
			t.Errorf("written %s", raw)
		}
	}
}

func TestFlags(t *testing.T) {
	cfg, ver, err := parseFlags(nil)
	if err != nil || ver || cfg.profilesDir != "/etc/oc-modelproxy/profiles.d" || cfg.identity != "cgroup" || cfg.placeholder != "ssh-placeholder" || cfg.defaultProfile != "" {
		t.Fatalf("defaults %+v %v", cfg, err)
	}
	cfg, _, err = parseFlags([]string{"-profiles", "/p", "-identity", "single", "-default-profile", "a", "-placeholder", "x"})
	if err != nil || cfg.profilesDir != "/p" || cfg.identity != "single" || cfg.defaultProfile != "a" || cfg.placeholder != "x" {
		t.Fatalf("flags %+v %v", cfg, err)
	}
	ps, err := loadProfiles("profiles")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := newServer(config{defaultProfile: "nope"}, ps, singleResolver); err == nil {
		t.Fatal("an unknown -default-profile was accepted")
	}
	if err := run(config{profilesDir: "profiles", identity: "other"}); err == nil {
		t.Fatal("an unknown -identity was accepted")
	}
	if singleResolver(nil) != singleUnit || !isRunnerUnit(singleUnit) {
		t.Fatal("the single unit is not a runner unit")
	}
}
