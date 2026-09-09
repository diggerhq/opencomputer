package api

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v4"
)

// filesystem_error_test.go — a missing file is an answer, not a fault.
//
// Every filesystem handler used to answer 500 for any error, which made "no
// such file" indistinguishable from "the sandbox is broken". A caller cannot
// decide whether to retry on that, so an SDK polling for a file that will never
// appear retries forever.
//
// The mapping is deliberately ADDITIVE: only a runtime whose error carries a
// status is treated differently. The QEMU fleet's errors do not, so its
// responses are unchanged — which is the property worth a test, because a
// regression there reaches every existing customer.

type codedErr struct {
	code int
	msg  string
}

func (e codedErr) Error() string   { return e.msg }
func (e codedErr) StatusCode() int { return e.code }

func recorded(t *testing.T, err error) int {
	t.Helper()
	rec := httptest.NewRecorder()
	c := echo.New().NewContext(httptest.NewRequest(http.MethodGet, "/", nil), rec)
	if rerr := respondFSErr(c, err); rerr != nil {
		t.Fatalf("respondFSErr returned %v", rerr)
	}
	return rec.Code
}

// A runtime that reports a status gets that status through to the customer.
func TestCodedErrorKeepsItsStatus(t *testing.T) {
	for _, code := range []int{http.StatusNotFound, http.StatusForbidden, http.StatusConflict, http.StatusInsufficientStorage} {
		if got := recorded(t, codedErr{code: code, msg: "boom"}); got != code {
			t.Errorf("status = %d, want %d", got, code)
		}
	}
}

// Wrapped is still coded — handlers wrap on the way out, and errors.As is what
// makes that survive.
func TestWrappedCodedErrorKeepsItsStatus(t *testing.T) {
	err := fmt.Errorf("read file: %w", codedErr{code: http.StatusNotFound, msg: "no such file"})
	if got := recorded(t, err); got != http.StatusNotFound {
		t.Errorf("status = %d, want 404 through the wrapper", got)
	}
}

// The QEMU path: a plain error is still a 500, exactly as before.
func TestPlainErrorIsStillFiveHundred(t *testing.T) {
	if got := recorded(t, errors.New("qemu: agent unreachable")); got != http.StatusInternalServerError {
		t.Errorf("status = %d, want 500 — existing fleet behaviour must not change", got)
	}
}

// A nonsense status is not passed through: a runtime reporting 0 or 200 for a
// failure must not turn into a success or an invalid response.
func TestImplausibleStatusFallsBackToFiveHundred(t *testing.T) {
	for _, code := range []int{0, 200, 302, 700} {
		if got := recorded(t, codedErr{code: code, msg: "weird"}); got != http.StatusInternalServerError {
			t.Errorf("status %d mapped to %d, want 500", code, got)
		}
	}
}
