// Logging: log/slog JSON to stderr (journald under systemd), with a fixed
// service envelope. Never logged: a binding's variables, placeholders,
// bodies, prompts.
package main

import (
	"io"
	"log"
	"log/slog"
	"os"
)

var logger = slog.New(slog.NewJSONHandler(io.Discard, nil))

// discardLog silences ReverseProxy's own logging (its messages can carry
// upstream error text); failures are logged by our ErrorHandler instead.
var discardLog = log.New(io.Discard, "", 0)

func initLogger(version string, level slog.Level) {
	h := slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: level})
	host, _ := os.Hostname()
	logger = slog.New(h).With("service", "modelproxy", "hostname", host, "version", version)
	slog.SetDefault(logger)
}

func logInfo(msg string, args ...any)  { logger.Info(msg, args...) }
func logWarn(msg string, args ...any)  { logger.Warn(msg, args...) }
func logError(msg string, args ...any) { logger.Error(msg, args...) }
