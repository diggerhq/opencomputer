package main

import (
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

func TestCallerFromCgroup(t *testing.T) {
	cases := map[string]string{
		"0::/user.slice/user-1500.slice/user@1500.service/app.slice/sp-runner-abc123.service\n": "abc123",
		// a child cgroup below the unit
		"0::/user.slice/user-1500.slice/user@1500.service/app.slice/sp-runner-abc123.service/tasks\n": "abc123",
		// the first matching element wins: a process can create a cgroup
		// below its own unit and name it like another, not one above it
		"0::/user.slice/user@1500.service/app.slice/sp-runner-outer.service/sp-runner-inner.service\n": "outer",
		// hybrid hierarchy: the v2 line wins over v1 lines
		"12:pids:/user.slice/sp-runner-v1.service\n0::/user.slice/user@1500.service/app.slice/sp-runner-v2.service\n": "v2",
		"12:pids:/user.slice/sp-runner-v1.service\n0::/user.slice\n":                                                  "v1",
		"0::/user.slice/user-1500.slice/session-3.scope\n":                                                            "",
		"0::/user.slice/user@1500.service/app.slice/sp-runner-.service\n":                                             "",
		"0::/user.slice/user@1500.service/app.slice/sp-runner-a b.service\n":                                          "",
		"0::/user.slice/user@1500.service/app.slice/sp-runner-x.scope\n":                                              "",
		"0::/user.slice/user@1500.service/app.slice/oc-sp-runner-x.service\n":                                         "",
		"garbage": "",
		"":        "",
	}
	for in, want := range cases {
		if got := callerFromCgroup(strings.NewReader(in)); got != want {
			t.Errorf("%q → %q, want %q", in, got, want)
		}
	}
}

func TestCallerOfPidFromProcRoot(t *testing.T) {
	root := t.TempDir()
	os.MkdirAll(filepath.Join(root, "4242"), 0o755)
	os.WriteFile(filepath.Join(root, "4242", "cgroup"), []byte("0::/user.slice/user-1500.slice/user@1500.service/app.slice/sp-runner-abc123.service\n"), 0o644)
	if u := callerOfPid(root, 4242); u != "abc123" {
		t.Fatalf("got %q", u)
	}
	if u := callerOfPid(root, 1); u != "" {
		t.Fatalf("missing pid: %q", u)
	}
}

// SO_PEERCRED on a real Unix socket names this process; the resolver then
// reads our cgroup from a fake proc root.
func TestPeerResolver(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("SO_PEERCRED is Linux-only")
	}
	dir, _ := os.MkdirTemp("", "mp")
	defer os.RemoveAll(dir)
	l, err := listenUnix(filepath.Join(dir, "a.sock"))
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	root := t.TempDir()
	pid := os.Getpid()
	os.MkdirAll(filepath.Join(root, strconv.Itoa(pid)), 0o755)
	os.WriteFile(filepath.Join(root, strconv.Itoa(pid), "cgroup"), []byte("0::/app.slice/sp-runner-me.service\n"), 0o644)
	go func() {
		c, err := net.Dial("unix", filepath.Join(dir, "a.sock"))
		if err == nil {
			defer c.Close()
			c.Read(make([]byte, 1))
		}
	}()
	c, err := l.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if u := peerResolver(root)(c); u != "me" {
		t.Fatalf("got %q", u)
	}
	if u := peerResolver(root)(&net.TCPConn{}); u != "" {
		t.Fatalf("non-unix conn: %q", u)
	}
}
