package main

import (
	"context"
	"encoding/base64"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"sync"
	"syscall"
	"time"
)

// capBuffer collects a bounded amount of a subprocess's stderr.
//
// Bounded because tar can be extremely chatty about files that changed while it
// read them, and an unbounded buffer on a box this small is a memory leak with
// a customer's workspace as the input.
type capBuffer struct {
	mu  sync.Mutex
	b   []byte
	max int
}

func (c *capBuffer) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.max == 0 {
		c.max = 8 << 10
	}
	if room := c.max - len(c.b); room > 0 {
		if len(p) < room {
			room = len(p)
		}
		c.b = append(c.b, p[:room]...)
	}
	// Always report the full write: a short write makes exec.Cmd treat a
	// truncated log as a broken pipe and kill the process.
	return len(p), nil
}

func (c *capBuffer) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return string(c.b)
}

// copyFlush streams src to dst, flushing after every chunk.
//
// Without the flush a large archive sits in the response buffer and the caller
// sees nothing until it completes — which for a slow transfer is
// indistinguishable from a hang, and for a proxy with an idle timeout is a
// failure.
func copyFlush(dst io.Writer, src io.Reader) (int64, error) {
	flusher, _ := dst.(http.Flusher)
	buf := make([]byte, 256<<10)
	var total int64
	for {
		n, rerr := src.Read(buf)
		if n > 0 {
			w, werr := dst.Write(buf[:n])
			total += int64(w)
			if werr != nil {
				return total, werr
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
		if rerr == io.EOF {
			return total, nil
		}
		if rerr != nil {
			return total, rerr
		}
	}
}

func b64(b []byte) string { return base64.StdEncoding.EncodeToString(b) }

func unb64(s string) ([]byte, error) { return base64.StdEncoding.DecodeString(s) }

// contextWithTimeout bounds a request-scoped operation without letting the
// caller's disconnect be the only thing that stops it.
func contextWithTimeout(r *http.Request, d time.Duration) (context.Context, context.CancelFunc) {
	return context.WithTimeout(r.Context(), d)
}

// killSandboxProcesses SIGKILLs everything owned by the sandbox user, and
// reports how many it signalled.
//
// Walks /proc directly because procps-ng is not installed in this image — see
// the call site. A directory's owner IS the process's real uid, which is the
// same test `pkill -u` applies.
//
// PID 1 is skipped defensively: it is this process, it is root, and killing it
// would take the box down. The uid check already excludes it; the explicit skip
// is there because the cost of being wrong is the whole sandbox.
func killSandboxProcesses() int {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		log.Printf("microvm-hooks: read /proc: %v", err)
		return 0
	}
	killed := 0
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid <= 1 {
			continue
		}
		info, err := os.Stat("/proc/" + e.Name())
		if err != nil {
			continue // exited between the listing and the stat
		}
		st, ok := info.Sys().(*syscall.Stat_t)
		if !ok || st.Uid != sandboxUID {
			continue
		}
		if err := syscall.Kill(pid, syscall.SIGKILL); err == nil {
			killed++
		}
	}
	return killed
}
