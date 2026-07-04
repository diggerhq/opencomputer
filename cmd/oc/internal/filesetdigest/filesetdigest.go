// Package filesetdigest is the Go implementation of the OpenComputer bundle
// fileset digest — the content-addressing scheme shared by skill bundles and
// Flue framework artifacts.
//
// This is one of three implementations of a single contract (flue-slice.md
// contract 4). It MUST stay byte-identical to:
//   - TS host: sessions-api/src/v3/core/skill-bundle-canonical.ts (filesetDigest)
//   - TS box:  oc-runtimes/adapter-core/src/skills.ts (filesetDigest)
//
// A shared golden vector (a fixed fileset -> a fixed digest) locks the three in
// lockstep; see testdata/golden-fileset.json + filesetdigest_test.go.
//
// The digest hashes a length-prefixed binary framing, NOT a serialization
// format. Reproducing it in another language is three primitives with no edge
// cases — sort paths by UTF-8 bytes, big-endian uint32, sha256 of raw bytes —
// so there is nothing to escape and no JSON.stringify dialect to match. (An
// earlier scheme hashed JSON.stringify output, which forced a hand-rolled
// ECMA-262 string escaper here to match JavaScript; that is what this replaces.)
//
// Pre-image:
//
//	entries sorted by path, compared as raw UTF-8 bytes
//	buf = u32be(len(entries))
//	   ‖ for each entry: sha256(content)[32] ‖ u32be(mode) ‖ u32be(len(path)) ‖ path_utf8
//	digest = "sha256:" + lowerhex(sha256(buf))
package filesetdigest

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"sort"
)

// DigestScheme is the hash-function prefix on every digest ("sha256:<hex>").
// The hash is over the canonical framing below, not the raw file bytes — the
// same "sha256: means sha256 of our canonical form" convention as OCI descriptors.
const DigestScheme = "sha256:"

// File is one entry in a bundle fileset. Mode is the POSIX file mode, normalized
// to 0o644 or 0o755 by the caller (NormalizeMode) — the digest and the tar must
// use the same value.
type File struct {
	Path    string // bundle-root-relative, forward-slash separated (e.g. "skills/triage/SKILL.md")
	Mode    int    // 0o644 | 0o755
	Content []byte
}

// NormalizeMode collapses an on-disk mode to the two the contract allows:
// 0o755 if any execute bit is set, else 0o644. Matches the CLI/worker skill
// reader convention (agent.go readSkills).
func NormalizeMode(mode int) int {
	if mode&0o111 != 0 {
		return 0o755
	}
	return 0o644
}

// Digest returns the fileset digest ("ocfs1:" + hex). Byte-for-byte identical to
// the TS filesetDigest for the same fileset.
func Digest(files []File) string {
	type entry struct {
		path string
		mode int
		sum  [32]byte
	}
	entries := make([]entry, len(files))
	for i, f := range files {
		entries[i] = entry{path: f.Path, mode: f.Mode, sum: sha256.Sum256(f.Content)}
	}
	// Bytewise sort by path. Go string comparison is over the raw bytes, matching
	// Node's Buffer.compare(Buffer.from(path,"utf8"), …) — NOT String.localeCompare
	// or a default JS Array.sort (which orders by UTF-16 code units).
	sort.Slice(entries, func(i, j int) bool { return entries[i].path < entries[j].path })

	h := sha256.New()
	var u32 [4]byte
	binary.BigEndian.PutUint32(u32[:], uint32(len(entries)))
	h.Write(u32[:])
	for _, e := range entries {
		h.Write(e.sum[:])
		binary.BigEndian.PutUint32(u32[:], uint32(e.mode))
		h.Write(u32[:])
		path := []byte(e.path)
		binary.BigEndian.PutUint32(u32[:], uint32(len(path)))
		h.Write(u32[:])
		h.Write(path)
	}
	return DigestScheme + hex.EncodeToString(h.Sum(nil))
}
