package podman

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
)

// ExecConfig defines options for executing a command inside a container.
type ExecConfig struct {
	Container string
	Command   []string
	Env       map[string]string
	Cwd       string
	Stdin     io.Reader
	TTY       bool
}

// ExecInContainer runs a command inside a running container and returns the result.
func (c *Client) ExecInContainer(ctx context.Context, cfg ExecConfig) (*ExecResult, error) {
	args := []string{"exec"}

	if cfg.TTY {
		args = append(args, "-it")
	} else if cfg.Stdin != nil {
		args = append(args, "-i")
	}

	for k, v := range cfg.Env {
		args = append(args, "--env", fmt.Sprintf("%s=%s", k, v))
	}
	if cfg.Cwd != "" {
		args = append(args, "--workdir", cfg.Cwd)
	}

	args = append(args, cfg.Container)
	args = append(args, cfg.Command...)

	cmd := exec.CommandContext(ctx, c.binaryPath, args...)
	cmd.Env = append(os.Environ(), "REGISTRY_AUTH_FILE="+c.authFile)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if cfg.Stdin != nil {
		cmd.Stdin = cfg.Stdin
	}

	err := cmd.Run()

	result := &ExecResult{
		Stdout: stdout.String(),
		Stderr: stderr.String(),
	}

	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
			return result, nil
		}
		return result, fmt.Errorf("podman exec failed: %w", err)
	}

	return result, nil
}

// ExecSimple runs a simple command inside a container and returns stdout.
func (c *Client) ExecSimple(ctx context.Context, container string, command ...string) (string, error) {
	result, err := c.ExecInContainer(ctx, ExecConfig{
		Container: container,
		Command:   command,
	})
	if err != nil {
		return "", err
	}
	if result.ExitCode != 0 {
		return "", fmt.Errorf("command %v failed (exit %d): %s",
			command, result.ExitCode, strings.TrimSpace(result.Stderr))
	}
	return result.Stdout, nil
}
