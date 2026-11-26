//go:build !linux

package main

import "net"

// peerCred is Linux-only (SO_PEERCRED); elsewhere no caller is a runner.
func peerCred(net.Conn) (pid, uid int, ok bool) { return 0, 0, false }
