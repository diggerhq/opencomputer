package filesetdigest

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"time"
)

// TarGz packs a fileset into a gzip-compressed tar for upload. The tar is pure
// TRANSPORT — the content address is the fileset Digest, which the server and
// box re-derive from the UNPACKED bytes, so the tar does NOT need to be
// canonical or byte-reproducible. We therefore use the standard library
// (archive/tar) on both ends instead of a hand-rolled minimal ustar codec: the
// reader handles whatever framing the writer emits (ustar or PAX for long
// paths), so there is no matched-writer/reader pair to keep in lockstep.
//
// ModTime is pinned to the epoch so repeated packs of the same input are stable
// (nice for caching/diffing), but nothing depends on it.
func TarGz(files []File) ([]byte, error) {
	var buf bytes.Buffer
	zw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(zw)
	for _, f := range files {
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
