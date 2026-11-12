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
	const user = "/user.slice/user-1500.slice/user@1500.service/slack.slice/slack-presence.slice/slack-presence-runners.slice"
	cases := map[string]string{
		"0::" + user + "/sp-runner-abc123.service\n": "abc123",
		// a session's container: its payload, and what it creates below
		"0::" + user + "/sp-runner-abc123.service/libpod-payload-0f3a\n":       "abc123",
		"0::" + user + "/sp-runner-abc123.service/libpod-payload-0f3a/tasks\n": "abc123",
		// a system unit, should sessions ever be started as such
		"0::/slack.slice/slack-presence-runners.slice/sp-runner-sys.service\n": "sys",
		// only the element right below the slice is read: a session can
		// create cgroups below its own unit and name them as it likes
		"0::" + user + "/sp-runner-outer.service/sp-runner-inner.service\n":                                              "outer",
		"0::" + user + "/sp-runner-outer.service/libpod-payload-0f3a/slack-presence-runners.slice/sp-runner-x.service\n": "outer",
		// a unit of that name anywhere else is not a runner
		"0::/user.slice/user-1500.slice/user@1500.service/app.slice/sp-runner-abc123.service\n":                                        "",
		"0::" + user + "/other.service/sp-runner-abc123.service\n":                                                                     "",
		"0::/user.slice/user-1500.slice/user@1500.service/app.slice/x.service/slack-presence-runners.slice/sp-runner-abc123.service\n": "",
		"0::/user.slice/user-1500.slice/session-3.scope/slack-presence-runners.slice/sp-runner-abc123.service\n":                       "",
		"0::/user.slice/user@1500.service.d/slack-presence-runners.slice/sp-runner-abc123.service\n":                                   "",
		// hybrid hierarchy: the v2 line wins over v1 lines
		"12:pids:" + user + "/sp-runner-v1.service\n0::" + user + "/sp-runner-v2.service\n": "v2",
		"12:pids:" + user + "/sp-runner-v1.service\n0::/user.slice\n":                       "v1",
		"0::/user.slice/user-1500.slice/session-3.scope\n":                                  "",
		"0::" + user + "\n":                        "",
		"0::" + user + "/\n":                       "",
		"0::" + user + "/sp-runner-.service\n":     "",
		"0::" + user + "/sp-runner-a b.service\n":  "",
		"0::" + user + "/sp-runner-x.scope\n":      "",
		"0::" + user + "/oc-sp-runner-x.service\n": "",
		"0::" + user + "x/sp-runner-abc.service\n": "",
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
	os.WriteFile(filepath.Join(root, "4242", "cgroup"), []byte("0::/user.slice/user-1500.slice/user@1500.service/slack-presence-runners.slice/sp-runner-abc123.service\n"), 0o644)
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
	os.WriteFile(filepath.Join(root, strconv.Itoa(pid), "cgroup"), []byte("0::/slack-presence-runners.slice/sp-runner-me.service\n"), 0o644)
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
	if u := peerResolver(root, anyUID)(c); u != "me" {
		t.Fatalf("got %q", u)
	}
	// -caller-uid: this process's own uid is a caller, any other is not,
	// whatever its cgroup says (a container's root is a subordinate uid).
	if u := peerResolver(root, os.Getuid())(c); u != "me" {
		t.Fatalf("own uid: got %q", u)
	}
	if u := peerResolver(root, os.Getuid()+1)(c); u != "" {
		t.Fatalf("another uid: got %q", u)
	}
	if u := peerResolver(root, anyUID)(&net.TCPConn{}); u != "" {
		t.Fatalf("non-unix conn: %q", u)
	}
}
