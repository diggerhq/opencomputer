package secretsproxy

import (
	"strings"
	"testing"
)

// endpoint_test.go — the worker fleet must not notice the override.
//
// SetEndpoint exists for a proxy that does not run on a worker (the MicroVM
// backend runs one inside the guest). Every worker leaves it unset, and if the
// default ever stopped being the anycast address their sandboxes would be
// pointed somewhere nothing answers — which surfaces as every outbound HTTPS
// request timing out, on the whole fleet, with no error anywhere.

func TestUnsetEndpointIsTheAnycastAddress(t *testing.T) {
	p := newProxyForTest(t)
	if got := p.proxyEndpoint(); got != AnycastEndpoint() {
		t.Fatalf("proxyEndpoint() = %q, want %q — the whole QEMU fleet reads this", got, AnycastEndpoint())
	}

	env := p.CreateSealedEnvs("sbx", "10.0.0.2", "10.0.0.1", nil,
		map[string]string{"K": "v"}, nil, nil)
	if env["HTTPS_PROXY"] != AnycastEndpoint() {
		t.Errorf("HTTPS_PROXY = %q, want the anycast address unchanged", env["HTTPS_PROXY"])
	}
	if !strings.Contains(env["HTTPS_PROXY"], AnycastIP) {
		t.Errorf("HTTPS_PROXY lost the anycast IP: %q", env["HTTPS_PROXY"])
	}
}

func TestSetEndpointOverridesOnlyTheProxyURL(t *testing.T) {
	p := newProxyForTest(t)
	p.SetEndpoint("http://127.0.0.1:3128")

	env := p.CreateSealedEnvs("sbx", "127.0.0.1", "", nil,
		map[string]string{"K": "v"}, nil, nil)
	if env["HTTPS_PROXY"] != "http://127.0.0.1:3128" {
		t.Errorf("HTTPS_PROXY = %q, want the override", env["HTTPS_PROXY"])
	}
	// Everything else about the recipe is unchanged — only the address moves.
	if env["NO_PROXY"] == "" || env["SSL_CERT_FILE"] == "" {
		t.Error("the override changed more than the proxy address")
	}
	if !strings.HasPrefix(env["K"], "osb_sealed_") {
		t.Error("the override affected sealing")
	}
}
