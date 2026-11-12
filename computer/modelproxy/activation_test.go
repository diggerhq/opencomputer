package main

import (
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// TestSocketActivation runs this test binary as a child with two listening
// sockets on fds 3 and 4, as systemd passes them, and checks both are found
// by name and accept connections.
func TestSocketActivation(t *testing.T) {
	if os.Getenv("MP_ACTIVATION_CHILD") == "1" {
		os.Setenv("LISTEN_PID", strconv.Itoa(os.Getpid())) // systemd sets it after fork
		ls, err := activatedListeners()
		if err != nil || ls["api"] == nil || ls["control"] == nil {
			t.Fatalf("listeners %v err %v", ls, err)
		}
		if os.Getenv("LISTEN_FDS") != "" {
			t.Fatal("LISTEN_FDS not unset for children")
		}
		for _, name := range []string{"api", "control"} {
			go func() {
				c, err := ls[name].Accept()
				if err == nil {
					c.Write([]byte(name))
					c.Close()
				}
			}()
		}
		for _, name := range []string{"api", "control"} {
			c, err := net.Dial("unix", os.Getenv("MP_DIR")+"/"+name+".sock")
			if err != nil {
				t.Fatal(err)
			}
			b := make([]byte, 16)
			n, _ := c.Read(b)
			if string(b[:n]) != name {
				t.Fatalf("%s socket answered %q", name, b[:n])
			}
			c.Close()
		}
		return
	}
	dir, _ := os.MkdirTemp("", "mp")
	defer os.RemoveAll(dir)
	var files []*os.File
	for _, name := range []string{"api", "control"} {
		l, err := listenUnix(filepath.Join(dir, name+".sock"))
		if err != nil {
			t.Fatal(err)
		}
		l.(*net.UnixListener).SetUnlinkOnClose(false)
		f, err := l.(*net.UnixListener).File()
		if err != nil {
			t.Fatal(err)
		}
		l.Close()
		files = append(files, f)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestSocketActivation$", "-test.count=1")
	cmd.ExtraFiles = files
	cmd.Env = append(os.Environ(), "MP_ACTIVATION_CHILD=1", "MP_DIR="+dir, "LISTEN_FDS=2", "LISTEN_FDNAMES=api:control")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("child: %v\n%s", err, out)
	}
}

func TestSdNotify(t *testing.T) {
	dir, _ := os.MkdirTemp("", "mp")
	defer os.RemoveAll(dir)
	path := filepath.Join(dir, "n.sock")
	c, err := net.ListenUnixgram("unixgram", &net.UnixAddr{Name: path, Net: "unixgram"})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	t.Setenv("NOTIFY_SOCKET", path)
	if err := sdNotify("READY=1"); err != nil {
		t.Fatal(err)
	}
	b := make([]byte, 64)
	c.SetReadDeadline(time.Now().Add(time.Second))
	n, _ := c.Read(b)
	if string(b[:n]) != "READY=1" {
		t.Fatalf("got %q", b[:n])
	}
	t.Setenv("NOTIFY_SOCKET", "")
	if err := sdNotify("READY=1"); err != nil {
		t.Fatal(err)
	}
}

func TestNotActivated(t *testing.T) {
	t.Setenv("LISTEN_PID", "1")
	t.Setenv("LISTEN_FDS", "2")
	ls, err := activatedListeners()
	if err != nil || ls != nil {
		t.Fatalf("another pid's fds taken: %v %v", ls, err)
	}
}
