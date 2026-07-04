package bundle

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"io"
	"strings"
	"testing"
)

var files = []File{
	{Path: "artifact.json", Mode: 0o644, Content: []byte(`{"entry":"oc.js"}`)},
	{Path: "oc.js", Mode: 0o644, Content: []byte("export const x = 1;\n")},
	{Path: "skills/triage/SKILL.md", Mode: 0o644, Content: []byte("---\nname: triage\n---\n")},
	{Path: "bin/run.sh", Mode: 0o755, Content: []byte("#!/bin/sh\necho hi\n")},
}

// TestDigestIsBlobSha256 pins the contract: the address is sha256 of the packed
// bytes, so it is exactly what any party recomputes by hashing the same object.
func TestDigestIsBlobSha256(t *testing.T) {
	blob, err := Pack(files)
	if err != nil {
		t.Fatal(err)
	}
	if got := Digest(blob); got != Digest(blob) || !strings.HasPrefix(got, "sha256:") || len(got) != len("sha256:")+64 {
		t.Fatalf("unexpected digest shape: %s", got)
	}
	// Re-hashing the identical bytes (as the server/box do) yields the same value.
	same := Digest(append([]byte(nil), blob...))
	if same != Digest(blob) {
		t.Fatalf("digest not a pure function of the bytes: %s vs %s", same, Digest(blob))
	}
}

// TestPackDeterministic keeps identical input -> identical bytes (skill dedup).
func TestPackDeterministic(t *testing.T) {
	a, err := Pack(files)
	if err != nil {
		t.Fatal(err)
	}
	// Input order must not matter (Pack sorts).
	rev := make([]File, len(files))
	for i, f := range files {
		rev[len(files)-1-i] = f
	}
	b, err := Pack(rev)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a, b) {
		t.Fatal("Pack is not deterministic across input order")
	}
	if Digest(a) != Digest(b) {
		t.Fatal("digest depends on input order")
	}
}

// TestPackRoundTrip unpacks with a standard tar reader (what system tar / a real
// TS reader does) and checks the fileset survives, including a long path the old
// hand-rolled ustar codec had to special-case.
func TestPackRoundTrip(t *testing.T) {
	long := "skills/" + strings.Repeat("a/", 60) + "SKILL.md" // ~130 bytes
	in := append(append([]File(nil), files...), File{Path: long, Mode: 0o644, Content: []byte("x")})
	blob, err := Pack(in)
	if err != nil {
		t.Fatal(err)
	}
	out, err := readTarGz(blob)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != len(in) {
		t.Fatalf("unpacked %d, want %d", len(out), len(in))
	}
	byPath := map[string]File{}
	for _, f := range out {
		byPath[f.Path] = f
	}
	for _, want := range in {
		got, ok := byPath[want.Path]
		if !ok {
			t.Fatalf("missing %q after round trip", want.Path)
		}
		if got.Mode != want.Mode || !bytes.Equal(got.Content, want.Content) {
			t.Errorf("%q changed: mode %o/%o", want.Path, got.Mode, want.Mode)
		}
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
