package api

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"
	"github.com/labstack/echo/v4"

	"github.com/opensandbox/opensandbox/internal/auth"
	"github.com/opensandbox/opensandbox/internal/db"
)

// The cutoff is the package's first stable major, not the "v2" the docs use for
// the platform generation: every version ever published is 0.x.
const (
	sdkNew = "1.0.0"
	sdkOld = "0.15.7"
)

// ctxWithSDK builds a direct-to-cell create carrying the SDK's version header.
func ctxWithSDK(version string) echo.Context {
	req := httptest.NewRequest(http.MethodPost, "/api/sandboxes", nil)
	if version != "" {
		req.Header.Set(sdkVersionHeader, version)
	}
	return echo.New().NewContext(req, httptest.NewRecorder())
}

// serverForOrg returns a Server whose runtime answer for orgID is already
// memoised, so runtimeFor never reaches Postgres. Priming the cache with "" is
// the UNPINNED org — the case the SDK gate exists for.
func serverForOrg(t *testing.T, orgID uuid.UUID, pinned string) *Server {
	t.Helper()
	s := &Server{orgRuntime: newOrgRuntimeCache(orgRuntimeTTL), store: &db.Store{}}
	s.orgRuntime.put(orgID, pinned)
	return s
}

func TestSDKMajor(t *testing.T) {
	for _, tc := range []struct {
		header string
		want   int
	}{
		{"1.0.0", 1}, {"2.0.0", 2}, {"10.4.1", 10}, {" 1.1.0 ", 1},
		// Everything unreadable is a client that does not announce itself, and
		// that population must stay on QEMU. A parse falling through to "new
		// runtime" would migrate every curl user at once.
		{"", 0}, {"   ", 0}, {"v2", 0}, {"abc", 0}, {"-3", 0}, {"0.1.0", 0},
	} {
		if got := sdkMajor(ctxWithSDK(tc.header)); got != tc.want {
			t.Errorf("sdkMajor(%q) = %d, want %d", tc.header, got, tc.want)
		}
	}
}

// Every 0.x release in npm's history must land on QEMU. Getting this wrong
// migrates the entire existing customer base on the next deploy.
func TestWholePublished0xLineStaysOnTheFleet(t *testing.T) {
	for _, v := range []string{"0.15.7", "0.15.0", "0.14.0", "0.13.1", "0.9.9", "0.0.1"} {
		org := uuid.New()
		c := ctxWithSDK(v)
		auth.SetOrgID(c, org)
		if got := serverForOrg(t, org, "").runtimeFor(c); got != "" {
			t.Errorf("SDK %s routed away from the fleet: got %q", v, got)
		}
	}
}

// The headline behaviour: an unpinned org migrates by upgrading the SDK, and
// rolls back by pinning the old major. Neither needs a row changed.
func TestUnpinnedOrgIsRoutedByTheCallingSDK(t *testing.T) {
	org := uuid.New()

	c := ctxWithSDK(sdkNew)
	auth.SetOrgID(c, org)
	if got := serverForOrg(t, org, "").runtimeFor(c); got != runtimeMicrovm {
		t.Errorf("1.x SDK did not route to microvm: got %q", got)
	}

	for _, old := range []string{sdkOld, ""} {
		c := ctxWithSDK(old)
		auth.SetOrgID(c, org)
		if got := serverForOrg(t, org, "").runtimeFor(c); got != "" {
			t.Errorf("SDK %q routed away from the fleet: got %q", old, got)
		}
	}
}

// A migrated org must not be dragged back by one stale service still on an old
// SDK — its templates only exist on the runtime it moved to. And the opt-out
// has to survive an upgrade, or an org that needs checkpoints loses them by
// bumping a dependency.
func TestPinWinsOverTheSDKInBothDirections(t *testing.T) {
	for _, tc := range []struct{ pin, sdk, want string }{
		{runtimeMicrovm, sdkOld, runtimeMicrovm},
		{runtimeMicrovm, "", runtimeMicrovm},
		{"qemu", sdkNew, "qemu"},
	} {
		org := uuid.New()
		c := ctxWithSDK(tc.sdk)
		auth.SetOrgID(c, org)
		if got := serverForOrg(t, org, tc.pin).runtimeFor(c); got != tc.want {
			t.Errorf("pin %q + SDK %q = %q, want %q", tc.pin, tc.sdk, got, tc.want)
		}
	}
}

// A cap token means the EDGE already decided, including its decision to send
// nothing. Re-deciding here would defeat the edge's kill switch and route the
// same call two different ways depending on which door it came in.
func TestCapTokenSuppressesTheSDKGate(t *testing.T) {
	org := uuid.New()
	c := ctxWithSDK(sdkNew)
	auth.SetOrgID(c, org)
	c.Set(capClaimsKey, &auth.CapabilityClaims{Runtime: ""})

	if got := serverForOrg(t, org, "").runtimeFor(c); got != "" {
		t.Errorf("cell overrode the edge's empty runtime: got %q", got)
	}
}

func TestGateKillSwitch(t *testing.T) {
	t.Setenv("OPENSANDBOX_SDK_RUNTIME_GATE", "0")
	org := uuid.New()

	c := ctxWithSDK(sdkNew)
	auth.SetOrgID(c, org)
	if got := serverForOrg(t, org, "").runtimeFor(c); got != "" {
		t.Errorf("kill switch did not hold a 1.x SDK on the fleet: got %q", got)
	}

	// ...and it must not disturb an org that was explicitly moved.
	c = ctxWithSDK(sdkOld)
	auth.SetOrgID(c, org)
	if got := serverForOrg(t, org, runtimeMicrovm).runtimeFor(c); got != runtimeMicrovm {
		t.Errorf("kill switch un-pinned a migrated org: got %q", got)
	}
}

func TestMinMajorIsConfigurable(t *testing.T) {
	t.Setenv("OPENSANDBOX_SDK_RUNTIME_MIN_MAJOR", "3")
	org := uuid.New()

	c := ctxWithSDK("2.9.0")
	auth.SetOrgID(c, org)
	if got := serverForOrg(t, org, "").runtimeFor(c); got != "" {
		t.Errorf("major 2 routed to microvm under a threshold of 3: got %q", got)
	}

	c = ctxWithSDK("3.0.0")
	auth.SetOrgID(c, org)
	if got := serverForOrg(t, org, "").runtimeFor(c); got != runtimeMicrovm {
		t.Errorf("major 3 did not meet a threshold of 3: got %q", got)
	}
}

// Garbage in the threshold must fall back to the default, not to 0 — a 0
// threshold routes EVERY client to microvm, including ones sending no header.
func TestGarbageThresholdFallsBackToTheDefault(t *testing.T) {
	t.Setenv("OPENSANDBOX_SDK_RUNTIME_MIN_MAJOR", "junk")
	org := uuid.New()

	c := ctxWithSDK(sdkOld)
	auth.SetOrgID(c, org)
	if got := serverForOrg(t, org, "").runtimeFor(c); got != "" {
		t.Errorf("a v1 SDK routed to microvm under a junk threshold: got %q", got)
	}

	c = ctxWithSDK(sdkNew)
	auth.SetOrgID(c, org)
	if got := serverForOrg(t, org, "").runtimeFor(c); got != runtimeMicrovm {
		t.Errorf("a 1.x SDK did not route to microvm under a junk threshold: got %q", got)
	}
}

// The header name is a contract with sdks/typescript/src/version.ts, which is a
// separate artifact with no compiler between them. Renaming one side silently
// stops every 1.x SDK from being recognised.
func TestHeaderNameMatchesTheSDK(t *testing.T) {
	if sdkVersionHeader != "X-OC-SDK-Version" {
		t.Errorf("header renamed to %q — sdks/typescript/src/version.ts sends x-oc-sdk-version", sdkVersionHeader)
	}
}
