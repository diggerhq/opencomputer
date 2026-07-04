package filesetdigest

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"strings"
	"testing"
)

// goldenFiles is the SHARED cross-repo golden vector (flue-slice.md contract 4).
// The same fileset must produce goldenDigest in all three implementations:
// this package, oc-runtimes/adapter-core, and sessions-api. It includes a real
// binary file (logo.png) so a utf8 round-trip in ANY impl would change the
// digest. Kept byte-identical to testdata/golden-fileset.json.
var goldenFiles = []File{
	{Path: "artifact.json", Mode: 0o644, Content: []byte("{\"entry\":\"oc.js\",\"profile_version\":1}\n")},
	{Path: "oc.js", Mode: 0o644, Content: []byte("export const x = 1;\n")},
	{Path: "skills/triage/SKILL.md", Mode: 0o644, Content: []byte("---\nname: triage\n---\nhello\n")},
	{Path: "skills/triage/logo.png", Mode: 0o644, Content: mustB64("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")},
	{Path: "bin/run.sh", Mode: 0o755, Content: []byte("#!/bin/sh\necho hi\n")},
}

func mustB64(s string) []byte {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		panic(err)
	}
	return b
}

// The ocfs1 fileset digest of goldenFiles. Regenerated across all three repos
// whenever the algorithm changes (it must not, without a scheme bump).
const goldenDigest = "sha256:cab805ea6500039cdd09da801f90b1d6aff177710f106acc647a875c2dcdceea"

func TestGoldenDigest(t *testing.T) {
	if got := Digest(goldenFiles); got != goldenDigest {
		t.Fatalf("digest mismatch\n got: %s\nwant: %s", got, goldenDigest)
	}
}

func TestDigestIndependentOfInputOrder(t *testing.T) {
	// Reversed input must yield the same digest (entries are bytewise-sorted).
	rev := make([]File, len(goldenFiles))
	for i, f := range goldenFiles {
		rev[len(goldenFiles)-1-i] = f
	}
	if got := Digest(rev); got != Digest(goldenFiles) {
		t.Fatalf("digest is order-dependent: got %s want %s", got, Digest(goldenFiles))
	}
}

// TestTarGzRoundTrip reproduces the server/box verify path: pack the fileset,
// unpack it with a standard tar reader, and recompute the digest from the
// unpacked bytes. It must equal Digest(files) — the check the deploy-verify
// executor and the box materializer both perform before pinning.
func TestTarGzRoundTrip(t *testing.T) {
	tarGz, err := TarGz(goldenFiles)
	if err != nil {
		t.Fatalf("TarGz: %v", err)
	}
	unpacked, err := readTarGz(tarGz)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(unpacked) != len(goldenFiles) {
		t.Fatalf("unpacked %d files, want %d", len(unpacked), len(goldenFiles))
	}
	if got := Digest(unpacked); got != Digest(goldenFiles) {
		t.Fatalf("round-trip digest mismatch: got %s want %s", got, Digest(goldenFiles))
	}
	byPath := map[string]File{}
	for _, f := range unpacked {
		byPath[f.Path] = f
	}
	for _, want := range goldenFiles {
		got, ok := byPath[want.Path]
		if !ok {
			t.Fatalf("missing %q after round trip", want.Path)
		}
		if got.Mode != want.Mode {
			t.Errorf("%q mode = %o, want %o", want.Path, got.Mode, want.Mode)
		}
		if !bytes.Equal(got.Content, want.Content) {
			t.Errorf("%q content changed", want.Path)
		}
	}
}

// TestTarGzLongPath is the case the old hand-rolled ustar codec had to special-
// case (name/prefix split, "path too long" errors): a path over 100 bytes must
// round-trip cleanly through the standard tar codec.
func TestTarGzLongPath(t *testing.T) {
	long := "skills/" + strings.Repeat("a/", 60) + "SKILL.md" // ~130 bytes
	files := []File{{Path: long, Mode: 0o644, Content: []byte("x")}}
	tarGz, err := TarGz(files)
	if err != nil {
		t.Fatalf("TarGz long path: %v", err)
	}
	unpacked, err := readTarGz(tarGz)
	if err != nil {
		t.Fatalf("read long path: %v", err)
	}
	if len(unpacked) != 1 || unpacked[0].Path != long {
		t.Fatalf("long path did not round-trip: %+v", unpacked)
	}
}

func TestNormalizeMode(t *testing.T) {
	cases := map[int]int{0o644: 0o644, 0o600: 0o644, 0o755: 0o755, 0o700: 0o755, 0o777: 0o755}
	for in, want := range cases {
		if got := NormalizeMode(in); got != want {
			t.Errorf("NormalizeMode(%o) = %o, want %o", in, got, want)
		}
	}
}

func readTarGz(tarGz []byte) ([]File, error) {
	zr, err := gzip.NewReader(bytes.NewReader(tarGz))
	if err != nil {
		return nil, err
	}
	tr := tar.NewReader(zr)
	var out []File
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		content, err := io.ReadAll(tr)
		if err != nil {
			return nil, err
		}
		out = append(out, File{Path: hdr.Name, Mode: int(hdr.Mode) & 0o7777, Content: content})
	}
	return out, nil
}

func TestContentShaSanity(t *testing.T) {
	sum := sha256.Sum256([]byte("hello"))
	if hex.EncodeToString(sum[:]) != "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" {
		t.Fatal("sha256 sanity failed")
	}
}
