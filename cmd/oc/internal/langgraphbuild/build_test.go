package langgraphbuild

import (
	"context"
	"os"
	"strings"
	"testing"
)

// TestBuild_Fixture runs the real wrangler bundle against an installed langgraph
// scaffold and asserts the artifact shape. Gated on LANGGRAPH_BUILD_FIXTURE (an
// `oc agent init --runtime langgraph` dir with `npm install` already run) because it
// needs node_modules + wrangler present.
func TestBuild_Fixture(t *testing.T) {
	dir := os.Getenv("LANGGRAPH_BUILD_FIXTURE")
	if dir == "" {
		t.Skip("set LANGGRAPH_BUILD_FIXTURE to an installed scaffold dir")
	}
	res, err := Build(context.Background(), dir)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	if !strings.HasPrefix(res.Digest, "sha256:") || len(res.Digest) != len("sha256:")+64 {
		t.Fatalf("digest = %q (want sha256:<64 hex>)", res.Digest)
	}
	if len(res.Bundle) == 0 || res.SizeBytes != int64(len(res.Bundle)) {
		t.Fatalf("bundle %d bytes, size=%d (want non-empty + matching)", len(res.Bundle), res.SizeBytes)
	}
	if res.Wrangler.Main != "app.js" || !res.Wrangler.NoBundle {
		t.Fatalf("descriptor main=%q noBundle=%v (want app.js / true)", res.Wrangler.Main, res.Wrangler.NoBundle)
	}
	if len(res.Wrangler.DurableObjects.Bindings) == 0 || res.Entrypoint == "" {
		t.Fatalf("missing DO binding / entrypoint: %+v", res.Wrangler.DurableObjects)
	}
	t.Logf("ok: %s… %d bytes gzip, main=%s, DO %s->%s, compat=%s",
		res.Digest[:23], res.SizeBytes, res.Wrangler.Main,
		res.Wrangler.DurableObjects.Bindings[0].Name, res.Entrypoint, res.Wrangler.CompatibilityDate)
}
