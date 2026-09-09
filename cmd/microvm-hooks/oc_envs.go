package main

// oc_envs.go — sandbox-level environment variables.
//
// A create can carry `envs`, and on the QEMU fleet those are set once and seen
// by everything the sandbox subsequently runs. On this runtime they were
// silently DROPPED: the backend's Claim passed only template and size to the
// manager, so `create({envs})` returned 200 and did nothing. No error, no log —
// the customer's program just saw an unset variable.
//
// SET IN TWO PLACES, and it has to be both, which is the part that is easy to
// get wrong. Commands reach the guest by two different routes:
//
//	/oc/run          runCmd builds the process HERE, in this process. The
//	                 agent's own env map is invisible to it.
//	PTY, sessions    go through the agent, which applies its sandboxEnvs.
//
// Setting only the agent's would leave plain exec — the overwhelmingly common
// case — without them. Setting only ours would leave terminals without them.
// Both, or the sandbox's environment depends on how you happen to run a
// command, which is the kind of inconsistency that costs an afternoon to
// diagnose.

import (
	"context"
	"log"
	"net/http"
	"os"
	"sync"

	pb "github.com/opensandbox/opensandbox/proto/agent"
)

const (
	ocEnvsPath = ocPrefix + "envs"

	// The identity customer commands run as. Matches internal/agent/exec.go —
	// the two run commands in the same sandbox and must agree about who owns
	// the files they create.
	sandboxUID      = 1000
	sandboxGID      = 1000
	sandboxUserName = "sandbox"
	sandboxHomeDir  = "/home/sandbox"
)

// sandboxEnvs is the environment applied to everything this process runs.
//
// Guarded because it is written by a create and read by every exec, and those
// race by construction — a create returns as soon as the sandbox is usable, and
// nothing stops the customer's first command arriving while the write is still
// in flight.
var sandboxEnvs struct {
	mu sync.RWMutex
	m  map[string]string
}

// envsSnapshot returns a copy for merging into one command.
func envsSnapshot() map[string]string {
	sandboxEnvs.mu.RLock()
	defer sandboxEnvs.mu.RUnlock()
	if len(sandboxEnvs.m) == 0 {
		return nil
	}
	out := make(map[string]string, len(sandboxEnvs.m))
	for k, v := range sandboxEnvs.m {
		out[k] = v
	}
	return out
}

// buildEnv resolves the environment for one command.
//
// Three layers, and the order is the contract: the guest's own environment
// first (PATH, HOME — replacing rather than extending it would stop every
// command that names a binary instead of a path from resolving), then the
// sandbox's, then the request's. Per-exec envs win, so a caller can override a
// sandbox-level value for one command without changing it for the sandbox.
//
// Never returns nil: even with no envs set at all, the sandbox user's identity
// has to be stamped over root's.
func buildEnv(reqEnv map[string]string) []string {
	sandbox := envsSnapshot()
	env := os.Environ()
	// os.Environ() is ROOT's — this process is PID 1. Commands run as the
	// sandbox user (see runCmd), so the identity has to be restated or the
	// customer's shell is told HOME=/root, which it cannot write, and `cd ~`
	// lands somewhere they have no access to. The agent does the same thing
	// for the same reason (internal/agent/exec.go).
	env = append(env,
		"HOME="+sandboxHomeDir,
		"USER="+sandboxUserName,
		"LOGNAME="+sandboxUserName,
	)
	for k, v := range sandbox {
		env = append(env, k+"="+v)
	}
	// Appended after the sandbox's, and later entries win in execve, so a
	// per-request value overrides a sandbox-level one of the same name.
	for k, v := range reqEnv {
		env = append(env, k+"="+v)
	}
	return env
}

// applySandboxEnvs records the environment this process applies to /oc/run.
//
// Idempotent and total: it REPLACES whatever was there rather than merging, so
// a caller can clear a variable by omitting it.
func applySandboxEnvs(m map[string]string) {
	sandboxEnvs.mu.Lock()
	sandboxEnvs.m = m
	sandboxEnvs.mu.Unlock()
}

// pushEnvsToAgent gives the agent the same environment, for the paths that run
// commands through it rather than through runCmd.
func pushEnvsToAgent(ctx context.Context, m map[string]string) error {
	c, err := agentClient()
	if err != nil {
		return err
	}
	_, err = c.SetEnvs(ctx, &pb.SetEnvsRequest{Envs: m})
	return err
}

// reapplyEnvsToAgent re-pushes the current environment after the agent has been
// restarted.
//
// /oc/reboot kills the agent and starts a new one, and a new agent has an EMPTY
// env map. This process keeps its own copy, so /oc/run commands were unaffected
// — but PTY and exec sessions go through the agent and would silently lose
// every sandbox variable. The environment would then depend on HOW a command
// was run, which is the kind of inconsistency that costs an afternoon.
func reapplyEnvsToAgent(ctx context.Context) {
	m := envsSnapshot()
	if len(m) == 0 {
		return
	}
	if err := pushEnvsToAgent(ctx, m); err != nil {
		log.Printf("microvm-hooks: WARNING re-applying %d env(s) to the restarted agent failed: %v — "+
			"terminals and exec sessions will not see them", len(m), err)
		return
	}
	log.Printf("microvm-hooks: re-applied %d env(s) to the restarted agent", len(m))
}

// ocSetEnvs records the sandbox's environment.
//
// A create sets this once. A sandbox WITH secrets goes through /oc/secrets
// instead, which produces its environment by sealing — see oc_secrets.go.
func (s *server) ocSetEnvs(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Envs map[string]string `json:"envs"`
	}
	if !decode(w, r, &req) {
		return
	}

	applySandboxEnvs(req.Envs)

	// Failure is reported rather than swallowed: a sandbox whose terminals see
	// a different environment from its execs is worse than one that failed to
	// start, because it works until it doesn't.
	withAgent(w, "envs", func(c pb.SandboxAgentClient) error {
		if _, err := c.SetEnvs(r.Context(), &pb.SetEnvsRequest{Envs: req.Envs}); err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "count": len(req.Envs)})
		return nil
	})
}
