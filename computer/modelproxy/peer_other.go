//go:build !linux

package main

import "net"

// peerPid is Linux-only (SO_PEERCRED); elsewhere no caller is a runner.
func peerPid(net.Conn) (int, bool) { return 0, false }
