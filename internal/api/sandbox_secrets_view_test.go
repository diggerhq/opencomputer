package api

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/opensandbox/opensandbox/internal/db"
	"github.com/opensandbox/opensandbox/internal/edgeclient"
)

func TestMergeSecretBundleInto_NamesOnlyNoValues(t *testing.T) {
	resp := newAllowedHostsResponse("sb-1")

	base := &edgeclient.SecretStoreBundle{
		Store: db.SecretStore{Name: "base", EgressAllowlist: []string{"api.openai.com"}},
		Entries: []db.DecryptedSecret{
			{Name: "OPENAI_API_KEY", Value: "sk-base-secret"},
			{Name: "SHARED", Value: "base-shared", AllowedHosts: []string{"base.example.com"}},
		},
	}
	primary := &edgeclient.SecretStoreBundle{
		Store: db.SecretStore{Name: "primary", EgressAllowlist: []string{"api.anthropic.com", "api.openai.com"}},
		Entries: []db.DecryptedSecret{
			{Name: "ANTHROPIC_API_KEY", Value: "sk-ant-secret", AllowedHosts: []string{"api.anthropic.com"}},
			{Name: "SHARED", Value: "primary-shared", AllowedHosts: []string{"primary.example.com"}},
		},
	}
	mergeSecretBundleInto(base, resp)
	mergeSecretBundleInto(primary, resp)

	wantNames := []string{"ANTHROPIC_API_KEY", "OPENAI_API_KEY", "SHARED"}
	if !reflect.DeepEqual(resp.SecretEnvNames, wantNames) {
		t.Fatalf("SecretEnvNames = %v, want %v", resp.SecretEnvNames, wantNames)
	}
	wantEgress := []string{"api.openai.com", "api.anthropic.com"}
	if !reflect.DeepEqual(resp.EgressAllowlist, wantEgress) {
		t.Fatalf("EgressAllowlist = %v, want %v", resp.EgressAllowlist, wantEgress)
	}
	if got := resp.PerSecretAllowedHosts["SHARED"]; !reflect.DeepEqual(got, []string{"primary.example.com"}) {
		t.Fatalf("primary store should shadow base per-secret hosts, got %v", got)
	}
	if _, has := resp.PerSecretAllowedHosts["OPENAI_API_KEY"]; has {
		t.Fatalf("entries without AllowedHosts must not appear in PerSecretAllowedHosts")
	}

	raw, err := json.Marshal(resp)
	if err != nil {
		t.Fatal(err)
	}
	for _, leak := range []string{"sk-base-secret", "sk-ant-secret", "base-shared", "primary-shared"} {
		if strings.Contains(string(raw), leak) {
			t.Fatalf("response leaked secret value %q: %s", leak, raw)
		}
	}
}

func TestNewAllowedHostsResponse_EmptyShape(t *testing.T) {
	raw, err := json.Marshal(newAllowedHostsResponse("sb-2"))
	if err != nil {
		t.Fatal(err)
	}
	want := `{"sandboxID":"sb-2","secretEnvNames":[],"egressAllowlist":[],"perSecretAllowedHosts":{}}`
	if string(raw) != want {
		t.Fatalf("got %s, want %s", raw, want)
	}
}

func TestRedactDashboardConfig(t *testing.T) {
	cfg := map[string]interface{}{
		"timeout": float64(300),
		"envs": map[string]interface{}{
			"ZED":   "z-value",
			"ALPHA": "a-value",
		},
	}
	out := redactDashboardConfig(cfg)
	if _, has := out["envs"]; has {
		t.Fatalf("envs values must be stripped: %v", out)
	}
	if !reflect.DeepEqual(out["envNames"], []string{"ALPHA", "ZED"}) {
		t.Fatalf("envNames = %v", out["envNames"])
	}
	if out["timeout"] != float64(300) {
		t.Fatalf("unrelated keys must be preserved")
	}

	noEnvs := redactDashboardConfig(map[string]interface{}{"cpuCount": float64(1)})
	if _, has := noEnvs["envNames"]; has {
		t.Fatalf("envNames must be absent when config has no envs")
	}
}
