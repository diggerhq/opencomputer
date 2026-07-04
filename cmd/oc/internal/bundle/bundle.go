// Package bundle packs a fileset into a .tar.gz and content-addresses it.
//
// The content address is the STANDARD blob digest — sha256 of the packed bytes
// (as OCI addresses blobs), NOT a digest of a canonical serialization of the
// fileset. That distinction is the whole point: the CLI, the host, and the box
// all hash the SAME uploaded object (the CLI hashes what it uploads; the server
// hashes the object it received; the box hashes the object it fetched), so no
// party ever recomputes an address from scratch. There is therefore no canonical
// form to reproduce across languages — sha256 is sha256 everywhere — and no
// hand-rolled tar codec or JSON escaper. The tar is plain transport (stdlib
// archive/tar); it need not be canonical because its bytes are not the address.
package bundle

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"time"
)

// File is one entry in a bundle. Mode is normalized to 0o644 or 0o755.
type File struct {
	Path    string // bundle-root-relative, forward-slash separated
	Mode    int    // 0o644 | 0o755
	Content []byte
}

// NormalizeMode collapses an on-disk mode to the two the bundle allows: 0o755 if
// any execute bit is set, else 0o644.
func NormalizeMode(mode int) int {
	if mode&0o111 != 0 {
		return 0o755
	}
	return 0o644
}

// Digest is the content address of the packed bundle: "sha256:" + sha256(blob).
// The caller hashes exactly the bytes it uploads; the server and box verify by
// hashing exactly the bytes they hold — no reproduction, no lockstep.
func Digest(blob []byte) string {
	sum := sha256.Sum256(blob)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// Pack writes the fileset to a gzip-compressed tar with the standard library.
// Entries are sorted and mtime is pinned to the epoch so the output is stable
// for identical input (dedup-friendly), but nothing depends on the exact bytes —
// the digest is over whatever Pack produces, and the box unpacks with system tar.
func Pack(files []File) ([]byte, error) {
	sorted := append([]File(nil), files...)
	sortByPath(sorted)

	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(zw)
	for _, f := range sorted {
		if err := tw.WriteHeader(&tar.Header{
			Name:     f.Path,
			Mode:     int64(f.Mode),
			Size:     int64(len(f.Content)),
			Typeflag: tar.TypeReg,
			ModTime:  time.Unix(0, 0),
		}); err != nil {
			return nil, err
		}
		if _, err := tw.Write(f.Content); err != nil {
			return nil, err
		}
	}
	if err := tw.Close(); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// sortByPath orders entries by path bytes (insertion sort; a bundle is small).
func sortByPath(files []File) {
	for i := 1; i < len(files); i++ {
		for j := i; j > 0 && files[j-1].Path > files[j].Path; j-- {
			files[j-1], files[j] = files[j], files[j-1]
		}
	}
}
