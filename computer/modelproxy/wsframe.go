// WebSocket frames (RFC 6455 §5.2) read as they pass through a tunnel
// (websocket.go): an incremental parser that hands each data message's
// payload, unmasked, to a sink piece by piece as the bytes go by.
//
// Invariants: it only reads; the bytes it is fed pass on unchanged whatever
// it makes of them. Nothing is buffered beyond one frame header. Control
// frames (ping, pong, close) are skipped, also between a message's
// fragments. A frame it cannot follow (an RSV bit set, so an extension such
// as compression it was not told of; a continuation out of place; a length
// over 2^63) stops it for good: it then reports nothing more.
package main

import "encoding/binary"

// wsSink receives the data messages a wsFrames sees, in order.
type wsSink interface {
	begin()      // a text or binary message starts
	data([]byte) // a piece of its payload, unmasked; valid only during the call
	end()        // its last byte has gone by
}

type wsFrames struct {
	sink    wsSink
	broken  bool
	hdr     [14]byte
	hn      int   // header bytes read
	left    int64 // payload bytes left in the current frame; -1: reading a header
	mask    [4]byte
	masked  bool
	mpos    int // payload offset within the frame, for the mask
	control bool
	fin     bool
	inMsg   bool
	scratch []byte // unmasked payload
}

func newWSFrames(sink wsSink) *wsFrames { return &wsFrames{sink: sink, left: -1} }

// headerLen is the current frame header's length, as far as its bytes so far tell.
func (f *wsFrames) headerLen() int {
	if f.hn < 2 {
		return 2
	}
	n := 2
	switch f.hdr[1] & 0x7f {
	case 126:
		n += 2
	case 127:
		n += 8
	}
	if f.hdr[1]&0x80 != 0 {
		n += 4
	}
	return n
}

func (f *wsFrames) feed(p []byte) {
	for len(p) > 0 && !f.broken {
		if f.left < 0 {
			n := copy(f.hdr[f.hn:f.headerLen()], p)
			f.hn += n
			p = p[n:]
			if f.hn == f.headerLen() {
				f.startFrame()
			}
			continue
		}
		n := int(min(int64(len(p)), f.left))
		f.payload(p[:n])
		p = p[n:]
		if f.left -= int64(n); f.left == 0 {
			f.endFrame()
		}
	}
}

func (f *wsFrames) startFrame() {
	b0, b1 := f.hdr[0], f.hdr[1]
	op := b0 & 0x0f
	f.fin, f.masked, f.control = b0&0x80 != 0, b1&0x80 != 0, op >= 8
	n, i := int64(b1&0x7f), 2
	switch n {
	case 126:
		n, i = int64(binary.BigEndian.Uint16(f.hdr[2:])), 4
	case 127:
		n, i = int64(binary.BigEndian.Uint64(f.hdr[2:])), 10
	}
	if b0&0x70 != 0 || n < 0 || (!f.control && (op == 0) != f.inMsg) {
		f.broken = true
		return
	}
	if f.masked {
		copy(f.mask[:], f.hdr[i:i+4])
	}
	f.hn, f.mpos, f.left = 0, 0, n
	if !f.control && op != 0 {
		f.inMsg = true
		f.sink.begin()
	}
	if n == 0 {
		f.endFrame()
	}
}

func (f *wsFrames) payload(p []byte) {
	if f.control {
		return
	}
	if f.masked {
		f.scratch = append(f.scratch[:0], p...)
		for i := range f.scratch {
			f.scratch[i] ^= f.mask[(f.mpos+i)&3]
		}
		f.mpos += len(p)
		p = f.scratch
	}
	f.sink.data(p)
}

func (f *wsFrames) endFrame() {
	f.left = -1
	if !f.control && f.fin {
		f.inMsg = false
		f.sink.end()
	}
}
