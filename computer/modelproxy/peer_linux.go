//go:build linux

package main

import (
	"net"
	"syscall"
)

// peerPid returns the pid of the process on the other end of a Unix socket
// connection, from SO_PEERCRED (taken by the kernel at connect time).
func peerPid(c net.Conn) (int, bool) {
	uc, ok := c.(*net.UnixConn)
	if !ok {
		return 0, false
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return 0, false
	}
	var cred *syscall.Ucred
	var serr error
	if err := raw.Control(func(fd uintptr) {
		cred, serr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil || serr != nil || cred == nil {
		return 0, false
	}
	return int(cred.Pid), true
}
