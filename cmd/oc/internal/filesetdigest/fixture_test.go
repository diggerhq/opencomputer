package filesetdigest

import (
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"strings"
	"testing"
)

// goldenFixture mirrors testdata/golden-fileset.json — the SHARED cross-language
// golden vector for contract 4. The same file is consumed by the sessions-api and
// oc-runtimes test suites; computeFilesetDigest(files) must equal `digest` in all
// three. Regenerate with scratch gen-fixture.mjs (reference JS) if the vector changes.
type goldenFixture struct {
	Digest string `json:"digest"`
	Files  []struct {
		Path          string `json:"path"`
		Mode          int    `json:"mode"`
		ContentBase64 string `json:"contentBase64"`
	} `json:"files"`
	CanonicalTarGzBase64 string `json:"canonicalTarGzBase64"`
}

func loadFixture(t *testing.T) goldenFixture {
	t.Helper()
	raw, err := os.ReadFile("testdata/golden-fileset.json")
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	var fx goldenFixture
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("parse fixture: %v", err)
	}
	return fx
}

// TestGoldenFixtureDigest is the C4 lockstep assertion: our Digest over the
// fixture's fileset equals the fixture's digest (the value the TS suites also
// assert). Also cross-checks the in-code golden constant against the file.
func TestGoldenFixtureDigest(t *testing.T) {
	fx := loadFixture(t)
	if fx.Digest != goldenDigest {
		t.Fatalf("fixture digest %s != in-code goldenDigest %s", fx.Digest, goldenDigest)
	}
	files := make([]File, len(fx.Files))
	for i, f := range fx.Files {
		content, err := base64.StdEncoding.DecodeString(f.ContentBase64)
		if err != nil {
			t.Fatalf("decode %q content: %v", f.Path, err)
		}
		files[i] = File{Path: f.Path, Mode: f.Mode, Content: content}
	}
	if got := Digest(files); got != fx.Digest {
		t.Fatalf("Digest(fixture files) = %s, want %s", got, fx.Digest)
	}
}

// TestGoldenFixtureTarballInterop proves the SERVER verify path works on a
// FOREIGN-produced bundle: unpack the reference (JS)-produced canonical tar.gz
// with our ustar reader and recompute the digest. Cross-language bundle interop.
func TestGoldenFixtureTarballInterop(t *testing.T) {
	fx := loadFixture(t)
	tarGz, err := base64.StdEncoding.DecodeString(fx.CanonicalTarGzBase64)
	if err != nil {
		t.Fatalf("decode tar.gz: %v", err)
	}
	// sanity: it really is gzip
	if zr, err := gzip.NewReader(strings.NewReader(string(tarGz))); err == nil {
		_, _ = io.Copy(io.Discard, zr)
		_ = zr.Close()
	}
	files, err := parseTarGz(tarGz)
	if err != nil {
		t.Fatalf("parse reference tar.gz: %v", err)
	}
	if got := Digest(files); got != fx.Digest {
		t.Fatalf("digest of reference tarball = %s, want %s", got, fx.Digest)
	}
}
