package main

import (
	"strings"
	"testing"

	"github.com/opensandbox/opensandbox/internal/secretsproxy"
)

// oc_secrets_test.go — the sealing boundary.
//
// One thing must be true and is not visible from any log or response: the
// environment handed to the sandbox contains NO real secret. If sealing
// silently degrades to passthrough, everything keeps working — the customer's
// code reads the variable, the request succeeds — and the entire protection is
// gone with nothing to notice.

// newGuestProxy builds a proxy configured the way the guest configures one.
func newGuestProxy(t *testing.T) *secretsproxy.SecretsProxy {
	t.Helper()
	ca, err := secretsproxy.LoadOrCreateCA(t.TempDir())
	if err != nil {
		t.Fatalf("ca: %v", err)
	}
	// Port 0: a real listener, but no fight over 3128 in a test run.
	p, err := secretsproxy.NewSecretsProxy(ca, "127.0.0.1:0")
	if err != nil {
		t.Fatalf("proxy: %v", err)
	}
	t.Cleanup(func() { _ = p.Stop() })
	p.SetEndpoint(secretsProxyEndpoint)
	return p
}

// The environment the sandbox boots with must not contain the secret.
func TestSealedEnvNeverCarriesTheRealValue(t *testing.T) {
	p := newGuestProxy(t)
	const real = "sk-live-do-not-leak-me"

	env := p.CreateSealedEnvs("sbx-1", "127.0.0.1", "",
		map[string]string{"PUBLIC": "fine"},
		map[string]string{"API_KEY": real},
		nil, nil)
	if env == nil {
		t.Fatal("no environment produced")
	}

	for k, v := range env {
		if strings.Contains(v, real) {
			t.Fatalf("%s carries the real secret — the sandbox would hold the plaintext and the whole mechanism would be off", k)
		}
	}
	if got := env["API_KEY"]; !strings.HasPrefix(got, "osb_sealed_") {
		t.Errorf("API_KEY = %q, want a sealed placeholder", got)
	}
	// Plaintext envs are deliberately NOT sealed — they never came from a
	// secret store, and sealing them would break echo/file/subprocess use.
	if got := env["PUBLIC"]; got != "fine" {
		t.Errorf("PUBLIC = %q, want it passed through unsealed", got)
	}
}

// The sandbox has to be pointed at the in-guest proxy. The workers' anycast
// address is nobody in here, and getting this wrong means every outbound
// request times out rather than failing loudly.
func TestGuestEnvPointsAtLoopbackNotAnycast(t *testing.T) {
	p := newGuestProxy(t)
	env := p.CreateSealedEnvs("sbx-1", "127.0.0.1", "", nil,
		map[string]string{"K": "v"}, nil, nil)

	for _, key := range []string{"HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"} {
		if env[key] != secretsProxyEndpoint {
			t.Errorf("%s = %q, want %q", key, env[key], secretsProxyEndpoint)
		}
	}
	if strings.Contains(env["HTTPS_PROXY"], "169.254") {
		t.Error("the guest was pointed at the workers' anycast address, which nothing answers in here")
	}
	// All three, because node, python and OpenSSL each read a different one.
	for _, key := range []string{"NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "SSL_CERT_FILE"} {
		if env[key] != guestCACertPath {
			t.Errorf("%s = %q, want %q", key, env[key], guestCACertPath)
		}
	}
}

// A store with only an allowlist still has to register a session, or the proxy
// rejects every CONNECT with 407 and the sandbox has no egress at all.
func TestAllowlistOnlyStoreStillProducesAnEnvironment(t *testing.T) {
	p := newGuestProxy(t)
	env := p.CreateSealedEnvs("sbx-1", "127.0.0.1", "", nil, nil,
		[]string{"api.stripe.com"}, nil)
	if env == nil {
		t.Fatal("an allowlist-only store produced no environment — the sandbox would never be pointed at the proxy and the allowlist would not be enforced")
	}
	if env["HTTPS_PROXY"] != secretsProxyEndpoint {
		t.Errorf("HTTPS_PROXY = %q", env["HTTPS_PROXY"])
	}
}

// A sandbox with nothing to seal and nothing to enforce gets no environment,
// and therefore never starts the proxy.
func TestNoSecretsProducesNoEnvironment(t *testing.T) {
	p := newGuestProxy(t)
	if env := p.CreateSealedEnvs("sbx-1", "127.0.0.1", "", nil, nil, nil, nil); env != nil {
		t.Errorf("got an environment for a sandbox with no secrets: %v", env)
	}
}

// The CA key must not live under the workspace: /oc/workspace/export archives
// that directory, so the key would be uploaded to blob storage inside every
// checkpoint and restored into every fork.
func TestCADirIsOutsideTheArchivedWorkspace(t *testing.T) {
	if strings.HasPrefix(caDir, workspaceDir) {
		t.Fatalf("caDir %q is inside %q — the CA private key would be shipped in every checkpoint", caDir, workspaceDir)
	}
}

// The proxy binds loopback only.
func TestProxyBindsLoopbackOnly(t *testing.T) {
	if !strings.HasPrefix(secretsProxyAddr, "127.0.0.1:") {
		t.Errorf("secretsProxyAddr = %q, want a loopback bind", secretsProxyAddr)
	}
}
