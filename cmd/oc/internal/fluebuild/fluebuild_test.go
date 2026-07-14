package fluebuild

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const (
	testBuilderVersion = "0.6.0.9-test"
	testNodeVersion    = "v22.19.0"
	testWrangler       = `{"name":"fixture","main":"index.js","compatibility_date":"2026-07-01","compatibility_flags":["nodejs_compat"],"no_bundle":true,"durable_objects":{"bindings":[{"name":"AGENT","class_name":"FlueStarterAgent"},{"name":"FLUE_REGISTRY","class_name":"FlueRegistry"}]},"vars":{"MUST_NOT_LEAVE":"raw"},"routes":["example.com/*"]}`
)

func TestCheckOnlyMatchesFrozenProjectionWithoutExecutingRepositoryCode(t *testing.T) {
	dir := copyFixture(t)
	sentinel := filepath.Join(dir, "executed")
	installFakeFlue(t, dir, "touch "+shellQuote(sentinel))
	t.Setenv("PATH", "") // NodeVersion is pinned by the snapshot; no process is needed.

	result, err := Build(context.Background(), Options{
		Dir:            dir,
		CheckOnly:      true,
		BuilderVersion: testBuilderVersion,
		NodeVersion:    testNodeVersion,
	})
	if err != nil {
		t.Fatalf("check-only: %v", err)
	}
	if _, err := os.Stat(sentinel); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("check-only executed repository code; stat error = %v", err)
	}
	if result.Bundle != nil || result.Deployment.Bundle != nil || result.Deployment.Flue.Wrangler != nil {
		t.Fatalf("check-only returned build-derived fields: %#v", result)
	}

	got, err := json.MarshalIndent(result.Deployment, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	got = append(got, '\n')
	want, err := os.ReadFile(filepath.Join("testdata", "check-only.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("check-only contract drifted\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

func TestBuildWritesDeterministicArtifactContract(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake Flue binary is a POSIX shell script")
	}
	dir := copyFixture(t)
	installFakeFlue(t, dir, fakeSuccessfulBuildScript())
	out := t.TempDir()

	first, err := Build(context.Background(), Options{
		Dir:            dir,
		OutputDir:      out,
		BuilderVersion: testBuilderVersion,
		NodeVersion:    testNodeVersion,
	})
	if err != nil {
		t.Fatalf("build: %v", err)
	}
	second, err := Build(context.Background(), Options{
		Dir:            dir,
		BuilderVersion: testBuilderVersion,
		NodeVersion:    testNodeVersion,
	})
	if err != nil {
		t.Fatalf("second build: %v", err)
	}
	if !bytes.Equal(first.Bundle, second.Bundle) || first.Deployment.Bundle.Digest != second.Deployment.Bundle.Digest {
		t.Fatal("identical fixture did not produce byte-identical bundle and digest")
	}
	// This pins the canonical transport bytes, not merely the digest shape.
	const goldenDigest = "sha256:169890136b7f3080bdb27dfc7f053e9bb1c31a977febbfbdd1d69c86b00dd5fd"
	if first.Deployment.Bundle.Digest != goldenDigest {
		t.Fatalf("canonical digest = %s, want %s", first.Deployment.Bundle.Digest, goldenDigest)
	}

	bundleBytes, err := os.ReadFile(filepath.Join(out, BundleFilename))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(bundleBytes, first.Bundle) {
		t.Fatal("bundle.tgz differs from returned canonical bytes")
	}
	metadataBytes, err := os.ReadFile(filepath.Join(out, DeploymentFilename))
	if err != nil {
		t.Fatal(err)
	}
	wantMetadata, err := os.ReadFile(filepath.Join("testdata", "deployment.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(metadataBytes, wantMetadata) {
		t.Fatalf("deployment.json contract drifted\n--- got ---\n%s\n--- want ---\n%s", metadataBytes, wantMetadata)
	}
	parsed, err := ParseDeployment(metadataBytes, true)
	if err != nil {
		t.Fatalf("parse deployment.json: %v", err)
	}
	if parsed.Bundle.Digest != goldenDigest || parsed.Bundle.SizeBytes != int64(len(bundleBytes)) {
		t.Fatalf("deployment bundle metadata = %#v", parsed.Bundle)
	}
	if parsed.Flue.Entrypoint != "flue-starter" || parsed.Runtime.Type != "default" || parsed.Flue.Wrangler.Main != "index.js" {
		t.Fatalf("deployment projection drifted: %#v", parsed)
	}
	for _, forbidden := range []string{dir, "MUST_NOT_LEAVE", "example.com"} {
		if strings.Contains(string(metadataBytes), forbidden) {
			t.Fatalf("deployment.json leaked %q: %s", forbidden, metadataBytes)
		}
	}
}

func TestBuildScansFinalModules(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake Flue binary is a POSIX shell script")
	}
	dir := copyFixture(t)
	installFakeFlue(t, dir, fakeSuccessfulBuildScript()+"\n"+
		"printf '%s' 'const key=\"sk-ant-api03-AbCdEf0123456789AbCdEf0123456789_-xyzTUV\";' > dist/fixture/leak.js\n")

	_, err := Build(context.Background(), Options{
		Dir: dir, BuilderVersion: testBuilderVersion, NodeVersion: testNodeVersion,
	})
	var credentialErr *CredentialError
	if !errors.As(err, &credentialErr) || credentialErr.Stage != "built modules" {
		t.Fatalf("expected built-module credential error, got %v", err)
	}
}

func TestCheckOnlyRejectsUnsupportedBuilderNode(t *testing.T) {
	dir := copyFixture(t)
	_, err := Build(context.Background(), Options{
		Dir: dir, CheckOnly: true, BuilderVersion: testBuilderVersion, NodeVersion: "v23.0.0",
	})
	if err == nil || !strings.Contains(err.Error(), "node_unsupported") {
		t.Fatalf("expected node_unsupported, got %v", err)
	}
}

func TestParseDeploymentRejectsUnknownFields(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("testdata", "check-only.json"))
	if err != nil {
		t.Fatal(err)
	}
	raw = bytes.Replace(raw, []byte(`"schema_version": 1`), []byte(`"schema_version": 1, "source_path": "/tmp/leak"`), 1)
	if _, err := ParseDeployment(raw, false); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("expected unknown-field rejection, got %v", err)
	}
}

func copyFixture(t *testing.T) string {
	t.Helper()
	src := filepath.Join("testdata", "starter")
	dst := t.TempDir()
	err := filepath.WalkDir(src, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		target := filepath.Join(dst, rel)
		if entry.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, content, 0o644)
	})
	if err != nil {
		t.Fatal(err)
	}
	return dst
}

func installFakeFlue(t *testing.T, dir, body string) {
	t.Helper()
	path := filepath.Join(dir, "node_modules", ".bin", "flue")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\nset -eu\ntest \"$1\" = build\ntest \"$2\" = --target\ntest \"$3\" = cloudflare\n" + body + "\n"
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
}

func fakeSuccessfulBuildScript() string {
	return "mkdir -p dist/fixture/assets dist/fixture/.vite\n" +
		"cat > dist/fixture/index.js <<'JS'\nexport default { fetch() { return new Response(\"ok\"); } };\nJS\n" +
		"cat > dist/fixture/assets/chunk.mjs <<'JS'\nexport const chunk = 1;\nJS\n" +
		"printf '%s' '{\"ignored\":true}' > dist/fixture/index.js.map\n" +
		"printf '%s' '{\"ignored\":true}' > dist/fixture/.vite/manifest.json\n" +
		"cat > dist/fixture/wrangler.json <<'JSON'\n" + testWrangler + "\nJSON"
}

func shellQuote(value string) string {
	return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'"
}
