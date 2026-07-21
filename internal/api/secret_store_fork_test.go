package api

import (
	"errors"
	"fmt"
	"reflect"
	"testing"

	"github.com/google/uuid"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// fakeSecretStore is a stand-in for a resolvable secret store in the resolver
// below: its egress and envs are layered into cfg exactly as
// resolveSecretStoreInto would.
type fakeSecretStore struct {
	id     uuid.UUID
	egress []string
	envs   map[string]string
}

func uid(n byte) uuid.UUID {
	var u uuid.UUID
	u[15] = n
	return u
}

// fakeResolver mirrors resolveSecretStoreInto against an in-memory set of
// stores: a present store overwrites cfg.EgressAllowlist and merges its envs
// (later layer wins), a missing store returns ErrSecretStoreNotFound, and a
// name prefixed "ERR-" returns a non-not-found error (transient failure). It
// records the order of names it was asked to resolve.
func fakeResolver(cfg *types.SandboxConfig, existing map[string]fakeSecretStore, calls *[]string) func(string) (*uuid.UUID, error) {
	return func(name string) (*uuid.UUID, error) {
		*calls = append(*calls, name)
		if len(name) >= 4 && name[:4] == "ERR-" {
			return nil, fmt.Errorf("edge lookup secret store %q: boom", name)
		}
		st, ok := existing[name]
		if !ok {
			return nil, fmt.Errorf("%w: %s", ErrSecretStoreNotFound, name)
		}
		cfg.EgressAllowlist = st.egress
		if cfg.SecretEnvs == nil {
			cfg.SecretEnvs = map[string]string{}
		}
		for k, v := range st.envs {
			cfg.SecretEnvs[k] = v
		}
		id := st.id
		return &id, nil
	}
}

// TestLayerSecretStores_ColeRepro is the regression guard for the reported bug:
// a checkpoint whose creation-time store (S1) was deleted must still fork when
// the caller supplies a valid replacement (S2). Before (b), resolving the
// inherited S1 hard-failed the fork; now it is skipped and S2 wins.
func TestLayerSecretStores_ColeRepro(t *testing.T) {
	cfg := &types.SandboxConfig{SecretStore: "S1"} // inherited child = deleted S1
	existing := map[string]fakeSecretStore{
		"S2": {id: uid(2), egress: []string{"*"}, envs: map[string]string{"K": "s2"}},
	}
	var calls []string
	id, err := layerSecretStores(cfg, "", "S1", "S2", fakeResolver(cfg, existing, &calls))
	if err != nil {
		t.Fatalf("fork should succeed with replacement store, got error: %v", err)
	}
	if id == nil || *id != uid(2) {
		t.Fatalf("winning store id = %v, want S2 (%v)", id, uid(2))
	}
	if cfg.SecretStore != "S2" || cfg.BaseSecretStore != "" {
		t.Fatalf("persisted stores = (child %q, base %q), want (S2, \"\") — deleted S1 must not persist",
			cfg.SecretStore, cfg.BaseSecretStore)
	}
	if !reflect.DeepEqual(cfg.EgressAllowlist, []string{"*"}) {
		t.Fatalf("egress = %v, want S2's [\"*\"]", cfg.EgressAllowlist)
	}
	if want := []string{"S1", "S2"}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("resolve order = %v, want %v (S1 attempted then skipped)", calls, want)
	}
}

// TestLayerSecretStores_MissingUserStoreIsHardError proves the intent split: a
// store the CALLER named in the fork request must exist, even though inherited
// stores are now skippable.
func TestLayerSecretStores_MissingUserStoreIsHardError(t *testing.T) {
	cfg := &types.SandboxConfig{}
	var calls []string
	_, err := layerSecretStores(cfg, "", "", "S2", fakeResolver(cfg, map[string]fakeSecretStore{}, &calls))
	if err == nil {
		t.Fatal("expected hard error for a missing user-supplied store, got nil")
	}
	if !errors.Is(err, ErrSecretStoreNotFound) {
		t.Fatalf("error = %v, want ErrSecretStoreNotFound", err)
	}
}

// TestLayerSecretStores_UserEqualsInheritedMissing: when the caller names the
// very store that was inherited-and-deleted, honor the explicit request (hard
// error), don't silently skip it.
func TestLayerSecretStores_UserEqualsInheritedMissing(t *testing.T) {
	cfg := &types.SandboxConfig{SecretStore: "S1"}
	var calls []string
	_, err := layerSecretStores(cfg, "", "S1", "S1", fakeResolver(cfg, map[string]fakeSecretStore{}, &calls))
	if !errors.Is(err, ErrSecretStoreNotFound) {
		t.Fatalf("error = %v, want ErrSecretStoreNotFound (user explicitly named S1)", err)
	}
	if want := []string{"S1"}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("resolve order = %v, want %v (deduped to one)", calls, want)
	}
}

// TestLayerSecretStores_AllInheritedDeletedBootsBare: an inherited store gone
// with no replacement leaves the fork with no store bound, rather than failing.
func TestLayerSecretStores_AllInheritedDeletedBootsBare(t *testing.T) {
	cfg := &types.SandboxConfig{BaseSecretStore: "B1", SecretStore: "S1"}
	var calls []string
	id, err := layerSecretStores(cfg, "B1", "S1", "", fakeResolver(cfg, map[string]fakeSecretStore{}, &calls))
	if err != nil {
		t.Fatalf("all-inherited-deleted should boot bare, got error: %v", err)
	}
	if id != nil {
		t.Fatalf("secretStoreID = %v, want nil (no store bound)", id)
	}
	if cfg.SecretStore != "" || cfg.BaseSecretStore != "" {
		t.Fatalf("persisted stores = (%q, %q), want empty", cfg.SecretStore, cfg.BaseSecretStore)
	}
}

// TestLayerSecretStores_TransientErrorPropagates: a non-not-found failure (e.g.
// edge/DB blip) on an inherited store must NOT be swallowed as a skip — it
// fails the fork so we never silently drop a store's secrets.
func TestLayerSecretStores_TransientErrorPropagates(t *testing.T) {
	cfg := &types.SandboxConfig{SecretStore: "ERR-flaky"}
	var calls []string
	_, err := layerSecretStores(cfg, "", "ERR-flaky", "", fakeResolver(cfg, map[string]fakeSecretStore{}, &calls))
	if err == nil {
		t.Fatal("expected transient error to propagate, got nil")
	}
	if errors.Is(err, ErrSecretStoreNotFound) {
		t.Fatalf("error = %v, should NOT be classified as not-found", err)
	}
}

// TestLayerSecretStores_HappyLayeringUnchanged: with every layer present the
// behavior is the pre-fix layering — order preserved, last wins as child,
// second-to-last as base, envs merged (later wins), egress unioned.
func TestLayerSecretStores_HappyLayeringUnchanged(t *testing.T) {
	cfg := &types.SandboxConfig{BaseSecretStore: "B1", SecretStore: "C1"}
	existing := map[string]fakeSecretStore{
		"B1": {id: uid(1), egress: []string{"a", "b"}, envs: map[string]string{"K": "base", "B": "1"}},
		"C1": {id: uid(2), egress: []string{"b", "c"}, envs: map[string]string{"K": "child", "C": "1"}},
		"U1": {id: uid(3), egress: []string{"c", "d"}, envs: map[string]string{"K": "user", "U": "1"}},
	}
	var calls []string
	id, err := layerSecretStores(cfg, "B1", "C1", "U1", fakeResolver(cfg, existing, &calls))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if id == nil || *id != uid(3) {
		t.Fatalf("winning id = %v, want U1 (%v)", id, uid(3))
	}
	if cfg.SecretStore != "U1" || cfg.BaseSecretStore != "C1" {
		t.Fatalf("persisted = (child %q, base %q), want (U1, C1)", cfg.SecretStore, cfg.BaseSecretStore)
	}
	if cfg.SecretEnvs["K"] != "user" {
		t.Fatalf("env K = %q, want last-layer wins (user)", cfg.SecretEnvs["K"])
	}
	if want := []string{"a", "b", "c", "d"}; !reflect.DeepEqual(cfg.EgressAllowlist, want) {
		t.Fatalf("egress = %v, want unioned %v", cfg.EgressAllowlist, want)
	}
	if want := []string{"B1", "C1", "U1"}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("resolve order = %v, want %v", calls, want)
	}
}
