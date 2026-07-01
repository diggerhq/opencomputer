package main

import (
	"os"

	"github.com/opensandbox/opensandbox/cmd/oc/internal/commands"
)

func main() {
	// RenderError prints the error (JSON under --json) and returns the classified
	// exit code (0/1/3/4/5); a nil error returns 0. See commands/exit.go.
	os.Exit(commands.RenderError(commands.Execute()))
}
