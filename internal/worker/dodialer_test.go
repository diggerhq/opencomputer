package worker

import (
	"bytes"
	"encoding/binary"
	"testing"
)

// These tests pin the Go host codec to the TypeScript wire format in
// cloudflare-workers/api-edge/src/protocol.ts. tsEncodeExec / tsDecodeResult are
// faithful Go transcriptions of that file's encodeExec / decodeResult, so a pass
// means the DO (encoder of ExecRequest, decoder of ExecResult) and the host
// (decoder of ExecRequest, encoder of ExecResult) agree byte-for-byte.

// tsEncodeExec mirrors protocol.ts encodeExec.
func tsEncodeExec(requestID uint32, command, cwd string, timeoutMs uint32, env map[string]string) []byte {
	var b bytes.Buffer
	putVarintField := func(field int, v uint64) {
		putUvarint(&b, uint64(field)<<3|0)
		putUvarint(&b, v)
	}
	putBytesField := func(field int, v []byte) {
		putUvarint(&b, uint64(field)<<3|2)
		putUvarint(&b, uint64(len(v)))
		b.Write(v)
	}
	putStringField := func(field int, v string) {
		if v != "" {
			putBytesField(field, []byte(v))
		}
	}
	putVarintField(1, uint64(requestID))
	putStringField(2, command)
	putStringField(3, cwd)
	putVarintField(4, uint64(timeoutMs))
	for k, v := range env {
		var entry bytes.Buffer
		// entry = {field1: key, field2: value}
		putUvarint(&entry, 1<<3|2)
		putUvarint(&entry, uint64(len(k)))
		entry.WriteString(k)
		putUvarint(&entry, 2<<3|2)
		putUvarint(&entry, uint64(len(v)))
		entry.WriteString(v)
		putBytesField(5, entry.Bytes())
	}
	return b.Bytes()
}

func putUvarint(b *bytes.Buffer, v uint64) {
	var tmp [binary.MaxVarintLen64]byte
	n := binary.PutUvarint(tmp[:], v)
	b.Write(tmp[:n])
}

// tsDecodeResult mirrors protocol.ts decodeResult (incl. zigzag on field 2).
func tsDecodeResult(t *testing.T, buf []byte) (requestID uint32, exitCode int32, durationMs uint32, stdout, stderr, errStr string) {
	i := 0
	for i < len(buf) {
		tag, n := binary.Uvarint(buf[i:])
		if n <= 0 {
			t.Fatalf("bad tag")
		}
		i += n
		field := tag >> 3
		wire := tag & 7
		switch {
		case field == 1 && wire == 0:
			v, m := binary.Uvarint(buf[i:])
			requestID = uint32(v)
			i += m
		case field == 2 && wire == 0:
			v, m := binary.Uvarint(buf[i:])
			exitCode = int32(v>>1) ^ -int32(v&1) // zigzag decode
			i += m
		case field == 3 && wire == 0:
			v, m := binary.Uvarint(buf[i:])
			durationMs = uint32(v)
			i += m
		case field == 4 && wire == 2:
			l, m := binary.Uvarint(buf[i:])
			i += m
			stdout = string(buf[i : i+int(l)])
			i += int(l)
		case field == 5 && wire == 2:
			l, m := binary.Uvarint(buf[i:])
			i += m
			stderr = string(buf[i : i+int(l)])
			i += int(l)
		case field == 6 && wire == 2:
			l, m := binary.Uvarint(buf[i:])
			i += m
			errStr = string(buf[i : i+int(l)])
			i += int(l)
		default:
			t.Fatalf("unexpected field=%d wire=%d", field, wire)
		}
	}
	return
}

func TestDecodeExecRequest(t *testing.T) {
	frame := tsEncodeExec(42, "node -v", "/work", 30000, map[string]string{"FOO": "bar"})
	req, err := decodeExecRequest(frame)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if req.requestID != 42 {
		t.Errorf("requestID = %d, want 42", req.requestID)
	}
	if req.command != "node -v" {
		t.Errorf("command = %q, want %q", req.command, "node -v")
	}
	if req.cwd != "/work" {
		t.Errorf("cwd = %q, want %q", req.cwd, "/work")
	}
	if req.timeoutMs != 30000 {
		t.Errorf("timeoutMs = %d, want 30000", req.timeoutMs)
	}
	if req.env["FOO"] != "bar" {
		t.Errorf("env[FOO] = %q, want bar", req.env["FOO"])
	}
}

func TestDecodeExecRequestOmitsEmptyStrings(t *testing.T) {
	// TS encodeExec omits empty cwd (stringField no-op); decode must default it.
	frame := tsEncodeExec(7, "ls", "", 0, nil)
	req, err := decodeExecRequest(frame)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if req.cwd != "" {
		t.Errorf("cwd = %q, want empty", req.cwd)
	}
	if req.requestID != 7 || req.command != "ls" {
		t.Errorf("got id=%d cmd=%q", req.requestID, req.command)
	}
}

func TestDecodeExecRequestRejectsIncomplete(t *testing.T) {
	// Missing command must be rejected (mirrors the guest agent's guard).
	frame := tsEncodeExec(1, "", "", 0, nil)
	if _, err := decodeExecRequest(frame); err == nil {
		t.Fatal("expected error for missing command")
	}
}

func TestEncodeExecResultRoundTrip(t *testing.T) {
	cases := []struct {
		name     string
		exitCode int32
		errStr   string
	}{
		{"zero", 0, ""},
		{"one", 1, ""},
		{"negative", -1, ""},
		{"timeout", -1, "command timed out"},
		{"big", 137, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			frame := encodeExecResult(99, tc.exitCode, 1234, "out", "err", tc.errStr)
			id, code, dur, so, se, es := tsDecodeResult(t, frame)
			if id != 99 {
				t.Errorf("requestID = %d, want 99", id)
			}
			if code != tc.exitCode {
				t.Errorf("exitCode = %d, want %d", code, tc.exitCode)
			}
			if dur != 1234 {
				t.Errorf("durationMs = %d, want 1234", dur)
			}
			if so != "out" || se != "err" {
				t.Errorf("stdout/stderr = %q/%q", so, se)
			}
			if es != tc.errStr {
				t.Errorf("error = %q, want %q", es, tc.errStr)
			}
		})
	}
}

func TestEncodeExecResultOmitsEmptyError(t *testing.T) {
	// error field (6) must be absent when empty so the DO doesn't reject a
	// success as a failure.
	frame := encodeExecResult(1, 0, 0, "", "", "")
	for i := 0; i < len(frame); {
		tag, n := binary.Uvarint(frame[i:])
		i += n
		field := tag >> 3
		wire := tag & 7
		if field == 6 {
			t.Fatal("error field present for empty error")
		}
		if wire == 2 {
			l, m := binary.Uvarint(frame[i:])
			i += m + int(l)
		}
	}
}

func TestRegistryDisabledWhenUnconfigured(t *testing.T) {
	r := newDoDialerRegistry("", nil)
	if r.enabled() {
		t.Fatal("registry with empty url should be disabled")
	}
	// start/stop on a disabled registry must be safe no-ops.
	r.start("sbx-1", "tok")
	r.stop("sbx-1")

	var nilReg *doDialerRegistry
	nilReg.start("sbx-2", "tok") // must not panic
	nilReg.stop("sbx-2")
	if nilReg.enabled() {
		t.Fatal("nil registry should be disabled")
	}
}

func TestRegistryStartRequiresToken(t *testing.T) {
	// An enabled registry with an empty token must not dial (no token → tunnel).
	r := newDoDialerRegistry("wss://edge.example", nil)
	r.start("sbx-1", "")
	r.mu.Lock()
	n := len(r.dialers)
	r.mu.Unlock()
	if n != 0 {
		t.Errorf("empty token should not start a dialer, got %d", n)
	}
}

func TestCapOutput(t *testing.T) {
	// Small output passes through untouched.
	so, se := capOutput("hello", "world")
	if so != "hello" || se != "world" {
		t.Errorf("small output altered: %q/%q", so, se)
	}

	// Combined over budget: stdout kept (head), stderr gets the remainder.
	bigOut := string(bytes.Repeat([]byte("a"), doMaxOutputBytes-10))
	bigErr := string(bytes.Repeat([]byte("b"), 100))
	so, se = capOutput(bigOut, bigErr)
	if len(so)+len(se) > doMaxOutputBytes {
		t.Errorf("capped total %d exceeds budget %d", len(so)+len(se), doMaxOutputBytes)
	}
	if len(so) != len(bigOut) {
		t.Errorf("stdout should be preserved when under budget alone, got %d", len(so))
	}
	if len(se) != 10 {
		t.Errorf("stderr should be trimmed to remaining 10, got %d", len(se))
	}

	// stdout alone over budget: stderr dropped, stdout truncated to budget.
	hugeOut := string(bytes.Repeat([]byte("a"), doMaxOutputBytes*2))
	so, se = capOutput(hugeOut, "x")
	if len(so) != doMaxOutputBytes || se != "" {
		t.Errorf("huge stdout: got len(so)=%d se=%q", len(so), se)
	}
}

func TestRegistryNormalizesScheme(t *testing.T) {
	r := newDoDialerRegistry("https://edge.example/", nil)
	if r.edgeWSBase != "wss://edge.example" {
		t.Errorf("edgeWSBase = %q, want wss://edge.example", r.edgeWSBase)
	}
	if !r.enabled() {
		t.Fatal("registry with url should be enabled")
	}
}
