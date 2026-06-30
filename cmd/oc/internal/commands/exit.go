package commands

// ExitError signals a specific process exit code to main.go without re-printing
// the error (the command already rendered its output). main.go inspects this via
// errors.As. Codes: 1 general, 3 upstream 4xx, 4 conflict, 5 transient.
type ExitError struct{ Code int }

func (e *ExitError) Error() string { return "" }
