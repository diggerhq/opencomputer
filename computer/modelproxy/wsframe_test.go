package main

import (
	"bufio"
	"encoding/binary"
	"io"
	"strings"
	"testing"
)

// wsFrame encodes one frame, masked when mask is set (a client's).
func wsFrame(op byte, fin bool, payload []byte, mask []byte) []byte {
	b0 := op
	if fin {
		b0 |= 0x80
	}
	out := []byte{b0}
	var mb byte
	if mask != nil {
		mb = 0x80
	}
	switch n := len(payload); {
	case n < 126:
		out = append(out, mb|byte(n))
	case n < 1<<16:
		out = append(out, mb|126, 0, 0)
		binary.BigEndian.PutUint16(out[2:], uint16(n))
	default:
		out = append(out, mb|127, 0, 0, 0, 0, 0, 0, 0, 0)
		binary.BigEndian.PutUint64(out[2:], uint64(n))
	}
	if mask == nil {
		return append(out, payload...)
	}
	out = append(out, mask...)
	for i, c := range payload {
		out = append(out, c^mask[i&3])
	}
	return out
}

// readWSFrame reads one frame, unmasked.
func readWSFrame(r *bufio.Reader) (op byte, fin bool, payload []byte, err error) {
	var h [2]byte
	if _, err = io.ReadFull(r, h[:]); err != nil {
		return
	}
	op, fin = h[0]&0x0f, h[0]&0x80 != 0
	n := uint64(h[1] & 0x7f)
	switch n {
	case 126:
		var x [2]byte
		if _, err = io.ReadFull(r, x[:]); err != nil {
			return
		}
		n = uint64(binary.BigEndian.Uint16(x[:]))
	case 127:
		var x [8]byte
		if _, err = io.ReadFull(r, x[:]); err != nil {
			return
		}
		n = binary.BigEndian.Uint64(x[:])
	}
	var mask [4]byte
	if h[1]&0x80 != 0 {
		if _, err = io.ReadFull(r, mask[:]); err != nil {
			return
		}
	}
	payload = make([]byte, n)
	if _, err = io.ReadFull(r, payload); err != nil {
		return
	}
	if h[1]&0x80 != 0 {
		for i := range payload {
			payload[i] ^= mask[i&3]
		}
	}
	return
}

type msgSink struct {
	msgs []string
	cur  strings.Builder
	open bool
}

func (s *msgSink) begin()        { s.cur.Reset(); s.open = true }
func (s *msgSink) data(p []byte) { s.cur.Write(p) }
func (s *msgSink) end()          { s.msgs = append(s.msgs, s.cur.String()); s.open = false }

// Messages come out whole and unmasked however the bytes are split:
// masked or not, every length encoding, fragmented with control frames
// between the fragments, empty frames.
func TestWSFramesSplits(t *testing.T) {
	mask := []byte{1, 2, 3, 4}
	long := strings.Repeat("x", 300)
	huge := strings.Repeat("y", 70000)
	var stream []byte
	stream = append(stream, wsFrame(1, true, []byte(`{"type":"a"}`), mask)...)
	stream = append(stream, wsFrame(1, false, []byte(`{"type":`), nil)...)
	stream = append(stream, wsFrame(9, true, []byte("ping"), mask)...)
	stream = append(stream, wsFrame(0, false, nil, nil)...)
	stream = append(stream, wsFrame(0, true, []byte(`"b"}`), mask)...)
	stream = append(stream, wsFrame(1, true, []byte(long), mask)...)
	stream = append(stream, wsFrame(2, true, []byte(huge), nil)...)
	stream = append(stream, wsFrame(1, true, nil, nil)...)
	stream = append(stream, wsFrame(8, true, []byte{3, 232}, nil)...)
	want := []string{`{"type":"a"}`, `{"type":"b"}`, long, huge, ""}
	for _, step := range []int{1, 2, 3, 7, 13, 64, 1 << 20} {
		s := &msgSink{}
		f := newWSFrames(s)
		for i := 0; i < len(stream); i += step {
			f.feed(stream[i:min(i+step, len(stream))])
		}
		if f.broken || len(s.msgs) != len(want) || s.open {
			t.Fatalf("step %d: broken %v, %d messages, open %v", step, f.broken, len(s.msgs), s.open)
		}
		for i := range want {
			if s.msgs[i] != want[i] {
				t.Fatalf("step %d: message %d is %.40q", step, i, s.msgs[i])
			}
		}
	}
}

// A frame it cannot follow stops it for good: compressed (RSV1), or a
// continuation with no message open.
func TestWSFramesBroken(t *testing.T) {
	for name, b := range map[string][]byte{
		"rsv1":         append([]byte{0xc1, 2}, 'h', 'i'),
		"continuation": wsFrame(0, true, []byte("x"), nil),
		"new mid-msg":  append(wsFrame(1, false, []byte("x"), nil), wsFrame(1, true, []byte("y"), nil)...),
	} {
		s := &msgSink{}
		f := newWSFrames(s)
		f.feed(b)
		f.feed(wsFrame(1, true, []byte("after"), nil))
		if !f.broken || len(s.msgs) != 0 {
			t.Fatalf("%s: broken %v, messages %q", name, f.broken, s.msgs)
		}
	}
}
