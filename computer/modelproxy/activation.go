// systemd integration without libsystemd: socket activation (LISTEN_PID,
// LISTEN_FDS, LISTEN_FDNAMES; fds from 3) and sd_notify (one datagram to
// NOTIFY_SOCKET). Not activated (local runs, tests): the proxy creates the
// sockets itself.
package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"
)

const listenFdsStart = 3

// activatedListeners returns systemd-passed listeners by name; nil when the
// process was not socket-activated.
func activatedListeners() (map[string]net.Listener, error) {
	defer func() {
		os.Unsetenv("LISTEN_PID")
		os.Unsetenv("LISTEN_FDS")
		os.Unsetenv("LISTEN_FDNAMES")
	}()
	pid, err := strconv.Atoi(os.Getenv("LISTEN_PID"))
	if err != nil || pid != os.Getpid() {
		return nil, nil
	}
	n, err := strconv.Atoi(os.Getenv("LISTEN_FDS"))
	if err != nil || n <= 0 {
		return nil, nil
	}
	names := strings.Split(os.Getenv("LISTEN_FDNAMES"), ":")
	out := map[string]net.Listener{}
	for i := range n {
		fd := listenFdsStart + i
		name := ""
		if i < len(names) {
			name = names[i]
		}
		f := os.NewFile(uintptr(fd), name)
		l, err := net.FileListener(f) // dups the fd
		f.Close()
		if err != nil {
			return nil, fmt.Errorf("activated fd %d (%q): %w", fd, name, err)
		}
		out[name] = l
	}
	return out, nil
}

// listenUnix creates a Unix socket at path (replacing a stale one), mode 0660.
func listenUnix(path string) (net.Listener, error) {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	l, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err := os.Chmod(path, 0o660); err != nil {
		l.Close()
		return nil, err
	}
	return l, nil
}

// sdNotify sends state to the service manager; a no-op when not under systemd.
func sdNotify(state string) error {
	addr := os.Getenv("NOTIFY_SOCKET")
	if addr == "" {
		return nil
	}
	if addr[0] == '@' {
		addr = "\x00" + addr[1:]
	}
	c, err := net.DialUnix("unixgram", nil, &net.UnixAddr{Name: addr, Net: "unixgram"})
	if err != nil {
		return err
	}
	defer c.Close()
	_, err = c.Write([]byte(state))
	return err
}
