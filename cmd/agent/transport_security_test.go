package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestIsTrustedAgentVsockPeerAllowsOnlyHost(t *testing.T) {
	for _, test := range []struct {
		name    string
		cid     uint32
		trusted bool
	}{
		{name: "local transport", cid: 1, trusted: false},
		{name: "host", cid: 2, trusted: true},
		{name: "guest transport", cid: 3, trusted: false},
		{name: "wildcard", cid: ^uint32(0), trusted: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := isTrustedAgentVsockPeer(test.cid); got != test.trusted {
				t.Fatalf("isTrustedAgentVsockPeer(%d) = %v, want %v", test.cid, got, test.trusted)
			}
		})
	}
}

func TestRestrictAgentEndpointRemovesGuestAccess(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent-endpoint")
	if err := os.WriteFile(path, nil, 0666); err != nil {
		t.Fatal(err)
	}
	if err := restrictAgentEndpoint(path); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != agentEndpointMode {
		t.Fatalf("endpoint mode = %#o, want %#o", got, agentEndpointMode)
	}
}
