// What a Responses stream (a route with format `responses`) says about its
// own request, read as the client reads it: when its first output item came
// (the model's own first token, as opposed to `ttfb_ms`, which
// `response.created` ends), the service tier it was served on, and whether
// it reached `response.completed`. A client such as Codex closes its
// connection once it has read `response.completed`, before the upstream's
// end; without the last fact every such finished request would be reported
// as cancelled.
//
// Invariants: nothing is read ahead of the client, nothing is buffered beyond
// a short tail kept to match markers split across reads, and nothing from the
// stream but these three facts is kept; a compressed body is not watched.
package main

import (
	"bytes"
	"io"
	"sync/atomic"
)

var (
	// Quoted JSON: model output inside the stream escapes its quotes, so it cannot match.
	markOutput    = []byte(`"type":"response.output_item.added"`)
	markCompleted = []byte(`"type":"response.completed"`)
	markTier      = []byte(`"service_tier":"`)
)

// sniffTail: a marker, or the tier marker and its value, fits in it.
const sniffTail = 64

// responsesFacts are set from the client's reads; read once the request ended.
type responsesFacts struct {
	firstOutput atomic.Int64 // offset from the request's start in ns (+1 so 0 means unset)
	completed   atomic.Bool
	tier        atomic.Value // string
}

func (f *responsesFacts) serviceTier() string {
	s, _ := f.tier.Load().(string)
	return s
}

type responsesBody struct {
	io.ReadCloser
	st   *reqState
	scan tailScan
}

func watchResponses(st *reqState, body io.ReadCloser) io.ReadCloser {
	return &responsesBody{ReadCloser: body, st: st}
}

func (b *responsesBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	if n > 0 {
		b.see(p[:n])
	}
	return n, err
}

func (b *responsesBody) see(chunk []byte) {
	b.match(b.scan.seam(chunk))
	b.match(chunk)
	b.scan.keep(chunk)
}

// match notes the facts in buf; the tier is the last one named (response.completed's is the one served).
func (b *responsesBody) match(buf []byte) {
	f := &b.st.resp
	if f.firstOutput.Load() == 0 && bytes.Contains(buf, markOutput) {
		f.firstOutput.CompareAndSwap(0, b.st.since())
	}
	if !f.completed.Load() && bytes.Contains(buf, markCompleted) {
		f.completed.Store(true)
	}
	if t, ok := tierIn(buf); ok {
		f.tier.Store(t)
	}
}

// tailScan finds markers of up to sniffTail bytes split across two pieces
// of a stream: match each piece and its seam with the one before.
type tailScan struct {
	tail []byte // the last sniffTail bytes seen
	edge []byte // tail + the next piece's first sniffTail bytes
}

// seam is the bytes either side of the seam before chunk; keep(chunk) follows.
func (s *tailScan) seam(chunk []byte) []byte {
	s.edge = append(append(s.edge[:0], s.tail...), chunk[:min(len(chunk), sniffTail)]...)
	return s.edge
}

func (s *tailScan) keep(chunk []byte) {
	s.tail = append(s.tail, chunk[max(0, len(chunk)-sniffTail):]...)
	s.tail = s.tail[:copy(s.tail, s.tail[max(0, len(s.tail)-sniffTail):])]
}

func (s *tailScan) reset() { s.tail = s.tail[:0] }

// tierIn is the last service tier buf names.
func tierIn(buf []byte) (string, bool) {
	i := bytes.LastIndex(buf, markTier)
	if i < 0 {
		return "", false
	}
	v := buf[i+len(markTier):]
	if j := bytes.IndexByte(v, '"'); j > 0 && j <= 32 {
		return string(v[:j]), true
	}
	return "", false
}
