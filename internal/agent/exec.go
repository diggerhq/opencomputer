package agent

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"time"

	"github.com/creack/pty"
	pb "github.com/opensandbox/opensandbox/proto/agent"
)

// baseEnv returns the current OS environment with HOME set to /root.
// With overlayfs, the entire filesystem is backed by the data disk,
// so /root (the standard root home) has full disk space available.
func baseEnv() []string {
	var env []string
	for _, e := range os.Environ() {
		if strings.HasPrefix(e, "HOME=") {
			continue
		}
		env = append(env, e)
	}
	env = append(env, "HOME=/root")
	return env
}

// Exec runs a command synchronously and returns stdout/stderr/exit code.
func (s *Server) Exec(ctx context.Context, req *pb.ExecRequest) (*pb.ExecResponse, error) {
	timeout := time.Duration(req.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 60 * time.Second
	}

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, req.Command, req.Args...)

	// Set working directory
	if req.Cwd != "" {
		cmd.Dir = req.Cwd
	} else {
		cmd.Dir = "/root"
	}

	// Set environment variables with HOME=/root
	cmd.Env = baseEnv()
	if len(req.Envs) > 0 {
		cmd.Env = append(cmd.Env, mapToEnv(req.Envs)...)
	}

	// Set process group so we can kill the entire tree
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()

	exitCode := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = exitErr.ExitCode()
		} else if ctx.Err() == context.DeadlineExceeded {
			return &pb.ExecResponse{
				ExitCode: -1,
				Stdout:   stdout.String(),
				Stderr:   stderr.String() + "\nProcess timed out",
			}, nil
		} else {
			return nil, fmt.Errorf("exec failed: %w", err)
		}
	}

	return &pb.ExecResponse{
		ExitCode: int32(exitCode),
		Stdout:   stdout.String(),
		Stderr:   stderr.String(),
	}, nil
}

// ExecStream runs a command and streams stdout/stderr chunks.
func (s *Server) ExecStream(req *pb.ExecRequest, stream pb.SandboxAgent_ExecStreamServer) error {
	if req.Tty {
		return s.execStreamPTY(req, stream)
	}
	return s.execStreamPipes(req, stream)
}

// execStreamPTY runs a command inside a pseudo-terminal so programs see a TTY
// and produce real-time, unbuffered output (progress bars, colors, etc.).
// All output arrives on stdout since a PTY merges stdout+stderr.
func (s *Server) execStreamPTY(req *pb.ExecRequest, stream pb.SandboxAgent_ExecStreamServer) error {
	timeout := time.Duration(req.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 60 * time.Second
	}

	ctx, cancel := context.WithTimeout(stream.Context(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, req.Command, req.Args...)

	if req.Cwd != "" {
		cmd.Dir = req.Cwd
	} else {
		cmd.Dir = "/root"
	}

	cmd.Env = append(baseEnv(), "TERM=xterm-256color")
	if len(req.Envs) > 0 {
		cmd.Env = append(cmd.Env, mapToEnv(req.Envs)...)
	}

	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	ptmx, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: 120, Rows: 40})
	if err != nil {
		return fmt.Errorf("pty start: %w", err)
	}
	defer ptmx.Close()

	// Read from PTY and stream as stdout chunks
	errCh := make(chan error, 1)
	go func() {
		buf := make([]byte, 4096)
		for {
			n, readErr := ptmx.Read(buf)
			if n > 0 {
				if sendErr := stream.Send(&pb.ExecOutputChunk{
					Stream: pb.ExecOutputChunk_STDOUT,
					Data:   buf[:n],
				}); sendErr != nil {
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

	<-errCh

	exitCode := int32(0)
	if err := cmd.Wait(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = int32(exitErr.ExitCode())
		} else if ctx.Err() == context.DeadlineExceeded {
			exitCode = -1
		}
	}

	_ = stream.Send(&pb.ExecOutputChunk{
		Stream:   pb.ExecOutputChunk_EXIT,
		ExitCode: exitCode,
	})

	return nil
}

// execStreamPipes runs a command with separate stdout/stderr pipes (no TTY).
func (s *Server) execStreamPipes(req *pb.ExecRequest, stream pb.SandboxAgent_ExecStreamServer) error {
	timeout := time.Duration(req.TimeoutSeconds) * time.Second
	if timeout <= 0 {
		timeout = 60 * time.Second
	}

	ctx, cancel := context.WithTimeout(stream.Context(), timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, req.Command, req.Args...)

	if req.Cwd != "" {
		cmd.Dir = req.Cwd
	} else {
		cmd.Dir = "/root"
	}

	cmd.Env = baseEnv()
	if len(req.Envs) > 0 {
		cmd.Env = append(cmd.Env, mapToEnv(req.Envs)...)
	}

	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return fmt.Errorf("stdout pipe: %w", err)
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return fmt.Errorf("stderr pipe: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start: %w", err)
	}

	// Stream stdout and stderr in parallel
	errCh := make(chan error, 2)

	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := stdoutPipe.Read(buf)
			if n > 0 {
				if sendErr := stream.Send(&pb.ExecOutputChunk{
					Stream: pb.ExecOutputChunk_STDOUT,
					Data:   buf[:n],
				}); sendErr != nil {
					errCh <- sendErr
					return
				}
			}
			if err != nil {
				errCh <- nil
				return
			}
		}
	}()

	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := stderrPipe.Read(buf)
			if n > 0 {
				if sendErr := stream.Send(&pb.ExecOutputChunk{
					Stream: pb.ExecOutputChunk_STDERR,
					Data:   buf[:n],
				}); sendErr != nil {
					errCh <- sendErr
					return
				}
			}
			if err != nil {
				errCh <- nil
				return
			}
		}
	}()

	// Wait for both pipes to close
	<-errCh
	<-errCh

	// Wait for command to finish and capture exit code
	exitCode := int32(0)
	if err := cmd.Wait(); err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			exitCode = int32(exitErr.ExitCode())
		} else if ctx.Err() == context.DeadlineExceeded {
			exitCode = -1
		}
	}

	// Send final EXIT chunk with exit code
	_ = stream.Send(&pb.ExecOutputChunk{
		Stream:   pb.ExecOutputChunk_EXIT,
		ExitCode: exitCode,
	})

	return nil
}

// mapToEnv converts a map to KEY=VALUE slice.
func mapToEnv(m map[string]string) []string {
	env := make([]string, 0, len(m))
	for k, v := range m {
		env = append(env, k+"="+v)
	}
	return env
}
