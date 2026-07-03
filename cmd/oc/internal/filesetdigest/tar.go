package filesetdigest

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"sort"
	"strconv"
	"time"
)

// CanonicalTarGz builds the deterministic tar.gz transport container for a
// fileset: entries bytewise-sorted by path, fixed mode/uid/gid/mtime, gzip
// mtime zeroed. Mirrors buildCanonicalTarGz in
// sessions-api/src/v3/core/skill-bundle-canonical.ts.
//
// The tar bytes are NOT the content address — the digest is over the fileset
// (Digest), and the server re-derives it from the UNPACKED bytes with its own
// minimal POSIX-ustar reader (adapter-core parseTar). This writer emits exactly
// what that reader consumes: typeflag '0' regular files, ustar name/prefix split
// for long paths, octal numeric fields. No PAX/GNU extensions (Go's archive/tar
// would add extension records the minimal reader can't parse), which is why this
// is hand-rolled.
func CanonicalTarGz(files []File) ([]byte, error) {
	sorted := append([]File(nil), files...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Path < sorted[j].Path })

	var tar bytes.Buffer
	for _, f := range sorted {
		hdr, err := tarHeader(f.Path, f.Mode, len(f.Content))
		if err != nil {
			return nil, err
		}
		tar.Write(hdr)
		tar.Write(f.Content)
		if pad := (512 - (len(f.Content) % 512)) % 512; pad > 0 {
			tar.Write(make([]byte, pad))
		}
	}
	tar.Write(make([]byte, 1024)) // two zero blocks = end of archive

	var gz bytes.Buffer
	zw, err := gzip.NewWriterLevel(&gz, gzip.BestCompression)
	if err != nil {
		return nil, err
	}
	zw.ModTime = time.Time{} // zero → gzip MTIME field written as 0 (determinism)
	if _, err := zw.Write(tar.Bytes()); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return gz.Bytes(), nil
}

// tarHeader builds a 512-byte POSIX ustar header for a regular file with
// uid/gid/mtime = 0 (deterministic). Matches tarHeader in skill-bundle-canonical.ts.
func tarHeader(path string, mode, size int) ([]byte, error) {
	buf := make([]byte, 512)
	pathBytes := []byte(path)
	if len(pathBytes) <= 100 {
		copy(buf[0:100], pathBytes)
	} else {
		// ustar name(100)/prefix(155) split: cut at a '/' in the last 100 bytes.
		cut := -1
		for i := len(pathBytes) - 100; i < len(pathBytes); i++ {
			if pathBytes[i] == '/' {
				cut = i
				break
			}
		}
		if cut < 0 || cut > 155 {
			return nil, fmt.Errorf("path too long for tar: %q", path)
		}
		copy(buf[0:100], pathBytes[cut+1:]) // name
		copy(buf[345:500], pathBytes[:cut]) // prefix
	}
	writeOctal(buf, 100, 8, mode&0o7777)
	writeOctal(buf, 108, 8, 0) // uid
	writeOctal(buf, 116, 8, 0) // gid
	writeOctal(buf, 124, 12, size)
	writeOctal(buf, 136, 12, 0) // mtime
	for i := 148; i < 156; i++ {
		buf[i] = ' ' // checksum field = spaces while summing
	}
	buf[156] = '0'                  // typeflag '0' (regular file)
	copy(buf[257:263], "ustar\x00") // magic
	copy(buf[263:265], "00")        // version

	sum := 0
	for i := 0; i < 512; i++ {
		sum += int(buf[i])
	}
	cs := padOctal(sum, 6)
	copy(buf[148:154], cs) // 6 octal digits
	buf[154] = 0
	buf[155] = ' '
	return buf, nil
}

// writeOctal writes value as octal into buf[off:off+length): (length-1)
// zero-padded digits, then a NUL. Matches writeOctal in the TS canonicalizer.
func writeOctal(buf []byte, off, length, value int) {
	s := padOctal(value, length-1)
	copy(buf[off:off+length-1], s)
	buf[off+length-1] = 0
}

// padOctal renders value in octal, left-padded with '0' to at least width digits.
func padOctal(value, width int) string {
	s := strconv.FormatInt(int64(value), 8)
	for len(s) < width {
		s = "0" + s
	}
	return s
}
