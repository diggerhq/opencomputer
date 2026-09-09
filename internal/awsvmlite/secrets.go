package awsvmlite

// secrets.go — handing a sandbox its secrets.
//
// The REAL values go to the box. That is the design, not an oversight: the
// substitution has to happen somewhere the sandbox cannot read, and on this
// runtime the only such place is the guest's own root process — there is no
// worker to put it on. See cmd/microvm-hooks/oc_secrets.go for why that beats a
// shared in-region service, and for the honest account of where it is weaker
// than the QEMU fleet.
//
// What crosses this wire is protected the same way every other call to the box
// is: the platform's authenticated proxy, terminating in a root process the
// customer's unprivileged code cannot read. What comes back OUT toward the
// customer is sealed.

import (
	"context"
	"net/http"
	"time"

	"github.com/opensandbox/opensandbox/pkg/types"
)

const (
	ocSecrets       = "/oc/secrets"
	ocSecretsUpdate = "/oc/secrets/update"
)

// secretsPayload mirrors the guest's handler, which in turn mirrors
// secretsproxy.CreateSealedEnvs.
type secretsPayload struct {
	SandboxID          string              `json:"sandboxId"`
	PlaintextEnvs      map[string]string   `json:"envs,omitempty"`
	SecretEnvs         map[string]string   `json:"secretEnvs,omitempty"`
	Allowlist          []string            `json:"allowlist,omitempty"`
	SecretAllowedHosts map[string][]string `json:"secretAllowedHosts,omitempty"`
}

// HasSecrets reports whether a config needs the secrets path at all.
//
// This is the hot-path gate. A create with no secrets — every pooled create the
// benchmark makes — must not pay for any of this, so the caller asks here
// first rather than sending an empty request.
//
// An allowlist with no secrets still counts: it is an egress restriction the
// proxy has to enforce, and skipping it would leave the sandbox unrestricted
// while the API reported the store applied.
func HasSecrets(cfg types.SandboxConfig) bool {
	return len(cfg.SecretEnvs) > 0 || len(cfg.EgressAllowlist) > 0 || len(cfg.SecretAllowedHosts) > 0
}

// SetSecrets seals the sandbox's secrets in the guest and applies the resulting
// environment.
//
// Carries the plaintext envs too, because the guest merges both into ONE
// environment. Sending them separately through SetEnvs afterwards would
// overwrite the sealed values with an environment that has none of them.
func (m *Manager) SetSecrets(ctx context.Context, sandboxID string, cfg types.SandboxConfig) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	return m.call(ctx, sandboxID, http.MethodPost, ocSecrets, secretsPayload{
		SandboxID:          sandboxID,
		PlaintextEnvs:      cfg.Envs,
		SecretEnvs:         cfg.SecretEnvs,
		Allowlist:          cfg.EgressAllowlist,
		SecretAllowedHosts: cfg.SecretAllowedHosts,
	}, nil)
}

// UpdateSecret refreshes one secret's value without re-sealing it.
//
// Reports whether a session and name matched. False is a MISS, not a failure:
// the refresh flow sweeps every sandbox in an org and most of them will not
// hold the secret being rotated.
func (m *Manager) UpdateSecret(ctx context.Context, sandboxID, name, value string) (bool, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	var out struct {
		Updated bool `json:"updated"`
	}
	body := map[string]string{"sandboxId": sandboxID, "name": name, "value": value}
	if err := m.call(ctx, sandboxID, http.MethodPost, ocSecretsUpdate, body, &out); err != nil {
		return false, err
	}
	return out.Updated, nil
}
