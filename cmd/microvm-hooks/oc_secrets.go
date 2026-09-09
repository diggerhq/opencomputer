package main

// oc_secrets.go — the secret store, running inside the guest.
//
// On the QEMU fleet the secrets proxy runs on the WORKER. The sandbox is given
// placeholder tokens (`osb_sealed_…`), its egress is MITM'd through a CONNECT
// proxy with its own CA, and the real value is substituted into the request
// only for hosts that particular secret is allowed to reach. The plaintext
// never enters the VM.
//
// There is no worker here, so the proxy moves into the guest — as root, in this
// process, while the customer's code runs as the unprivileged `sandbox` user.
// The alternative considered and rejected was a shared in-region service: it
// would be a single high-value target holding every customer's secrets and a
// SPOF on everyone's egress, and we would be building it precisely because we
// removed the worker that made it unnecessary.
//
// TWO PROPERTIES CARRY THIS DESIGN.
//
//	Bypass is fail-closed.  The guest only ever holds placeholders. A customer
//	                        who ignores HTTPS_PROXY and dials the upstream
//	                        directly sends a worthless osb_sealed_… string. So
//	                        egress does not have to be FORCED through the proxy
//	                        — no iptables, no fighting the customer's network.
//
//	Substitution is        Session.TokenHosts means a token is substituted only
//	host-scoped.           for the hosts that secret is for. Sending it to a
//	                       server the customer controls yields the placeholder.
//
// WHERE THIS IS WEAKER THAN QEMU, stated plainly because it is a real
// reduction: the secret lives in this process's memory rather than on a
// separate machine. `sandbox` cannot read root's memory, but a privilege
// escalation inside the guest reaches the secrets, where on QEMU it would not.

import (
	"log"
	"net/http"
	"os"
	"sync"

	"github.com/opensandbox/opensandbox/internal/secretsproxy"
)

const (
	ocSecretsPath       = ocPrefix + "secrets"
	ocSecretsUpdatePath = ocPrefix + "secrets/update"

	// secretsProxyAddr is loopback-only. Nothing outside the box could reach it
	// anyway — Lambda's proxy forwards solely to the hook port — but binding
	// narrowly is what makes that a property of this process rather than an
	// accident of the platform.
	secretsProxyAddr = "127.0.0.1:3128"

	// secretsProxyEndpoint is what the sandbox is told to use. The worker fleet
	// uses an anycast link-local address; that address is nobody in here.
	secretsProxyEndpoint = "http://" + secretsProxyAddr

	// caDir holds the generated CA.
	//
	// DELIBERATELY NOT UNDER /home/sandbox. That directory is what
	// /oc/workspace/export archives, so a CA key kept there would be uploaded
	// to blob storage inside every checkpoint the customer takes — and restored
	// into every fork of it.
	caDir = "/var/lib/opencomputer/ca"

	// guestCACertPath is where the sandbox's TLS libraries look. The env vars
	// CreateSealedEnvs returns name this exact path.
	guestCACertPath = "/usr/local/share/ca-certificates/opensandbox-proxy.crt"
)

// secrets holds the lazily-started proxy.
//
// LAZY, NOT STARTED AT BOOT, and the reason is the snapshot: this process
// starts during the image BUILD and every box resumes from that moment, so a CA
// generated at startup would be the SAME KEY in every box we ever run.
// Generating on first use puts it after /resume, which makes it per-box.
//
// It also means a sandbox with no secrets never generates a key, never listens,
// and never pays for any of this.
var secrets struct {
	mu    sync.Mutex
	proxy *secretsproxy.SecretsProxy
}

// secretsProxy returns the running proxy, starting it if this is the first use.
func secretsProxy() (*secretsproxy.SecretsProxy, error) {
	secrets.mu.Lock()
	defer secrets.mu.Unlock()
	if secrets.proxy != nil {
		return secrets.proxy, nil
	}

	ca, err := secretsproxy.LoadOrCreateCA(caDir)
	if err != nil {
		return nil, err
	}
	p, err := secretsproxy.NewSecretsProxy(ca, secretsProxyAddr)
	if err != nil {
		return nil, err
	}
	// Point the sandbox at loopback rather than the workers' anycast address.
	p.SetEndpoint(secretsProxyEndpoint)
	p.Start()

	// The CA the sandbox has to trust. Written as a plain file: the env vars
	// below name this path directly and the consuming libraries read it, so no
	// update-ca-certificates run is needed (same as the QEMU path).
	if err := os.MkdirAll("/usr/local/share/ca-certificates", 0o755); err != nil {
		log.Printf("microvm-hooks: secrets: mkdir ca dir: %v", err)
	}
	if err := os.WriteFile(guestCACertPath, ca.CertPEM(), 0o644); err != nil {
		_ = p.Stop()
		return nil, err
	}

	secrets.proxy = p
	log.Printf("microvm-hooks: secrets proxy listening on %s", secretsProxyAddr)
	return p, nil
}

// secretsRequest mirrors CreateSealedEnvs' arguments.
//
// The REAL values arrive here — that is the whole point, and it is safe because
// this request crosses only the platform's authenticated channel into a root
// process. What leaves this function toward the customer is sealed.
type secretsRequest struct {
	SandboxID string `json:"sandboxId"`
	// PlaintextEnvs are forwarded unsealed. They came from the caller directly
	// rather than a secret store, and sealing them would break `echo $VAR`,
	// file writes and subprocess env without adding protection.
	PlaintextEnvs map[string]string `json:"envs,omitempty"`
	// SecretEnvs are sealed: the sandbox sees a token, never these values.
	SecretEnvs map[string]string `json:"secretEnvs,omitempty"`
	// Allowlist gates egress entirely. Empty means unrestricted.
	Allowlist []string `json:"allowlist,omitempty"`
	// SecretAllowedHosts scopes each secret to the hosts it may be sent to.
	SecretAllowedHosts map[string][]string `json:"secretAllowedHosts,omitempty"`
}

// ocSetSecrets seals the sandbox's secrets and applies the resulting
// environment.
//
// Replaces /oc/envs for a sandbox that has any, rather than running alongside
// it: the env map returned below ALREADY contains the plaintext envs merged in,
// so a subsequent /oc/envs call would overwrite the sealed values with nothing
// and quietly disable the whole mechanism.
func (s *server) ocSetSecrets(w http.ResponseWriter, r *http.Request) {
	var req secretsRequest
	if !decode(w, r, &req) {
		return
	}

	p, err := secretsProxy()
	if err != nil {
		log.Printf("microvm-hooks: secrets: start proxy: %v", err)
		http.Error(w, "secrets: "+err.Error(), http.StatusInternalServerError)
		return
	}

	// guestIP is the key the proxy looks a session up by, and in here the
	// client is always loopback — there is exactly one sandbox per box, so the
	// per-VM IP keying the worker fleet needs collapses to a constant.
	env := p.CreateSealedEnvs(req.SandboxID, "127.0.0.1", "",
		req.PlaintextEnvs, req.SecretEnvs, req.Allowlist, req.SecretAllowedHosts)
	if env == nil {
		// Nothing to seal and nothing to enforce.
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "sealed": 0})
		return
	}

	applySandboxEnvs(env)

	// The agent runs PTY and exec-session commands, so it needs the same
	// environment or a terminal would see different variables from an exec.
	if err := pushEnvsToAgent(r.Context(), env); err != nil {
		log.Printf("microvm-hooks: secrets: push envs to agent: %v", err)
		http.Error(w, "secrets: agent: "+err.Error(), http.StatusServiceUnavailable)
		return
	}

	log.Printf("microvm-hooks: secrets applied for %s (%d sealed, %d allowlisted hosts)",
		req.SandboxID, len(req.SecretEnvs), len(req.Allowlist))
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "sealed": len(req.SecretEnvs)})
}

// ocUpdateSecret refreshes one secret's value in place.
//
// By NAME, not by token: the sandbox is holding a token it was given at create
// and must keep working, so re-sealing would mean pushing a new environment
// into a process that already read the old one. Session.Names exists for
// exactly this.
func (s *server) ocUpdateSecret(w http.ResponseWriter, r *http.Request) {
	var req struct {
		SandboxID string `json:"sandboxId"`
		Name      string `json:"name"`
		Value     string `json:"value"`
	}
	if !decode(w, r, &req) {
		return
	}

	secrets.mu.Lock()
	p := secrets.proxy
	secrets.mu.Unlock()
	if p == nil {
		// No proxy means no session, which is a miss rather than an error —
		// the same answer the worker path gives for a sandbox with no secrets.
		writeJSON(w, http.StatusOK, map[string]any{"updated": false})
		return
	}

	updated := p.UpdateSecretValue(req.SandboxID, req.Name, req.Value)
	writeJSON(w, http.StatusOK, map[string]any{"updated": updated})
}
