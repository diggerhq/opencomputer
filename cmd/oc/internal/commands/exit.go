package commands

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/client"
)

// ExitError signals a specific process exit code to main.go. The error is
// assumed already-rendered (RenderError won't reprint it). Codes mirror the
// classes below.
type ExitError struct{ Code int }

func (e *ExitError) Error() string { return "" }

// exitCodeForStatus maps an HTTP status to the CLI's exit-code classes so agents
// and CI can branch on the outcome:
//
//	0  success
//	1  general error (bad args/flags, local failure)
//	3  upstream 4xx (not found, unauthorized, invalid)
//	4  conflict (409 — already exists / invalid state)
//	5  transient (5xx — retry-safe)
func exitCodeForStatus(status int) int {
	switch {
	case status == 409:
		return 4
	case status >= 400 && status < 500:
		return 3
	case status >= 500:
		return 5
	default:
		return 1
	}
}

// RenderError prints err to stderr (a JSON envelope under --json, else plain)
// and returns the process exit code. An ExitError is treated as already-rendered
// (its code is returned with no reprint). main.go calls os.Exit(RenderError(...)).
func RenderError(err error) int {
	if err == nil {
		return 0
	}
	var exit *ExitError
	if errors.As(err, &exit) {
		return exit.Code
	}
	code := 1
	msg := err.Error()
	var apiErr *client.APIError
	if errors.As(err, &apiErr) {
		code = exitCodeForStatus(apiErr.StatusCode)
		msg = apiErr.Message
	}
	if jsonOutput {
		b, _ := json.Marshal(map[string]any{"error": msg, "code": code})
		fmt.Fprintln(os.Stderr, string(b))
	} else {
		fmt.Fprintln(os.Stderr, "Error: "+msg)
	}
	return code
}
