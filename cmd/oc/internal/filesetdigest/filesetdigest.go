// Package filesetdigest is the Go implementation of the OpenComputer bundle
// fileset digest + canonical tar.gz — the content-addressing scheme shared by
// skill bundles and Flue framework artifacts.
//
// This is the THIRD implementation of one contract (flue-slice.md contract 4).
// It MUST stay byte-identical to:
//   - TS runtime:  oc-runtimes/adapter-core/src/skills.ts (computeFilesetDigest)
//   - TS host:     sessions-api/src/v3/core/skill-bundle-canonical.ts
//
// A shared golden vector (a fixed fileset → a fixed digest) locks the three in
// lockstep; see filesetdigest_test.go. If you change anything here, re-run the
// golden across all three repos.
//
// Digest (contract 4): sha256 over the bytewise-sorted, fixed-order entry list
// [{"path":…,"mode":…,"sha256":…}, …] serialized as JSON with no whitespace,
// mode as a bare decimal integer, sha256 the hex of sha256(content). The JSON is
// hand-built (not encoding/json) so string escaping matches JavaScript's
// JSON.stringify exactly — the digest is a cross-language content address, and
// Go's default JSON escaping (HTML entities, /, U+2028/U+2029)
// diverges from JS.
package filesetdigest

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

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

// Digest returns the fileset digest ("sha256:" + hex). Byte-for-byte identical
// to the TS computeFilesetDigest for the same fileset.
func Digest(files []File) string {
	type entry struct {
		path string
		mode int
		sha  string
	}
	entries := make([]entry, len(files))
	for i, f := range files {
		sum := sha256.Sum256(f.Content)
		entries[i] = entry{path: f.Path, mode: f.Mode, sha: hex.EncodeToString(sum[:])}
	}
	// Bytewise sort by path. Go string comparison is bytewise over the UTF-8
	// bytes, matching Node's Buffer.compare(Buffer.from(path, "utf8"), …).
	sort.Slice(entries, func(i, j int) bool { return entries[i].path < entries[j].path })

	var b strings.Builder
	b.WriteByte('[')
	for i, e := range entries {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(`{"path":`)
		b.WriteString(jsMarshalString(e.path))
		b.WriteString(`,"mode":`)
		b.WriteString(strconv.Itoa(e.mode))
		b.WriteString(`,"sha256":`)
		b.WriteString(jsMarshalString(e.sha))
		b.WriteByte('}')
	}
	b.WriteByte(']')

	sum := sha256.Sum256([]byte(b.String()))
	return "sha256:" + hex.EncodeToString(sum[:])
}

// jsMarshalString serializes s to a JSON string literal byte-for-byte as
// JavaScript's JSON.stringify would (ECMA-262 QuoteJSONString): escape " and \,
// the short forms \b \t \n \f \r, other C0 controls as \u00xx (lowercase), and
// emit everything else — including non-ASCII and U+2028/U+2029 — as raw UTF-8.
func jsMarshalString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}
