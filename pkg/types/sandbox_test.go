package types

import "testing"

func TestNetworkPolicyValidate(t *testing.T) {
	t.Parallel()

	for _, policy := range []NetworkPolicy{NetworkPolicyNone, NetworkPolicyPublic} {
		if err := policy.Validate(); err != nil {
			t.Errorf("Validate(%q): %v", policy, err)
		}
	}
	if err := NetworkPolicy("private").Validate(); err == nil {
		t.Fatal("unsupported network policy unexpectedly validated")
	}
}
