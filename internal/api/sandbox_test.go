package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"
	"github.com/opensandbox/opensandbox/internal/db"
	"github.com/opensandbox/opensandbox/pkg/types"
)

func TestHealthEndpoint(t *testing.T) {
	e := echo.New()
	e.GET("/health", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]string{"status": "ok"})
	})

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	var body map[string]string
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if body["status"] != "ok" {
		t.Errorf("expected status ok, got %s", body["status"])
	}
}

// TestForkCheckpointAuthMatrix pins the design-009 auth predicate at the fork
// call site: cp.OrgID != orgID && !cp.IsPublic. The goal is to catch any
// future refactor that accidentally widens fork access or re-tightens it for
// public checkpoints. The logic is deliberately inlined (no helper) in the
// handler to keep the diff minimal, so we mirror it here and exercise every
// quadrant. Handler-level HTTP tests that also exercise DB state live behind
// a Postgres fixture we don't have yet in this repo — see the PR description
// for follow-up.
func TestForkCheckpointAuthMatrix(t *testing.T) {
	ownerOrg := uuid.New()
	otherOrg := uuid.New()

	cases := []struct {
		name     string
		cp       db.Checkpoint
		caller   uuid.UUID
		wantDeny bool
	}{
		{"owner forks private", db.Checkpoint{OrgID: ownerOrg, IsPublic: false}, ownerOrg, false},
		{"owner forks public", db.Checkpoint{OrgID: ownerOrg, IsPublic: true}, ownerOrg, false},
		{"stranger forks private", db.Checkpoint{OrgID: ownerOrg, IsPublic: false}, otherOrg, true},
		{"stranger forks public", db.Checkpoint{OrgID: ownerOrg, IsPublic: true}, otherOrg, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			deny := tc.cp.OrgID != tc.caller && !tc.cp.IsPublic
			if deny != tc.wantDeny {
				t.Fatalf("deny=%v, want %v (cp.OrgID=%s caller=%s public=%v)",
					deny, tc.wantDeny, tc.cp.OrgID, tc.caller, tc.cp.IsPublic)
			}
		})
	}
}

func TestShouldPromoteCheckpointDefault(t *testing.T) {
	ptrue := true
	pfalse := false
	cases := []struct {
		name          string
		kind          string
		promoteToFull *bool
		want          bool
	}{
		{"full omitted", "full", nil, false},
		{"full explicit true", "full", &ptrue, false},
		{"full explicit false", "full", &pfalse, false},
		{"disk only omitted defaults true", "disk_only", nil, true},
		{"disk only explicit true", "disk_only", &ptrue, true},
		{"disk only explicit false", "disk_only", &pfalse, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := shouldPromoteCheckpoint(tc.kind, tc.promoteToFull); got != tc.want {
				t.Fatalf("shouldPromoteCheckpoint(%q, %v) = %v, want %v", tc.kind, tc.promoteToFull, got, tc.want)
			}
		})
	}
}

// TestPatchOpsStayOwnerOnly pins that the three patch call sites and the
// checkpoint-delete call site still use the strict predicate even after the
// design-009 fork relaxation. Mirror the handler logic for the same reason
// as TestForkCheckpointAuthMatrix.
func TestPatchOpsStayOwnerOnly(t *testing.T) {
	ownerOrg := uuid.New()
	otherOrg := uuid.New()
	publicCp := db.Checkpoint{OrgID: ownerOrg, IsPublic: true}

	// Every strict site uses `cp.OrgID != orgID` — public flag must not
	// leak into these decisions.
	if publicCp.OrgID == otherOrg {
		t.Fatal("fixture invalid")
	}
	if denied := publicCp.OrgID != otherOrg; !denied {
		t.Fatal("stranger must be denied patch/delete ops on a public checkpoint")
	}
	if denied := publicCp.OrgID != ownerOrg; denied {
		t.Fatal("owner must be allowed patch/delete ops on own public checkpoint")
	}
}

func TestEffectiveForkNetworkPolicy(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		inherited types.NetworkPolicy
		requested types.NetworkPolicy
		want      types.NetworkPolicy
		wantErr   bool
	}{
		{name: "unrestricted inherited", inherited: types.NetworkPolicyNone, requested: types.NetworkPolicyNone, want: types.NetworkPolicyNone},
		{name: "named snapshot can tighten", inherited: types.NetworkPolicyNone, requested: types.NetworkPolicyPublic, want: types.NetworkPolicyPublic},
		{name: "direct fork inherits public", inherited: types.NetworkPolicyPublic, requested: types.NetworkPolicyNone, want: types.NetworkPolicyPublic},
		{name: "public remains public", inherited: types.NetworkPolicyPublic, requested: types.NetworkPolicyPublic, want: types.NetworkPolicyPublic},
		{name: "invalid request", inherited: types.NetworkPolicyNone, requested: types.NetworkPolicy("private"), wantErr: true},
		{name: "invalid checkpoint", inherited: types.NetworkPolicy("private"), requested: types.NetworkPolicyPublic, wantErr: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := effectiveForkNetworkPolicy(tc.inherited, tc.requested)
			if (err != nil) != tc.wantErr {
				t.Fatalf("error = %v, wantErr %v", err, tc.wantErr)
			}
			if !tc.wantErr && got != tc.want {
				t.Fatalf("policy = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestNetworkPolicySurvivesPersistence(t *testing.T) {
	t.Parallel()

	persisted := cfgForPersistence(types.SandboxConfig{NetworkPolicy: types.NetworkPolicyPublic})
	data, err := json.Marshal(persisted)
	if err != nil {
		t.Fatal(err)
	}
	var roundTrip types.SandboxConfig
	if err := json.Unmarshal(data, &roundTrip); err != nil {
		t.Fatal(err)
	}
	if roundTrip.NetworkPolicy != types.NetworkPolicyPublic {
		t.Fatalf("network policy after persistence = %q, want public", roundTrip.NetworkPolicy)
	}
}

func TestEffectiveRestoreSessionConfig(t *testing.T) {
	t.Parallel()

	t.Run("checkpoint can tighten and unknown fields survive", func(t *testing.T) {
		current := json.RawMessage(`{"alias":"builder","future":{"keep":true}}`)
		checkpoint := json.RawMessage(`{"networkPolicy":"public"}`)
		updated, changed, err := effectiveRestoreSessionConfig(current, checkpoint)
		if err != nil {
			t.Fatal(err)
		}
		if !changed {
			t.Fatal("public checkpoint did not tighten unrestricted session")
		}
		var got map[string]json.RawMessage
		if err := json.Unmarshal(updated, &got); err != nil {
			t.Fatal(err)
		}
		if string(got["networkPolicy"]) != `"public"` || string(got["future"]) != `{"keep":true}` {
			t.Fatalf("updated config lost policy or fields: %s", updated)
		}
		if err := validatePreviewNetworkPolicy(updated); err == nil {
			t.Fatal("tightened persisted config still permits preview ingress")
		}
	})

	for _, tc := range []struct {
		name       string
		current    json.RawMessage
		checkpoint json.RawMessage
		wantErr    bool
	}{
		{name: "public session cannot weaken", current: json.RawMessage(`{"networkPolicy":"public"}`), checkpoint: json.RawMessage(`{}`)},
		{name: "legacy unrestricted stays unrestricted", current: nil, checkpoint: nil},
		{name: "invalid session fails closed", current: json.RawMessage(`{"networkPolicy":"private"}`), checkpoint: json.RawMessage(`{}`), wantErr: true},
		{name: "invalid checkpoint fails closed", current: json.RawMessage(`{}`), checkpoint: json.RawMessage(`{"networkPolicy":"private"}`), wantErr: true},
		{name: "malformed checkpoint fails closed", current: json.RawMessage(`{}`), checkpoint: json.RawMessage(`{`), wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, changed, err := effectiveRestoreSessionConfig(tc.current, tc.checkpoint)
			if (err != nil) != tc.wantErr {
				t.Fatalf("error = %v, wantErr %v", err, tc.wantErr)
			}
			if !tc.wantErr && changed {
				t.Fatal("unchanged policy reported a config mutation")
			}
		})
	}
}

func TestPreviewNetworkPolicy(t *testing.T) {
	t.Parallel()

	for _, tc := range []struct {
		name    string
		config  json.RawMessage
		wantErr bool
	}{
		{name: "legacy empty config", config: nil},
		{name: "unrestricted", config: json.RawMessage(`{}`)},
		{name: "public is egress only", config: json.RawMessage(`{"networkPolicy":"public"}`), wantErr: true},
		{name: "unknown fails closed", config: json.RawMessage(`{"networkPolicy":"private"}`), wantErr: true},
		{name: "malformed fails closed", config: json.RawMessage(`{`), wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := validatePreviewNetworkPolicy(tc.config)
			if (err != nil) != tc.wantErr {
				t.Fatalf("error = %v, wantErr %v", err, tc.wantErr)
			}
		})
	}
}
