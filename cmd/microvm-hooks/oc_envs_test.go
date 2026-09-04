package main

import (
	"os"
	"strings"
	"testing"
)

// oc_envs_test.go — the layering, which is where this goes wrong silently.
//
// A sandbox env that never reaches a command is the bug this closed. An env
// that REPLACES the guest's own environment is the bug introduced by fixing it
// carelessly: drop PATH and every command naming a binary rather than a path
// stops resolving, which looks like a broken image rather than a broken env.

func setSandboxEnvs(m map[string]string) {
	sandboxEnvs.mu.Lock()
	sandboxEnvs.m = m
	sandboxEnvs.mu.Unlock()
}

func envValue(env []string, key string) (string, bool) {
	// Later entries win in execve, so the LAST match is the effective one —
	// which is the whole mechanism the precedence below relies on.
	val, found := "", false
	for _, e := range env {
		if strings.HasPrefix(e, key+"=") {
			val, found = strings.TrimPrefix(e, key+"="), true
		}
	}
	return val, found
}

// Even with nothing set, the environment must state the sandbox user's
// identity. os.Environ() belongs to ROOT — this process is PID 1 — and commands
// run as uid 1000, so inheriting it verbatim tells the customer's shell that
// HOME is /root: a directory they cannot write, and one `cd ~` lands in.
func TestBuildEnvAlwaysStampsTheSandboxIdentity(t *testing.T) {
	setSandboxEnvs(nil)
	env := buildEnv(nil)
	if env == nil {
		t.Fatal("buildEnv returned nil — the command would inherit root's HOME=/root")
	}
	if v, _ := envValue(env, "HOME"); v != sandboxHomeDir {
		t.Errorf("HOME = %q, want %q", v, sandboxHomeDir)
	}
	for _, k := range []string{"USER", "LOGNAME"} {
		if v, _ := envValue(env, k); v != sandboxUserName {
			t.Errorf("%s = %q, want %q", k, v, sandboxUserName)
		}
	}
}

// The identity must survive both other layers, or a customer setting an
// unrelated variable would silently get root's home back.
func TestSandboxIdentitySurvivesOtherEnvLayers(t *testing.T) {
	setSandboxEnvs(map[string]string{"APP": "x"})
	env := buildEnv(map[string]string{"REQ": "y"})
	if v, _ := envValue(env, "HOME"); v != sandboxHomeDir {
		t.Errorf("HOME = %q, want %q", v, sandboxHomeDir)
	}
}

// The guest's own environment survives. Without this, PATH is gone.
func TestBuildEnvKeepsTheGuestEnvironment(t *testing.T) {
	t.Setenv("OC_TEST_GUEST_VAR", "from-guest")
	setSandboxEnvs(map[string]string{"SANDBOX_VAR": "from-sandbox"})

	env := buildEnv(nil)
	if v, ok := envValue(env, "OC_TEST_GUEST_VAR"); !ok || v != "from-guest" {
		t.Error("the guest's environment was replaced — PATH and HOME would be gone and every bare command name would stop resolving")
	}
	if v, ok := envValue(env, "SANDBOX_VAR"); !ok || v != "from-sandbox" {
		t.Errorf("SANDBOX_VAR = %q, want it applied to every command", v)
	}
}

// A create's envs reach a command that specifies none of its own. This is the
// case that silently did nothing before.
func TestSandboxEnvsReachACommandWithNoOwnEnv(t *testing.T) {
	setSandboxEnvs(map[string]string{"API_KEY": "sk-123"})
	if v, ok := envValue(buildEnv(nil), "API_KEY"); !ok || v != "sk-123" {
		t.Fatalf("API_KEY = %q, ok=%v — create({envs}) would return 200 and the program would see an unset variable", v, ok)
	}
}

// Per-exec wins, so one command can override without changing the sandbox.
func TestPerExecEnvOverridesTheSandboxEnv(t *testing.T) {
	setSandboxEnvs(map[string]string{"MODE": "production"})
	env := buildEnv(map[string]string{"MODE": "debug"})
	if v, _ := envValue(env, "MODE"); v != "debug" {
		t.Errorf("MODE = %q, want the per-exec value to win", v)
	}
}

// And a per-exec env still works with no sandbox env set — the pre-existing
// behaviour, which must not regress.
func TestPerExecEnvAloneStillWorks(t *testing.T) {
	setSandboxEnvs(nil)
	env := buildEnv(map[string]string{"ONLY": "here"})
	if v, ok := envValue(env, "ONLY"); !ok || v != "here" {
		t.Errorf("ONLY = %q", v)
	}
	if _, ok := envValue(env, "PATH"); !ok && os.Getenv("PATH") != "" {
		t.Error("PATH missing from a per-exec-only environment")
	}
}

// Replacing rather than merging: omitting a key clears it, so a caller can
// unset a variable.
func TestSetEnvsReplacesRatherThanMerges(t *testing.T) {
	setSandboxEnvs(map[string]string{"OLD": "1"})
	setSandboxEnvs(map[string]string{"NEW": "2"})
	env := buildEnv(nil)
	if _, ok := envValue(env, "OLD"); ok {
		t.Error("a replaced environment kept a key the caller omitted — there would be no way to unset one")
	}
	if v, _ := envValue(env, "NEW"); v != "2" {
		t.Errorf("NEW = %q", v)
	}
}

// The snapshot is a copy: a command building its environment must not be able
// to mutate the sandbox's.
func TestSnapshotIsACopy(t *testing.T) {
	setSandboxEnvs(map[string]string{"K": "v"})
	snap := envsSnapshot()
	snap["K"] = "mutated"
	if v, _ := envValue(buildEnv(nil), "K"); v != "v" {
		t.Errorf("K = %q — the snapshot aliased the shared map", v)
	}
	setSandboxEnvs(nil)
}
