package filesetdigest

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"strconv"
	"strings"
	"testing"
)

// goldenFiles is the SHARED cross-repo golden vector (flue-slice.md contract 4).
// The same fileset must produce goldenDigest in all three implementations:
// this package, oc-runtimes/adapter-core, and sessions-api. It includes a real
// binary file (logo.png) so a utf8 round-trip in ANY impl would change the digest
// (finding #13). Kept byte-identical to testdata/golden-fileset.json.
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

const goldenDigest = "sha256:fbea3c2455fbec53f75b474924fe38e7e0fc20a67cd69a7942bd5670bc25b501"

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
	if got := Digest(rev); got != goldenDigest {
		t.Fatalf("digest is order-dependent: got %s want %s", got, goldenDigest)
	}
}

// TestCanonicalTarGzRoundTrip reproduces the SERVER's verify path: unpack the
// tar.gz with a minimal POSIX-ustar reader (a port of adapter-core parseTar) and
// recompute the digest from the unpacked bytes. It must equal Digest(files) —
// this is exactly the check the deploy-verify executor performs before pinning.
func TestCanonicalTarGzRoundTrip(t *testing.T) {
	tarGz, err := CanonicalTarGz(goldenFiles)
	if err != nil {
		t.Fatalf("CanonicalTarGz: %v", err)
	}
	unpacked, err := parseTarGz(tarGz)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(unpacked) != len(goldenFiles) {
		t.Fatalf("unpacked %d files, want %d", len(unpacked), len(goldenFiles))
	}
	if got := Digest(unpacked); got != goldenDigest {
		t.Fatalf("round-trip digest mismatch: got %s want %s", got, goldenDigest)
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

func TestCanonicalTarGzDeterministic(t *testing.T) {
	a, err := CanonicalTarGz(goldenFiles)
	if err != nil {
		t.Fatal(err)
	}
	b, err := CanonicalTarGz(goldenFiles)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a, b) {
		t.Fatal("CanonicalTarGz is not deterministic")
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

// TestJSMarshalString locks the JS-faithful escaping (the reason we hand-roll
// instead of using encoding/json). Expected values are JSON.stringify output.
func TestJSMarshalString(t *testing.T) {
	cases := []struct{ in, want string }{
		{"abc", `"abc"`},
		{`a"b\c`, `"a\"b\\c"`},
		{"tab\tnl\n", `"tab\tnl\n"`},
		{"\b\f\r", `"\b\f\r"`},
		// / < > & and non-ASCII are emitted RAW (Go's default JSON would escape some).
		{"a<b>&/z", `"a<b>&/z"`},
		{"café/☃", `"café/☃"`},
	}
	for _, c := range cases {
		if got := jsMarshalString(c.in); got != c.want {
			t.Errorf("jsMarshalString(%q) = %s, want %s", c.in, got, c.want)
		}
	}
	// C0 control chars without a short form -> lowercase \u00xx (matches JS
	// JSON.stringify). Checked via the property to avoid hand-typing escapes.
	for _, b := range []byte{0x00, 0x01, 0x1f} {
		got := jsMarshalString(string(rune(b)))
		want := "\"" + fmt.Sprintf("\\u%04x", b) + "\""
		if got != want {
			t.Errorf("jsMarshalString(%#x) = %s, want %s", b, got, want)
		}
	}
}

// ── minimal ustar reader for the round-trip test (mirror of adapter-core parseTar) ──

func parseTarGz(tarGz []byte) ([]File, error) {
	zr, err := gzip.NewReader(bytes.NewReader(tarGz))
	if err != nil {
		return nil, err
	}
	tar, err := io.ReadAll(zr)
	if err != nil {
		return nil, err
	}
	readStr := func(o, n int) string {
		s := tar[o : o+n]
		if i := bytes.IndexByte(s, 0); i >= 0 {
			s = s[:i]
		}
		return string(s)
	}
	var out []File
	off := 0
	for off+512 <= len(tar) {
		header := tar[off : off+512]
		if isAllZero(header) {
			break
		}
		name := readStr(off+0, 100)
		prefix := readStr(off+345, 155)
		path := name
		if prefix != "" {
			path = prefix + "/" + name
		}
		mode, _ := strconv.ParseInt(strings.TrimSpace(readStr(off+100, 8)), 8, 32)
		size, _ := strconv.ParseInt(strings.TrimSpace(readStr(off+124, 12)), 8, 64)
		typeflag := tar[off+156]
		off += 512
		if typeflag == '0' || typeflag == 0 {
			content := make([]byte, size)
			copy(content, tar[off:off+int(size)])
			out = append(out, File{Path: path, Mode: int(mode) & 0o7777, Content: content})
		}
		off += int((size+511)/512) * 512
	}
	return out, nil
}

func isAllZero(b []byte) bool {
	for _, x := range b {
		if x != 0 {
			return false
		}
	}
	return true
}

func TestContentShaSanity(t *testing.T) {
	sum := sha256.Sum256([]byte("hello"))
	if hex.EncodeToString(sum[:]) != "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" {
		t.Fatal("sha256 sanity failed")
	}
}
