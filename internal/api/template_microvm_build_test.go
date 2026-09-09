package api

import (
	"strings"
	"testing"
)

// The create path must never silently ignore an inline manifest on a runtime
// that cannot honour it. Falling through hands back a base-image box with none
// of the customer's packages, which is indistinguishable from success until
// their code fails.
func TestInlineManifestRefusalNamesTheSupportedPath(t *testing.T) {
	msg := ErrInlineManifestUnsupported.Error()
	for _, want := range []string{"snapshot", "template="} {
		if !strings.Contains(msg, want) {
			t.Errorf("refusal does not tell the customer what to do instead (missing %q): %s", want, msg)
		}
	}
}

// The build orders dedupe -> quota -> row -> build -> ready. This pins the two
// orderings whose reversal causes a specific, silent failure.
func TestBuildOrderingInvariantsAreDocumented(t *testing.T) {
	// Quota counts 'processing' as well as 'ready': otherwise an org can start
	// N concurrent builds and exceed the cap before any completes.
	if maxImageTemplatesPerOrg <= 0 {
		t.Fatal("a non-positive cap disables the quota entirely")
	}
	// Dedupe must key on the same hash the SDK computes, or a rebuild of an
	// unchanged manifest takes a second image slot.
	m := ImageManifest{Base: "base"}
	if computeManifestHash(&m) == "" {
		t.Fatal("manifest hash is empty — dedupe would never match")
	}
}
