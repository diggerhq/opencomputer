package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// The whole optimistic-claim design rests on this: a replay must succeed and a
// different sandbox must not. If either flips, the edge either strands boxes on
// dropped responses or hands one box to two customers.
func TestClaimIsIdempotentBySandboxAndExclusiveOtherwise(t *testing.T) {
	c := &claimState{}

	owned, fresh := c.claim("sb-a")
	if !owned || !fresh {
		t.Fatalf("first claim: owned=%v fresh=%v, want true/true", owned, fresh)
	}
	// Replay of the SAME sandbox — the edge retried, or fused a claim onto a
	// second exec. Must succeed, and must not be reported as a new binding.
	owned, fresh = c.claim("sb-a")
	if !owned || fresh {
		t.Fatalf("replay: owned=%v fresh=%v, want true/false", owned, fresh)
	}
	// A DIFFERENT sandbox must lose, forever.
	if owned, _ := c.claim("sb-b"); owned {
		t.Fatal("second sandbox won a claim on an already-bound box")
	}
	if got, _ := c.current(); got != "sb-a" {
		t.Fatalf("binding drifted to %q", got)
	}
}

// Concurrency is the case the mutex exists for: N racing claims for N distinct
// sandboxes must produce exactly one winner.
func TestClaimRaceHasExactlyOneWinner(t *testing.T) {
	c := &claimState{}
	const n = 64
	var wg sync.WaitGroup
	wins := make([]bool, n)
	start := make(chan struct{})
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			owned, fresh := c.claim(string(rune('a'+i%26)) + "-" + itoa(i))
			wins[i] = owned && fresh
		}(i)
	}
	close(start)
	wg.Wait()
	got := 0
	for _, w := range wins {
		if w {
			got++
		}
	}
	if got != 1 {
		t.Fatalf("fresh winners = %d, want exactly 1", got)
	}
}

func itoa(i int) string {
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}

func postJSON(t *testing.T, h http.HandlerFunc, body any) *httptest.ResponseRecorder {
	t.Helper()
	buf, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(buf)))
	return rec
}

// A lost claim must NOT run the command. Running it would execute a customer's
// command on someone else's box.
func TestClaimAndRunDoesNotExecuteWhenClaimIsLost(t *testing.T) {
	prev := boxClaim
	boxClaim = &claimState{}
	defer func() { boxClaim = prev }()

	s := &server{}
	if rec := postJSON(t, s.handleClaim, claimRequest{SandboxID: "sb-owner"}); rec.Code != http.StatusOK {
		t.Fatalf("seed claim: status %d", rec.Code)
	}

	rec := postJSON(t, s.handleClaimAndRun, map[string]any{
		"sandboxID": "sb-intruder",
		"cmd":       "echo SHOULD_NOT_RUN",
	})
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409", rec.Code)
	}
	var out claimAndRunResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Run != nil {
		t.Fatalf("command ran despite a lost claim: %+v", out.Run)
	}
	if out.Claim.OwnedBy != "sb-owner" {
		t.Fatalf("ownedBy = %q, want sb-owner", out.Claim.OwnedBy)
	}
}

// The happy path: one round trip both binds the box and returns the output.
func TestClaimAndRunFusesBindAndExec(t *testing.T) {
	prev := boxClaim
	boxClaim = &claimState{}
	defer func() { boxClaim = prev }()

	s := &server{}
	rec := postJSON(t, s.handleClaimAndRun, map[string]any{
		"sandboxID": "sb-fused",
		"cmd":       "echo hello-fused",
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	var out claimAndRunResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if !out.Claim.Fresh {
		t.Fatal("first fused claim was not reported as fresh")
	}
	if out.Run == nil || out.Run.ExitCode != 0 {
		t.Fatalf("run result = %+v, want exit 0", out.Run)
	}
	if got := out.Run.Stdout; got != "hello-fused\n" {
		t.Fatalf("stdout = %q", got)
	}
	// And the fused claim is visible to the host's reconciliation read.
	if got, _ := boxClaim.current(); got != "sb-fused" {
		t.Fatalf("binding = %q", got)
	}
}
