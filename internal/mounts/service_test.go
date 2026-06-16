package mounts

import (
	"context"
	"strings"
	"testing"

	"github.com/opensandbox/opensandbox/internal/sandbox"
	"github.com/opensandbox/opensandbox/pkg/types"
)

// fakeManager implements just the two sandbox.Manager methods the mounts
// service uses (Exec, WriteFile). Embedding the interface means any other
// method would panic if called — a guard that the service only touches these.
type fakeManager struct {
	sandbox.Manager
	calls   []types.ProcessConfig
	execFn  func(cfg types.ProcessConfig) (*types.ProcessResult, error)
	written map[string]string
}

func (f *fakeManager) Exec(_ context.Context, _ string, cfg types.ProcessConfig) (*types.ProcessResult, error) {
	f.calls = append(f.calls, cfg)
	if f.execFn != nil {
		return f.execFn(cfg)
	}
	return &types.ProcessResult{ExitCode: 0}, nil
}

func (f *fakeManager) WriteFile(_ context.Context, _ string, path, content string) error {
	if f.written == nil {
		f.written = map[string]string{}
	}
	f.written[path] = content
	return nil
}

func argsContain(args []string, sub string) bool {
	for _, a := range args {
		if strings.Contains(a, sub) {
			return true
		}
	}
	return false
}

func TestAdd_CommandDriver_HappyPath_SecretsViaEnvNotArgv(t *testing.T) {
	fm := &fakeManager{}
	var launch types.ProcessConfig
	fm.execFn = func(cfg types.ProcessConfig) (*types.ProcessResult, error) {
		switch {
		case argsContain(cfg.Args, "mountpoint -q"):
			return &types.ProcessResult{ExitCode: 0, Stdout: "MOUNTED"}, nil
		case argsContain(cfg.Args, "nohup"):
			launch = cfg
			return &types.ProcessResult{ExitCode: 0, Stdout: "4242"}, nil
		default:
			return &types.ProcessResult{ExitCode: 0}, nil
		}
	}
	svc := NewService(fm)

	rec, err := svc.Add(context.Background(), "sb-1", AddRequest{
		Path:    "/mnt/data",
		Driver:  DriverCommand,
		Command: []string{"my-vfs-fuse", "--target", "{mountpoint}"},
		Env:     map[string]string{"REGION": "us-east-1"},
		Secrets: map[string]string{"TOKEN": "super-secret-value"},
	})
	if err != nil {
		t.Fatalf("Add: %v", err)
	}

	// Record reflects the command driver and omits secrets entirely.
	if rec.Driver != DriverCommand {
		t.Errorf("driver = %q, want %q", rec.Driver, DriverCommand)
	}
	if got := strings.Join(rec.Command, " "); got != "my-vfs-fuse --target /mnt/data" {
		t.Errorf("{mountpoint} not substituted in record: %q", got)
	}
	if _, ok := rec.Env["TOKEN"]; ok {
		t.Error("secret leaked into the mount record env")
	}
	if rec.Env["REGION"] != "us-east-1" {
		t.Errorf("non-secret env missing from record: %v", rec.Env)
	}

	// The secret must be injected via process env, never the command line.
	if launch.Env["TOKEN"] != "super-secret-value" {
		t.Errorf("secret not passed via process env: %v", launch.Env)
	}
	if argsContain(launch.Args, "super-secret-value") {
		t.Error("secret value leaked into the command line (visible via ps)")
	}
}

func TestAdd_CommandDriver_RequiresCommand(t *testing.T) {
	svc := NewService(&fakeManager{})
	if _, err := svc.Add(context.Background(), "sb-1", AddRequest{
		Path:   "/mnt/x",
		Driver: DriverCommand,
	}); err == nil {
		t.Fatal("expected error when command driver has no command")
	}
}

func TestAdd_RcloneDriver_RequiresRemote(t *testing.T) {
	svc := NewService(&fakeManager{})
	if _, err := svc.Add(context.Background(), "sb-1", AddRequest{Path: "/mnt/x"}); err == nil {
		t.Fatal("expected error when rclone driver has no remote")
	}
}

func TestAdd_UnsupportedDriver(t *testing.T) {
	svc := NewService(&fakeManager{})
	if _, err := svc.Add(context.Background(), "sb-1", AddRequest{
		Path:   "/mnt/x",
		Driver: "nfs",
	}); err == nil {
		t.Fatal("expected error for unsupported driver")
	}
}

func TestSubstituteMountpoint(t *testing.T) {
	got := substituteMountpoint([]string{"gcsfuse", "bkt", "{mountpoint}", "--path={path}"}, "/mnt/d")
	want := []string{"gcsfuse", "bkt", "/mnt/d", "--path=/mnt/d"}
	if strings.Join(got, " ") != strings.Join(want, " ") {
		t.Errorf("substituteMountpoint = %v, want %v", got, want)
	}
}

func TestShQuote(t *testing.T) {
	cases := map[string]string{
		"plain":      "'plain'",
		"a b":        "'a b'",
		"it's":       `'it'\''s'`,
		"$(rm -rf)":  "'$(rm -rf)'",
	}
	for in, want := range cases {
		if got := shQuote(in); got != want {
			t.Errorf("shQuote(%q) = %q, want %q", in, got, want)
		}
	}
}
