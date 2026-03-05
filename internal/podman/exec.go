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

// ExecStreamInContainer runs a command and streams stdout/stderr chunks via callback.
// Returns exit code when the command finishes.
func (c *Client) ExecStreamInContainer(ctx context.Context, cfg ExecConfig, onStdout, onStderr func([]byte) error) (int, error) {
	args := []string{"exec"}

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

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return -1, fmt.Errorf("stdout pipe: %w", err)
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return -1, fmt.Errorf("stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return -1, fmt.Errorf("start: %w", err)
	}

	errCh := make(chan error, 2)

	go func() {
		buf := make([]byte, 4096)
		for {
			n, readErr := stdoutPipe.Read(buf)
			if n > 0 {
				if sendErr := onStdout(buf[:n]); sendErr != nil {
					errCh <- sendErr
					return
				}
			}
			if readErr != nil {
				errCh <- nil
				return
			}
		}
	}()

	go func() {
		buf := make([]byte, 4096)
		for {
			n, readErr := stderrPipe.Read(buf)
			if n > 0 {
				if sendErr := onStderr(buf[:n]); sendErr != nil {
					errCh <- sendErr
					return
				}
			}
			if readErr != nil {
				errCh <- nil
				return
			}
		}
	}()

	// Wait for both pipes to close
	<-errCh
	<-errCh

	err = cmd.Wait()
	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else {
			return -1, fmt.Errorf("podman exec failed: %w", err)
		}
	}

	return exitCode, nil
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
