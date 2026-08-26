package api

import (
	"context"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"time"
)

// create_trace.go — per-create step timing, for finding serialization.
//
// The existing create timing log fires only past a threshold and only covers
// runCreate's four steps, which is the wrong shape for this question. A burst of
// twenty creates that each take 3ms of work but come back at 1, 6, 24, 38, 53ms
// has no slow step at all — it has a queue — and averaging or thresholding hides
// exactly that.
//
// So this records two things a duration alone cannot express:
//
//	enter  when the handler was entered, as an offset from process start
//	each step's own elapsed time
//
// Comparing `enter` across a burst is what separates the two explanations. If
// all twenty enter together and exit staggered, something inside serializes
// them. If they enter staggered, the queue is upstream of this handler and no
// amount of work removed from it will help.
//
// Off by default. One line per create is far too much for a cell serving real
// traffic; set OPENSANDBOX_CREATE_TRACE=1 on the cell being measured.

// createTraceEnabled is read once. A per-create getenv on the hot path would be
// its own small tax on the thing being measured.
var createTraceEnabled = os.Getenv("OPENSANDBOX_CREATE_TRACE") == "1"

// traceEpoch anchors `enter` offsets. Absolute wall-clock would work too, but a
// process-relative millisecond count is far easier to compare by eye across
// twenty log lines.
var traceEpoch = time.Now()

type createTraceCtxKey struct{}

type createTrace struct {
	// kind names the line ("createtrace", "exectrace", …) so more than one hot
	// path can use this machinery and still be greppable apart.
	kind      string
	sandboxID string
	start     time.Time

	mu    sync.Mutex
	last  time.Time
	marks []traceMark
}

type traceMark struct {
	label string
	dur   time.Duration
}

// newCreateTrace returns a trace, or nil when tracing is off. Every method is
// nil-safe, so call sites stay unconditional.
func newCreateTrace() *createTrace {
	return newTrace("createtrace")
}

// newExecTrace traces the exec hot path. Exec is half of TTI and had no
// per-step timing at all, which meant a burst whose exec leg degraded was
// indistinguishable from one whose create leg did.
func newExecTrace() *createTrace {
	return newTrace("exectrace")
}

func newTrace(kind string) *createTrace {
	if !createTraceEnabled {
		return nil
	}
	now := time.Now()
	return &createTrace{kind: kind, start: now, last: now}
}

// mark records the time since the previous mark.
func (t *createTrace) mark(label string) {
	if t == nil {
		return
	}
	now := time.Now()
	t.mu.Lock()
	t.marks = append(t.marks, traceMark{label: label, dur: now.Sub(t.last)})
	t.last = now
	t.mu.Unlock()
}

func (t *createTrace) setSandboxID(id string) {
	if t == nil {
		return
	}
	t.mu.Lock()
	t.sandboxID = id
	t.mu.Unlock()
}

// emit writes the line. Sub-millisecond steps are reported in microseconds
// rather than rounded to 0 — a step that is genuinely free and a step that is
// 900µs look identical at millisecond resolution, and twenty of the latter is
// the whole effect being chased.
func (t *createTrace) emit() {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	var b strings.Builder
	fmt.Fprintf(&b, "%s %s enter=%dms total=%dus",
		t.kind,
		t.sandboxID,
		t.start.Sub(traceEpoch).Milliseconds(),
		time.Since(t.start).Microseconds())
	for _, m := range t.marks {
		fmt.Fprintf(&b, " %s=%dus", m.label, m.dur.Microseconds())
	}
	log.Print(b.String())
}

func withCreateTrace(ctx context.Context, t *createTrace) context.Context {
	if t == nil {
		return ctx
	}
	return context.WithValue(ctx, createTraceCtxKey{}, t)
}

// traceFrom recovers the trace a caller started, so the steps that live in
// another function can add to the same line instead of a second one.
func traceFrom(ctx context.Context) *createTrace {
	t, _ := ctx.Value(createTraceCtxKey{}).(*createTrace)
	return t
}
